import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'protocol/color8.dart';
import 'protocol/control_barcode.dart';
import 'protocol/frame_codec.dart';
import 'protocol/frame_locator.dart';
import 'protocol/meta_barcode.dart';
import 'protocol/multicolor.dart';
import 'protocol/yuv_sampler.dart';

Map<String, Object?> barcodeToMessage(BarcodeData barcode) => <String, Object?>{
  'version': barcode.version,
  'encoding': barcode.encoding.index,
  'rate': barcode.rate,
  'zones': barcode.zones,
  'ringWidth': barcode.ringWidth,
  'gridWidth': barcode.gridWidth,
  'gridHeight': barcode.gridHeight,
  'lanes': barcode.lanes,
};

BarcodeData? barcodeFromMessage(Object? value) {
  if (value is! Map) return null;
  final encoding = value['encoding'];
  if (encoding is! int ||
      encoding < 0 ||
      encoding >= GridEncoding.values.length) {
    return null;
  }
  return BarcodeData(
    version: value['version'] as int? ?? barcodeVersion,
    encoding: GridEncoding.values[encoding],
    rate: (value['rate'] as num?)?.toDouble() ?? 0.625,
    zones: value['zones'] as bool? ?? false,
    ringWidth: value['ringWidth'] as int? ?? 0,
    gridWidth: value['gridWidth'] as int? ?? 0,
    gridHeight: value['gridHeight'] as int? ?? 0,
    lanes: value['lanes'] as int? ?? 1,
  );
}

