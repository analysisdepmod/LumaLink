import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/transfer_manifest.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
  test('reassembles and validates a compressed manifest', () {
    final json = utf8.encode(
      jsonEncode({
        'v': 2,
        'id': 12,
        'kind': 'file',
        'name': 'sample.bin',
        'mime': 'application/octet-stream',
        'total': 17,
        'comp': 17,
        'compressed': false,
        'k': 2,
        'chunk': 9,
        'enc': 'color8',
        'gridW': 64,
        'gridH': 64,
        'rate': 0.6,
        'fps': 6.5,
      }),
    );
    final packed = Uint8List.fromList(ZLibEncoder().encode(json));
    final split = packed.length ~/ 2;
    final assembler = ManifestAssembler();

    expect(
      assembler.add(Uint8List.fromList([0, 2, ...packed.sublist(0, split)])),
      isNull,
    );
    final manifest = assembler.add(
      Uint8List.fromList([1, 2, ...packed.sublist(split)]),
    );

    expect(manifest, isNotNull);
    expect(manifest!.encoding, 'color8');
    expect(manifest.senderFps, 6.5);
  });

  test('decodes compact protocol v10 manifest using barcode geometry', () {
    final name = utf8.encode('sample.pdf');
    final mime = utf8.encode('application/pdf');
    final wire = Uint8List(61 + name.length + mime.length);
    final view = ByteData.sublistView(wire);
    wire.setAll(0, [0x47, 0x44, 0x02, 10]);
    var offset = 4;
    view.setUint32(offset, 123, Endian.little);
    offset += 4;
    wire[offset++] = 3;
    view.setUint16(offset, 120, Endian.little);
    offset += 2;
    view.setUint32(offset, 416638, Endian.little);
    offset += 4;
    view.setUint32(offset, 415620, Endian.little);
    offset += 4;
    view.setUint32(offset, 362, Endian.little);
    offset += 4;
    view.setUint16(offset, 1151, Endian.little);
    offset += 2;
    for (var i = 0; i < 32; i++) {
      wire[offset++] = i;
    }
    view.setUint16(offset, name.length, Endian.little);
    offset += 2;
    view.setUint16(offset, mime.length, Endian.little);
    offset += 2;
    wire.setAll(offset, name);
    offset += name.length;
    wire.setAll(offset, mime);
    final manifest = ManifestAssembler().add(
      Uint8List.fromList([0, 1, ...wire]),
      optical: const BarcodeData(
        encoding: GridEncoding.color8,
        rate: 0.625,
        zones: false,
        gridWidth: 72,
        gridHeight: 72,
        lanes: 2,
      ),
    );
    expect(manifest?.version, 10);
    expect(manifest?.chunkSize, 1151);
    expect(manifest?.gridWidth, 72);
    expect(manifest?.senderFps, 12);

    wire[3] = 11;
    view.setUint16(23, 273, Endian.little);
    final v11 = ManifestAssembler().add(
      Uint8List.fromList([0, 1, ...wire]),
      optical: const BarcodeData(
        version: 3,
        encoding: GridEncoding.color8,
        rate: 0.625,
        zones: false,
        gridWidth: 72,
        gridHeight: 72,
        lanes: 6,
      ),
    );
    expect(v11?.version, 11);
    expect(v11?.chunkSize, 273);
  });
}
