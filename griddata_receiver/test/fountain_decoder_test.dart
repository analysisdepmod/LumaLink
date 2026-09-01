import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/fountain_decoder.dart';

void main() {
  test('systematic GridData seeds reconstruct every source block', () {
    const k = 12;
    const chunkSize = 5;
    final sources = List<Uint8List>.generate(
      k,
      (i) =>
          Uint8List.fromList(List<int>.generate(chunkSize, (j) => i * 10 + j)),
    );
    final decoder = FountainDecoder(k, chunkSize);
    for (var seed = 1; seed <= k; seed++) {
      decoder.addFrame(seed, sources[seed - 1]);
    }

    expect(decoder.isComplete, isTrue);
    expect(
      decoder.reconstruct(),
      Uint8List.fromList(sources.expand((source) => source).toList()),
    );
  });

  test('v9 maps every second repair to a 32-source equation', () {
    expect(sourceIndices(101, 100).length, isNot(32));
    expect(sourceIndices(102, 100).length, 32);
  });

  test('v11 triangular seeds reconstruct the first K equations exactly', () {
    const k = 257;
    const chunkSize = 37;
    final sources = List<Uint8List>.generate(
      k,
      (source) => Uint8List.fromList(
        List<int>.generate(
          chunkSize,
          (byte) => (source * 31 + byte * 17) & 0xff,
        ),
      ),
    );
    final decoder = FountainDecoder(k, chunkSize);
    for (var index = 0; index < k; index++) {
      final seed = 0x80000000 | (index + 1);
      final payload = Uint8List(chunkSize);
      for (final source in sourceIndices(seed, k)) {
        for (var byte = 0; byte < chunkSize; byte++) {
          payload[byte] ^= sources[source][byte];
        }
      }
      decoder.addFrame(seed, payload);
    }
    expect(decoder.isComplete, isTrue);
    expect(
      decoder.reconstruct(),
      Uint8List.fromList(sources.expand((source) => source).toList()),
    );
  });
}
