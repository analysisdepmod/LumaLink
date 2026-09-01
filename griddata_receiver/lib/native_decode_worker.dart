import 'dart:isolate';
import 'dart:typed_data';

import 'protocol/color8.dart';
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
      encoding >= GridEncoding.values.length)
    return null;
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
void nativeDecodeWorkerEntry(SendPort parent) {
  final inbox = ReceivePort();
  parent.send(inbox.sendPort);
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
      final known = <BarcodeData?>[
        barcodeFromMessage(knownValues.isNotEmpty ? knownValues[0] : null),
        barcodeFromMessage(knownValues.length > 1 ? knownValues[1] : null),
      ];
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
      final outers = locateOuterFrames(frame.luma, maxCount: 2);
      var locked = false;
      var freshBarcodes = 0;
      var fallbackBarcodes = 0;
      var timingRows = 0;
      var sampledFrames = 0;
      var decodedFrames = 0;
      var decodedManifest = 0;
      var decodedData = 0;
      var duplicateFrames = 0;
      final indexedOuters = outers.indexed.toList(growable: false);
      final refinedOuters = indexedOuters
          .where((entry) => entry.$2.refined)
          .toList(growable: false);
      final decodeTargets = refinedOuters.isNotEmpty
          ? refinedOuters
          : indexedOuters.take(1);
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
        final lane = timing?.lane ?? visualIndex.clamp(0, 1);
        if (timing != null && lastTicks[lane] == timing.tick) {
          duplicateFrames++;
          replies.add(<String, Object?>{
            'lane': lane,
            'tick': timing.tick,
            'fps': timing.fps,
            'barcode': barcodeToMessage(barcode),
            'duplicate': true,
          });
          continue;
        }
        sampledFrames++;
        final sampled = sampleColor8(frame, outer, barcode);
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
        final decoded = decodeFrameLlr(
          llr,
          capacity,
          barcode.rate,
          iterations:
              barcode.encoding == GridEncoding.color8 && barcode.gridWidth <= 72
              ? 12
              : 16,
        );
        if (decoded != null) {
          decodedFrames++;
          if (decoded.type == frameManifest) decodedManifest++;
          if (decoded.type == frameData) decodedData++;
        }
        replies.add(<String, Object?>{
          'lane': lane,
          if (timing != null) 'tick': timing.tick,
          if (timing != null) 'fps': timing.fps,
          'barcode': barcodeToMessage(barcode),
          if (decoded != null) 'type': decoded.type,
          if (decoded != null) 'seed': decoded.seed,
          if (decoded != null)
            'payload': TransferableTypedData.fromList(<Uint8List>[
              decoded.payload,
            ]),
        });
      }
      watch.stop();
      parent.send(<String, Object?>{
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
          'freshBarcodes': freshBarcodes,
          'fallbackBarcodes': fallbackBarcodes,
          'timingRows': timingRows,
          'sampled': sampledFrames,
          'decoded': decodedFrames,
          'manifest': decodedManifest,
          'data': decodedData,
          'duplicates': duplicateFrames,
          'uvOrder': 'YUV',
        },
      });
    } catch (error) {
      watch.stop();
      parent.send(<String, Object?>{
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
