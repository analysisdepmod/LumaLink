import 'dart:typed_data';

import 'ldpc.dart';

const int frameHeaderBytes = 9;
const int frameCrcBytes = 4;
const int frameManifest = 0;
const int frameData = 1;
const int frameSolo = 2;

class DecodedFrame {
  const DecodedFrame({required this.type, required this.seed, required this.payload});
  final int type;
  final int seed;
  final Uint8List payload;
}

const _mask32 = 0xffffffff;
int _u32(int value) => value & _mask32;
int _imul(int a, int b) => _u32(a * b);

class _Mulberry32 {
  _Mulberry32(this._state);
  int _state;
  double next() {
    _state = _u32(_state + 0x6d2b79f5);
    var value = _imul(_state ^ (_state >> 15), 1 | _state);
    value = _u32(value + _imul(value ^ (value >> 7), 61 | value)) ^ value;
    return _u32(value ^ (value >> 14)) / 4294967296.0;
  }
}

final List<int> _crcTable = List<int>.generate(256, (index) {
  var value = index;
  for (var bit = 0; bit < 8; bit++) {
    value = (value & 1) == 1 ? 0xedb88320 ^ (value >> 1) : value >> 1;
  }
  return _u32(value);
});

int crc32(Uint8List bytes, [int start = 0, int? end]) {
  var crc = _mask32;
  final stop = end ?? bytes.length;
  for (var i = start; i < stop; i++) {
    crc = _crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >> 8);
  }
  return _u32(crc ^ _mask32);
}

List<int> _permutation(int capacity) {
  final permutation = List<int>.generate(capacity, (i) => i);
  final random = _Mulberry32(_u32(capacity ^ 0x9e3779b9));
  for (var i = capacity - 1; i > 0; i--) {
    final j = (random.next() * (i + 1)).floor();
    final temp = permutation[i];
    permutation[i] = permutation[j];
    permutation[j] = temp;
  }
  return permutation;
}

Uint8List _whiteningMask(int bitCount) {
  final mask = Uint8List(bitCount);
  final random = _Mulberry32(_u32(bitCount ^ 0x5bd1e995));
  for (var i = 0; i < bitCount; i++) {
    // The web codec consumes a full Mulberry word then keeps its low bit.
    mask[i] = (random.next() * 4294967296).floor() & 1;
  }
  return mask;
}

Uint8List _bitsToBytes(Uint8List bits) {
  final bytes = Uint8List((bits.length + 7) ~/ 8);
  for (var i = 0; i < bits.length; i++) {
    if (bits[i] == 1) bytes[i ~/ 8] |= 1 << (7 - (i % 8));
  }
  return bytes;
}

Uint8List _bytesToBits(Uint8List bytes) {
  final bits = Uint8List(bytes.length * 8);
  for (var i = 0; i < bytes.length; i++) {
    for (var bit = 7; bit >= 0; bit--) {
      bits[i * 8 + 7 - bit] = (bytes[i] >> bit) & 1;
    }
  }
  return bits;
}

int messageBytesFor(int capacity, double rate) =>
    (capacity * rate).floor() < frameHeaderBytes + frameCrcBytes + 1
        ? frameHeaderBytes + frameCrcBytes + 1
        : (capacity * rate).floor();

DecodedFrame? _parseMessage(Uint8List message) {
  if (message.length < frameHeaderBytes + frameCrcBytes) return null;
  final crcOffset = message.length - frameCrcBytes;
  final view = ByteData.sublistView(message);
  if (view.getUint32(crcOffset, Endian.little) != crc32(message, 0, crcOffset)) return null;
  final length = view.getUint32(5, Endian.little);
  if (length > crcOffset - frameHeaderBytes) return null;
  return DecodedFrame(
    type: message[0],
    seed: view.getUint32(1, Endian.little),
    payload: Uint8List.fromList(message.sublist(frameHeaderBytes, frameHeaderBytes + length)),
  );
}

/// Decodes a soft-demodulated optical frame. Input LLR order is the transmitted
/// cell-bit order; positive values mean a camera reading favours zero.
DecodedFrame? decodeFrameLlr(Float64List transmittedLlr, int capacity, double rate, {int iterations = 24}) {
  if (capacity < 1 || transmittedLlr.length < capacity * 8) return null;
  final messageBytes = messageBytesFor(capacity, rate);
  final code = makeLdpcKm(messageBytes * 8, capacity * 8 - messageBytes * 8);
  final permutation = _permutation(capacity);
  final codewordLlr = Float64List(code.n);
  for (var byte = 0; byte < capacity; byte++) {
    final source = byte * 8;
    final destination = permutation[byte] * 8;
    for (var bit = 0; bit < 8; bit++) {
      codewordLlr[destination + bit] = transmittedLlr[source + bit];
    }
  }
  final mask = _whiteningMask(code.n);
  for (var bit = 0; bit < code.n; bit++) {
    if (mask[bit] == 1) codewordLlr[bit] = -codewordLlr[bit];
  }
  final hard = Uint8List(code.k);
  for (var bit = 0; bit < code.k; bit++) {
    hard[bit] = codewordLlr[bit] < 0 ? 1 : 0;
  }
  final fast = _parseMessage(_bitsToBytes(hard));
  if (fast != null) return fast;
  final corrected = decode(code, codewordLlr, iterations: iterations);
  return _parseMessage(_bitsToBytes(corrected));
}

/// Used by protocol tests and native loopback diagnostics. The result is byte-
/// interleaved exactly as the browser sender transmits it.
Uint8List encodeFrame(DecodedFrame frame, int capacity, double rate) {
  final messageBytes = messageBytesFor(capacity, rate);
  final crcOffset = messageBytes - frameCrcBytes;
  if (frame.payload.length > crcOffset - frameHeaderBytes) {
    throw ArgumentError('Payload does not fit this frame capacity');
  }
  final message = Uint8List(messageBytes);
  final view = ByteData.sublistView(message);
  message[0] = frame.type;
  view.setUint32(1, frame.seed, Endian.little);
  view.setUint32(5, frame.payload.length, Endian.little);
  message.setRange(frameHeaderBytes, frameHeaderBytes + frame.payload.length, frame.payload);
  view.setUint32(crcOffset, crc32(message, 0, crcOffset), Endian.little);
  final code = makeLdpcKm(messageBytes * 8, capacity * 8 - messageBytes * 8);
  final messageBits = _bytesToBits(message);
  final parity = encodeParity(code, messageBits);
  final codeword = Uint8List(code.n);
  codeword.setRange(0, code.k, messageBits);
  codeword.setRange(code.k, code.n, parity);
  final mask = _whiteningMask(code.n);
  for (var bit = 0; bit < code.n; bit++) {
    codeword[bit] ^= mask[bit];
  }
  final bytes = _bitsToBytes(codeword);
  final permutation = _permutation(capacity);
  final interleaved = Uint8List(capacity);
  for (var i = 0; i < capacity; i++) {
    interleaved[i] = bytes[permutation[i]];
  }
  return interleaved;
}
