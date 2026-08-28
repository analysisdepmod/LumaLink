import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/ldpc.dart';

void main() {
  test('corrects a handful of hard optical bit errors', () {
    final code = makeLdpcKm(96, 64);
    final message = Uint8List.fromList(List<int>.generate(96, (i) => (i * 13 + 7) & 1));
    final parity = encodeParity(code, message);
    final llr = Float64List(code.n);
    for (var i = 0; i < code.k; i++) {
      llr[i] = message[i] == 0 ? 8 : -8;
    }
    for (var i = 0; i < code.m; i++) {
      llr[code.k + i] = parity[i] == 0 ? 8 : -8;
    }
    for (final i in [2, 17, 45, 102]) {
      llr[i] = -llr[i];
    }

    expect(decode(code, llr, iterations: 32), message);
  });
}
