import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/frame_codec.dart';

void main() {
  test('matches the web sender golden frame byte-for-byte', () {
    final packed = encodeFrame(
      DecodedFrame(
        type: frameData,
        seed: 0x12345678,
        payload: Uint8List.fromList([7, 1, 9, 2, 8]),
      ),
      128,
      0.6,
    );
    const expected =
        '091f8d83f840286f754f7310725c59b966820e40b129474c24678a60e3e53238a4b8c6b67e467eb3868fefdca3d2ad757bd533879c3b50f76cd304401a36c5823678d04da800902377e08aacb4c4b995ec489021e3826ca300f4bb340e1d8ac216d139acd33f3c019c8162c6c683384c4f62f251e5dbcfac09300e19b74ab907';
    final actual = packed
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();

    expect(actual, expected);
  });

  test('decodes the interleaved, whitened LDPC frame contract', () {
    final sent = DecodedFrame(
      type: frameData,
      seed: 0x12345678,
      payload: Uint8List.fromList([7, 1, 9, 2, 8]),
    );
    const capacity = 128;
    final packed = encodeFrame(sent, capacity, 0.6);
    final llr = Float64List(capacity * 8);
    for (var i = 0; i < packed.length; i++) {
      for (var bit = 7; bit >= 0; bit--) {
        llr[i * 8 + 7 - bit] = ((packed[i] >> bit) & 1) == 0 ? 9 : -9;
      }
    }
    // A few noisy optical cells should still be corrected by LDPC.
    for (final bit in [18, 57, 93, 201]) {
      llr[bit] = -llr[bit];
    }

    final received = decodeFrameLlr(llr, capacity, 0.6, iterations: 32);

    expect(received, isNotNull);
    expect(received!.type, sent.type);
    expect(received.seed, sent.seed);
    expect(received.payload, sent.payload);
  });
}
