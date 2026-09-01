import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/control_barcode.dart';

void main() {
  test('reassembles the web v11 descriptor from shuffled optical pages', () {
    const expected = TransferControl(
      id: 0xf1234567,
      k: 987654,
      chunk: 65000,
      compressedBytes: 987654321,
    );
    final assembler = TransferControlAssembler();
    TransferControl? decoded;
    for (final page in <int>[6, 1, 9, 0, 4, 8, 3, 7, 2, 5]) {
      final value = decodeControlBarcodeLuminance(
        encodeControlBarcodeLuminance(expected, page, 72),
      );
      expect(value, isNotNull);
      decoded = assembler.add(value!) ?? decoded;
    }
    expect(decoded?.id, expected.id);
    expect(decoded?.k, expected.k);
    expect(decoded?.chunk, expected.chunk);
    expect(decoded?.compressedBytes, expected.compressedBytes);
  });
}
