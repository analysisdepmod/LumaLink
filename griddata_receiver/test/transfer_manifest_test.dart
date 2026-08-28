import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/transfer_manifest.dart';

void main() {
  test('reassembles and validates a compressed manifest', () {
    final json = utf8.encode(jsonEncode({
      'v': 2, 'id': 12, 'kind': 'file', 'name': 'sample.bin', 'mime': 'application/octet-stream',
      'total': 17, 'comp': 17, 'compressed': false, 'k': 2, 'chunk': 9,
      'enc': 'color8', 'gridW': 64, 'gridH': 64, 'rate': 0.6, 'fps': 6.5,
    }));
    final packed = Uint8List.fromList(ZLibEncoder().encode(json));
    final split = packed.length ~/ 2;
    final assembler = ManifestAssembler();

    expect(assembler.add(Uint8List.fromList([0, 2, ...packed.sublist(0, split)])), isNull);
    final manifest = assembler.add(Uint8List.fromList([1, 2, ...packed.sublist(split)]));

    expect(manifest, isNotNull);
    expect(manifest!.encoding, 'color8');
    expect(manifest.senderFps, 6.5);
  });
}
