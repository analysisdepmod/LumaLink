import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/fountain_decoder.dart';

void main() {
  test('systematic GridData seeds reconstruct every source block', () {
    const k = 12;
    const chunkSize = 5;
    final sources = List<Uint8List>.generate(k, (i) => Uint8List.fromList(List<int>.generate(chunkSize, (j) => i * 10 + j)));
    final decoder = FountainDecoder(k, chunkSize);
    for (var seed = 1; seed <= k; seed++) {
      decoder.addFrame(seed, sources[seed - 1]);
    }

    expect(decoder.isComplete, isTrue);
    expect(decoder.reconstruct(), Uint8List.fromList(sources.expand((source) => source).toList()));
  });
}
