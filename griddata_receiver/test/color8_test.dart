import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/color8.dart';
import 'package:griddata_receiver/protocol/frame_codec.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
  test('v11 splits a 72x72 Color8 matrix into four LDPC quadrants', () {
    const width = 72, height = 72;
    final capacity = color8CapacityBytes(width, height);
    final llr = Float64List.fromList(
      List<double>.generate(capacity * 8, (index) => index.toDouble()),
    );
    final capacities = segmentedColor8Capacities(width, height);
    final segments = splitSegmentedColor8Llr(llr, width, height);
    expect(capacities, <int>[472, 472, 459, 459]);
    expect(
      segments.map((value) => value.length).toList(),
      capacities.map((value) => value * 8).toList(),
    );
    expect(segments[0].first, 0);
    expect(segments[1].first, 36 * 3);
    expect(segments[2].first, 35 * width * 3);
    expect(segments[3].first, 35 * width * 3 + 36 * 3);
  });

  test('v11 quadrant mapper round-trips four independent LDPC frames', () {
    const width = 72, height = 72, rate = 0.625;
    final capacities = segmentedColor8Capacities(width, height);
    final sent = List<DecodedFrame>.generate(
      4,
      (segment) => DecodedFrame(
        type: frameData,
        seed: 0x80000000 | (segment + 1),
        payload: Uint8List.fromList(<int>[segment, 7, 19, 31]),
      ),
    );
    final packed = List<Uint8List>.generate(
      4,
      (segment) => encodeFrame(sent[segment], capacities[segment], rate),
    );
    final grid = encodeSegmentedColor8Cells(packed, width, height);
    final segments = splitSegmentedColor8Llr(
      softDemodulateColor8(grid),
      width,
      height,
    );
    for (var segment = 0; segment < 4; segment++) {
      final decoded = decodeFrameLlr(
        segments[segment],
        capacities[segment],
        rate,
      );
      expect(decoded?.seed, sent[segment].seed);
      expect(decoded?.payload, sent[segment].payload);
    }
  });

  test('native Color8 cells feed directly into the LDPC frame decoder', () {
    const width = 64;
    const height = 64;
    final payload = Uint8List.fromList(List<int>.generate(128, (i) => i));
    final sent = DecodedFrame(type: frameData, seed: 99, payload: payload);
    final packed = encodeFrame(sent, color8CapacityBytes(width, height), 0.6);
    final grid = encodeColor8Cells(packed, width, height);

    final decoded = decodeFrameLlr(
      softDemodulateColor8(grid),
      packed.length,
      0.6,
    );

    expect(decoded, isNotNull);
    expect(decoded!.type, frameData);
    expect(decoded.seed, 99);
    expect(decoded.payload, payload);
  });

  test(
    'adaptive Color8 thresholds survive photographed black and white levels',
    () {
      const width = 72, height = 72;
      final payload = Uint8List.fromList(
        List<int>.generate(256, (i) => i & 255),
      );
      final sent = DecodedFrame(type: frameData, seed: 321, payload: payload);
      final packed = encodeFrame(
        sent,
        color8CapacityBytes(width, height),
        0.625,
      );
      final grid = encodeColor8Cells(packed, width, height);
      final from = width * barcodeRows;
      for (var i = from; i < width * height; i++) {
        grid.red[i] = grid.red[i] > 127 ? 188 : 36;
        grid.green[i] = grid.green[i] > 127 ? 204 : 51;
        grid.blue[i] = grid.blue[i] > 127 ? 172 : 28;
      }
      final decoded = decodeFrameLlr(
        softDemodulateColor8(grid),
        packed.length,
        0.625,
      );
      expect(decoded?.seed, 321);
      expect(decoded?.payload, payload);
    },
  );
}
