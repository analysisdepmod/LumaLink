import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

import 'meta_barcode.dart';

class TransferManifest {
  const TransferManifest({
    required this.version,
    required this.id,
    required this.kind,
    required this.name,
    required this.mime,
    required this.total,
    required this.compressedBytes,
    required this.compressed,
    required this.sha256,
    required this.k,
    required this.chunkSize,
    required this.encoding,
    required this.gridWidth,
    required this.gridHeight,
    required this.rate,
    this.senderFps,
  });

  final int version;
  final int id;
  final String kind;
  final String name;
  final String mime;
  final int total;
  final int compressedBytes;
  final bool compressed;
  final String? sha256;
  final int k;
  final int chunkSize;
  final String encoding;
  final int gridWidth;
  final int gridHeight;
  final double rate;
  final double? senderFps;

  static TransferManifest? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    int? integer(String key, int min, int max) {
      final candidate = value[key];
      if (candidate is! num || candidate != candidate.round()) return null;
      final number = candidate.toInt();
      return number >= min && number <= max ? number : null;
    }

    final version = integer('v', 1, 9);
    final id = integer('id', 0, 0xffffffff);
    final total = integer('total', 0, 1073741824);
    final compressedBytes = integer('comp', 0, 1073741824);
    final k = integer('k', 1, 1000000);
    final chunk = integer('chunk', 1, 1048576);
    final gridWidth = integer('gridW', 40, 256);
    final gridHeight = integer('gridH', 8, 504);
    final kind = value['kind'];
    final name = value['name'];
    final mime = value['mime'];
    final encoding = value['enc'];
    final rate = value['rate'];
    const encodings = {'bw', 'color8', 'color16', 'color32', 'color64'};
    if (version == null ||
        id == null ||
        total == null ||
        compressedBytes == null ||
        k == null ||
        chunk == null ||
        gridWidth == null ||
        gridHeight == null ||
        kind is! String ||
        (kind != 'file' && kind != 'text') ||
        name is! String ||
        name.length > 512 ||
        mime is! String ||
        mime.length > 256 ||
        encoding is! String ||
        !encodings.contains(encoding) ||
        rate is! num ||
        rate < 0.4 ||
        rate > 0.95 ||
        gridWidth % 8 != 0 ||
        gridHeight % 8 != 0) {
      return null;
    }
    final hash = value['sha256'];
    if (hash != null && (hash is! String || hash.length != 64)) return null;
    final fps = value['fps'];
    return TransferManifest(
      version: version,
      id: id,
      kind: kind,
      name: name,
      mime: mime,
      total: total,
      compressedBytes: compressedBytes,
      compressed: value['compressed'] is bool
          ? value['compressed'] as bool
          : true,
      sha256: hash as String?,
      k: k,
      chunkSize: chunk,
      encoding: encoding,
      gridWidth: gridWidth,
      gridHeight: gridHeight,
      rate: rate.toDouble(),
      senderFps: fps is num && fps > 0 ? fps.toDouble() : null,
    );
  }
}

/// Reassembles one or more compressed manifest frames. It bounds every field
/// before allocating, so a false camera decode cannot exhaust Android memory.
class ManifestAssembler {
  final Map<int, Uint8List> _parts = <int, Uint8List>{};
  var _count = 0;

  TransferManifest? add(Uint8List payload, {BarcodeData? optical}) {
    if (payload.length < 2) return null;
    final index = payload[0];
    final count = payload[1];
    if (count < 1 || count > 128 || index >= count) return null;
    if (count != _count) {
      _parts.clear();
      _count = count;
    }
    _parts[index] = Uint8List.fromList(payload.sublist(2));
    if (_parts.length != _count) return null;
    final bytes = BytesBuilder(copy: false);
    for (var i = 0; i < _count; i++) {
      final part = _parts[i];
      if (part == null) return null;
      bytes.add(part);
    }
    try {
      final body = bytes.takeBytes();
      final wire = _decodeCompactManifest(body, optical);
      if (wire != null) return wire;
      final jsonBytes = Uint8List.fromList(ZLibDecoder().decodeBytes(body));
      return TransferManifest.fromJson(jsonDecode(utf8.decode(jsonBytes)));
    } catch (_) {
      return null;
    }
  }
}

int _u16(Uint8List bytes, int offset) =>
    bytes[offset] | (bytes[offset + 1] << 8);
int _u32(Uint8List bytes, int offset) =>
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);

String _hex(Uint8List bytes) =>
    bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();

TransferManifest? _decodeCompactManifest(Uint8List body, BarcodeData? optical) {
  if (body.length < 61 ||
      optical == null ||
      body[0] != 0x47 ||
      body[1] != 0x44 ||
      body[2] != 0x02)
    return null;
  var offset = 3;
  final version = body[offset++];
  if (version < 6 || version > 9) return null;
  final id = _u32(body, offset);
  offset += 4;
  final flags = body[offset++];
  final fps10 = _u16(body, offset);
  offset += 2;
  final total = _u32(body, offset);
  offset += 4;
  final compressedBytes = _u32(body, offset);
  offset += 4;
  final k = _u32(body, offset);
  offset += 4;
  final chunk = _u16(body, offset);
  offset += 2;
  final hash = _hex(Uint8List.sublistView(body, offset, offset + 32));
  offset += 32;
  final nameLength = _u16(body, offset);
  offset += 2;
  final mimeLength = _u16(body, offset);
  offset += 2;
  if (total > 1073741824 ||
      compressedBytes > 1073741824 ||
      k < 1 ||
      k > 1000000 ||
      chunk < 1 ||
      offset + nameLength + mimeLength != body.length)
    return null;
  final name = utf8.decode(body.sublist(offset, offset + nameLength));
  offset += nameLength;
  final mime = utf8.decode(body.sublist(offset, offset + mimeLength));
  return TransferManifest(
    version: version,
    id: id,
    kind: flags & 1 != 0 ? 'file' : 'text',
    name: name,
    mime: mime,
    total: total,
    compressedBytes: compressedBytes,
    compressed: flags & 2 != 0,
    sha256: hash,
    k: k,
    chunkSize: chunk,
    encoding: optical.encoding.name,
    gridWidth: optical.gridWidth,
    gridHeight: optical.gridHeight,
    rate: optical.rate,
    senderFps: fps10 == 0 ? null : fps10 / 10,
  );
}

Future<Uint8List> finishTransfer(
  Uint8List chunks,
  TransferManifest manifest,
) async {
  if (chunks.length < manifest.compressedBytes)
    throw StateError('Reconstruction is shorter than manifest');
  final packed = Uint8List.fromList(
    chunks.sublist(0, manifest.compressedBytes),
  );
  final bytes = manifest.compressed
      ? Uint8List.fromList(ZLibDecoder().decodeBytes(packed))
      : packed;
  if (bytes.length != manifest.total)
    throw StateError('Completed file length does not match manifest');
  if (manifest.sha256 != null &&
      sha256.convert(bytes).toString() != manifest.sha256) {
    throw StateError('SHA-256 verification failed');
  }
  return bytes;
}

Future<File> saveTransfer(Uint8List bytes, TransferManifest manifest) async {
  final directory = await getApplicationDocumentsDirectory();
  final supplied = manifest.name.trim().isEmpty
      ? 'griddata-${manifest.id}.bin'
      : manifest.name;
  final safe = supplied.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
  final file = File('${directory.path}${Platform.pathSeparator}$safe');
  await file.writeAsBytes(bytes, flush: true);
  return file;
}
