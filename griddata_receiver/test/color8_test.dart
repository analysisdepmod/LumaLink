import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/color8.dart';
import 'package:griddata_receiver/protocol/frame_codec.dart';

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
}