/// Long-lived decoder isolate. Camera buffers are transferred into this isolate
/// and all locator, YUV, demodulation and LDPC work happens away from Flutter's
/// raster/UI isolate, keeping CameraPreview fluid while a matrix is visible.
void nativeDecodeWorkerEntry(Object bootstrap) {
  final legacy = bootstrap is SendPort;
  final parent = legacy
      ? bootstrap
      : (bootstrap as Map<Object?, Object?>)['parent'] as SendPort;
  final workerId = legacy
      ? 0
      : (bootstrap as Map<Object?, Object?>)['workerId'] as int;
  final inbox = ReceivePort();
  final trackedFrames = List<MatrixRect?>.filled(6, null);
  final trackedAges = List<int>.filled(6, 0);
  final spatialEqualizer = Color8SpatialEqualizer();
  var spatialBlur = 0.0;
  var spatialSamples = 0;
  var spatialKey = '';
  if (legacy) {
    parent.send(inbox.sendPort);
  } else {
    parent.send(<String, Object?>{
      'ready': true,
      'workerId': workerId,
      'port': inbox.sendPort,
    });
  }
  inbox.listen((message) {
    if (message is! Map) return;
    final watch = Stopwatch()..start();
    try {
      final y = (message['y'] as TransferableTypedData)
          .materialize()
          .asUint8List();
      final u = (message['u'] as TransferableTypedData)
          .materialize()
          .asUint8List();
      final v = (message['v'] as TransferableTypedData)
          .materialize()
          .asUint8List();
      final knownValues = message['barcodes'] as List? ?? const <Object?>[];
      final known = List<BarcodeData?>.generate(
        6,
        (index) => barcodeFromMessage(
          knownValues.length > index ? knownValues[index] : null,
        ),
      );
      final lastTicks = (message['lastTicks'] as List).cast<int>();
      final frame = Yuv420Frame(
        width: message['width'] as int,
        height: message['height'] as int,
        y: y,
        u: u,
        v: v,
        yRowStride: message['yRowStride'] as int,
        uRowStride: message['uRowStride'] as int,
        vRowStride: message['vRowStride'] as int,
        uPixelStride: message['uPixelStride'] as int,
        vPixelStride: message['vPixelStride'] as int,
      );
      final replies = <Map<String, Object?>>[];
      final advertisedLanes = known.whereType<BarcodeData>().fold<int>(
        1,
        (count, barcode) => math.max(count, barcode.lanes),
      );
      final outers = locateOuterFrames(
        frame.luma,
        maxCount: advertisedLanes.clamp(2, 6),
      );
      var locked = false;
      var freshBarcodes = 0;
      var fallbackBarcodes = 0;
      var timingRows = 0;
      var sampledFrames = 0;
      var decodedFrames = 0;
      var decodedManifest = 0;
      var decodedData = 0;
      var duplicateFrames = 0;
      var trackedReuse = 0;
      bool compatible(MatrixRect current, MatrixRect tracked) {
        final currentX = current.left + current.width / 2;
        final currentY = current.top + current.height / 2;
        final trackedX = tracked.left + tracked.width / 2;
        final trackedY = tracked.top + tracked.height / 2;
        final scale = math.min(current.width, current.height);
        final positionOk =
            math.sqrt(
              math.pow(currentX - trackedX, 2) +
                  math.pow(currentY - trackedY, 2),
            ) <
            scale * 0.06;
        final widthOk = (current.width - tracked.width).abs() < scale * 0.15;
        final heightOk = (current.height - tracked.height).abs() < scale * 0.15;
        return positionOk && widthOk && heightOk;
      }

      final indexedOuters = outers.indexed
          .map((entry) {
            final visualIndex = entry.$1;
            final outer = entry.$2;
            if (outer.refined) {
              trackedFrames[visualIndex] = outer;
              trackedAges[visualIndex] = 0;
              return entry;
            }
            final tracked = trackedFrames[visualIndex];
            if (tracked != null &&
                trackedAges[visualIndex] < 4 &&
                compatible(outer, tracked)) {
              trackedAges[visualIndex]++;
              trackedReuse++;
              return (visualIndex, tracked);
            }
            trackedFrames[visualIndex] = null;
            trackedAges[visualIndex] = 0;
            return entry;
          })
          .toList(growable: false);
      final preferredLane = message['preferredLane'] as int?;
      final laneOuters = preferredLane == null
          ? indexedOuters
          : indexedOuters
                .where((entry) => entry.$1 == preferredLane)
                .toList(growable: false);
      final refinedOuters = laneOuters
          .where((entry) => entry.$2.refined)
          .toList(growable: false);
      final decodeTargets = refinedOuters.isNotEmpty
          ? refinedOuters
          : laneOuters.take(1);
      for (final (visualIndex, outer) in decodeTargets) {
        final found = locateBarcode(frame.luma, outer);
        final barcode = found ?? known[visualIndex];
        if (barcode == null || barcode.gridWidth == 0) continue;
        if (found != null) {
          freshBarcodes++;
        } else {
          fallbackBarcodes++;
        }
        locked = true;
        final timing = locateTimingBarcode(frame.luma, outer, barcode);
        if (timing != null) timingRows++;
        final lane = timing?.lane ?? visualIndex.clamp(0, 5);
        final controlPage = barcode.version >= 3
            ? decodeControlBarcodeLuminance(
                sampleBarcodeLumaAtRow(
                  frame.luma,
                  outer,
                  barcode.gridWidth,
                  barcode.gridHeight,
                  controlBarcodeRow,
                ),
              )
            : null;
        if (timing != null &&
            lane < lastTicks.length &&
            lastTicks[lane] == timing.tick) {
          duplicateFrames++;
          replies.add(<String, Object?>{
            'lane': lane,
            'tick': timing.tick,
            'fps': timing.fps,
            'barcode': barcodeToMessage(barcode),
            if (controlPage != null)
              'controlPage': <String, int>{
                'page': controlPage.page,
                'tag': controlPage.tag,
                'payload': controlPage.payload,
              },
            'duplicate': true,
          });
          continue;
        }
        sampledFrames++;
        var sampled = sampleColor8(frame, outer, barcode);
        if (barcode.encoding == GridEncoding.color8) {
          final key = '${barcode.gridWidth}x${barcode.gridHeight}';
          if (key != spatialKey) {
            spatialKey = key;
            spatialBlur = 0;
            spatialSamples = 0;
          }
          final instant = estimateColor8SpatialBlur(sampled);
          final alpha = spatialSamples < 8 ? 0.30 : 0.075;
          spatialBlur = spatialSamples == 0
              ? instant
              : spatialBlur + (instant - spatialBlur) * alpha;
          spatialSamples++;
          sampled = spatialEqualizer.apply(sampled, spatialBlur);
        }
        final capacity = switch (barcode.encoding) {
          GridEncoding.bw => bwCapacityBytes(
            barcode.gridWidth,
            barcode.gridHeight,
          ),
          GridEncoding.color8 => color8CapacityBytes(
            barcode.gridWidth,
            barcode.gridHeight,
          ),
          _ => multiColorCapacityBytes(sampled, barcode.encoding),
        };
        final llr = switch (barcode.encoding) {
          GridEncoding.bw => softDemodulateBw(sampled),
          GridEncoding.color8 => softDemodulateColor8(sampled),
          _ => softDemodulateMultiColor(sampled, barcode.encoding),
        };
        final decoded = <DecodedFrame>[];
        if (barcode.version >= 3 && barcode.encoding == GridEncoding.color8) {
          final capacities = segmentedColor8Capacities(
            barcode.gridWidth,
            barcode.gridHeight,
          );
          final segments = splitSegmentedColor8Llr(
            llr,
            barcode.gridWidth,
            barcode.gridHeight,
          );
          for (var segment = 0; segment < segments.length; segment++) {
            final value = decodeFrameLlr(
              segments[segment],
              capacities[segment],
              barcode.rate,
              iterations: 12,
            );
            if (value != null) decoded.add(value);
          }
        } else {
          final value = decodeFrameLlr(
            llr,
            capacity,
            barcode.rate,
            iterations:
                barcode.encoding == GridEncoding.color8 &&
                    barcode.gridWidth <= 72
                ? 12
                : 16,
          );
          if (value != null) decoded.add(value);
        }
        decodedFrames += decoded.length;
        decodedManifest += decoded
            .where((value) => value.type == frameManifest)
            .length;
        decodedData += decoded.where((value) => value.type == frameData).length;
        final common = <String, Object?>{
          'lane': lane,
          if (timing != null) 'tick': timing.tick,
          if (timing != null) 'fps': timing.fps,
          'barcode': barcodeToMessage(barcode),
          'opticalComplete': barcode.version < 3 || decoded.length == 4,
          if (controlPage != null)
            'controlPage': <String, int>{
              'page': controlPage.page,
              'tag': controlPage.tag,
              'payload': controlPage.payload,
            },
        };
        if (decoded.isEmpty) {
          replies.add(common);
        } else {
          for (final value in decoded) {
            replies.add(<String, Object?>{
              ...common,
              'type': value.type,
              'seed': value.seed,
              'payload': TransferableTypedData.fromList(<Uint8List>[
                value.payload,
              ]),
            });
          }
        }
      }
      watch.stop();
      parent.send(<String, Object?>{
        'workerId': workerId,
        'id': message['id'],
        'ms': watch.elapsedMicroseconds / 1000,
        'locked': locked,
        'results': replies,
        'diagnostic': <String, Object?>{
          'image': '${frame.width}x${frame.height}',
          'strides':
              '${frame.yRowStride}/${frame.uRowStride}/${frame.vRowStride}',
          'outers': outers.length,
          'finderRefined': outers.where((outer) => outer.refined).length,
          'trackedReuse': trackedReuse,
          'preferredLane': preferredLane,
          'freshBarcodes': freshBarcodes,
          'fallbackBarcodes': fallbackBarcodes,
          'timingRows': timingRows,
          'sampled': sampledFrames,
          'decoded': decodedFrames,
          'manifest': decodedManifest,
          'data': decodedData,
          'duplicates': duplicateFrames,
          'uvOrder': 'YUV',
          'spatialBlur': spatialBlur,
        },
      });
    } catch (error) {
      watch.stop();
      parent.send(<String, Object?>{
        'workerId': workerId,
        'id': message['id'],
        'ms': watch.elapsedMicroseconds / 1000,
        'locked': false,
        'results': const <Object?>[],
        'error': error.toString(),
        'diagnostic': const <String, Object?>{'workerException': true},
      });
    }
  });
}
