import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/color8.dart';
import 'package:griddata_receiver/protocol/frame_codec.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
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
