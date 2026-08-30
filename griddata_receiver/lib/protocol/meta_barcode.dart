import 'dart:typed_data';

/// The fixed monochrome metadata strip embedded at the top of every GridData
/// frame. This is deliberately independent of Flutter/UI code so the native
/// camera pipeline can reject a wrong grid before attempting an LDPC decode.
const int barcodeVersion = 2;
const int barcodeRows = 3;
const int barcodeBarCells = 2;
const int barcodePatternLength = 32;
const int minBarcodeWidth = barcodePatternLength * barcodeBarCells;

const List<int> _sync = [1, 1, 0, 1];
const List<double> _rates = [0.5, 0.6, 0.65, 0.675, 0.7, 0.75, 0.9, 0.625];

enum GridEncoding { color64, color32, color16, color8, bw }

class BarcodeData {
  const BarcodeData({
    required this.encoding,
    required this.rate,
    required this.zones,
    required this.gridWidth,
    required this.gridHeight,
    this.ringWidth = 0,
    this.lanes = 1,
    this.version = barcodeVersion,
  });

  final int version;
  final GridEncoding encoding;
  final double rate;
  final bool zones;
  final int ringWidth;
  final int lanes;
  final int gridWidth;
  final int gridHeight;
}

int _crc7(List<int> bits) {
  var crc = 0;
  for (final bit in bits) {
    final feedback = ((crc >> 6) & 1) ^ (bit & 1);
    crc = (crc << 1) & 0x7f;
    if (feedback != 0) crc ^= 0x09;
  }
  return crc;
}

List<int> _intToBits(int value, int count) =>
    List<int>.generate(count, (i) => (value >> (count - i - 1)) & 1);

int _bitsToInt(List<int> bits, int offset, int count) {
  var value = 0;
  for (var i = 0; i < count; i++) {
    value = (value << 1) | (bits[offset + i] & 1);
  }
  return value;
}

int _nearestRateIndex(double rate) {
  var best = 0;
  var delta = (rate - _rates.first).abs();
  for (var i = 1; i < _rates.length; i++) {
    final candidate = (rate - _rates[i]).abs();
    if (candidate < delta) {
      best = i;
      delta = candidate;
    }
  }
  return best;
}

List<int> _pattern(BarcodeData data) {
  final encoding = GridEncoding.values.indexOf(data.encoding);
  final widthRaw = (data.gridWidth / 8).round().clamp(0, 32);
  final packedWidth = widthRaw == 32 ? 0 : widthRaw;
  final aux = data.zones
      ? data.ringWidth
      : packedWidth | (data.lanes == 2 ? 0x20 : 0);
  final boundedHeight = (data.gridHeight / 8).round().clamp(0, 63);
  final boundedAux = aux.clamp(0, 63);
  final body = <int>[
    ..._intToBits(data.version, 2),
    ..._intToBits(encoding < 0 ? 3 : encoding, 3),
    ..._intToBits(_nearestRateIndex(data.rate), 3),
    data.zones ? 1 : 0,
    ..._intToBits(boundedHeight, 6),
    ..._intToBits(boundedAux, 6),
  ];
  return <int>[..._sync, ...body, ..._intToBits(_crc7(body), 7)];
}

/// Encodes one RGB barcode row. The sender repeats it for [barcodeRows] rows.
Uint8List encodeBarcodeRow(BarcodeData data, int gridWidth) {
  final pattern = _pattern(data);
  final output = Uint8List(gridWidth * 3);
  for (var cell = 0; cell < gridWidth; cell++) {
    final bit = pattern[(cell ~/ barcodeBarCells) % barcodePatternLength];
    final value = bit == 1 ? 255 : 0;
    output[cell * 3] = value;
    output[cell * 3 + 1] = value;
    output[cell * 3 + 2] = value;
  }
  return output;
}

BarcodeData? _decodeBits(List<int> bits, int offset) {
  final bodyStart = offset + _sync.length;
  final body = bits.sublist(bodyStart, bodyStart + 21);
  final zones = body[8] == 1;
  final aux = _bitsToInt(body, 15, 6);
  final encodingIndex = _bitsToInt(body, 2, 3);
  if (encodingIndex >= GridEncoding.values.length) return null;
  final rateIndex = _bitsToInt(body, 5, 3);
  if (rateIndex >= _rates.length) return null;
  return BarcodeData(
    version: _bitsToInt(body, 0, 2),
    encoding: GridEncoding.values[encodingIndex],
    rate: _rates[rateIndex],
    zones: zones,
    ringWidth: zones ? aux : 0,
    gridWidth: zones ? 0 : ((aux & 0x1f) == 0 ? 32 : (aux & 0x1f)) * 8,
    gridHeight: _bitsToInt(body, 9, 6) * 8,
    lanes: zones ? 1 : ((aux & 0x20) != 0 ? 2 : 1),
  );
}

class TimingBarcodeData {
  const TimingBarcodeData({
    required this.fps,
    required this.tick,
    required this.lane,
  });
  final double fps;
  final int tick;
  final int lane;
}

List<int> _timingPattern(TimingBarcodeData data) {
  final body = <int>[
    ..._intToBits(1, 2),
    ..._intToBits((data.fps * 2).round().clamp(0, 255), 8),
    ..._intToBits(data.tick & 0x3ff, 10),
    data.lane & 1,
  ];
  return <int>[..._sync, ...body, ..._intToBits(_crc7(body), 7)];
}

Uint8List encodeTimingBarcodeRow(TimingBarcodeData data, int gridWidth) {
  final pattern = _timingPattern(data);
  final output = Uint8List(gridWidth * 3);
  for (var cell = 0; cell < gridWidth; cell++) {
    final value = pattern[(cell ~/ barcodeBarCells) % barcodePatternLength] == 1
        ? 223
        : 32;
    output[cell * 3] = output[cell * 3 + 1] = output[cell * 3 + 2] = value;
  }
  return output;
}

TimingBarcodeData? decodeTimingBarcodeLuminance(List<double> luminance) {
  final decoded = _decodePatternBits(luminance);
  if (decoded == null) return null;
  final body = decoded.sublist(_sync.length, _sync.length + 21);
  if (_bitsToInt(body, 0, 2) != 1) return null;
  return TimingBarcodeData(
    fps: _bitsToInt(body, 2, 8) / 2,
    tick: _bitsToInt(body, 10, 10),
    lane: _bitsToInt(body, 20, 1),
  );
}

List<int>? _decodePatternBits(List<double> luminance) {
  if (luminance.length < minBarcodeWidth) return null;
  for (var phase = 0; phase < barcodeBarCells; phase++) {
    final barCount = (luminance.length - phase) ~/ barcodeBarCells;
    if (barCount < barcodePatternLength) continue;
    final bars = List<double>.generate(barCount, (bar) {
      final index = phase + bar * barcodeBarCells;
      return (luminance[index] + luminance[index + 1]) / 2;
    });
    final sorted = [...bars]..sort();
    var threshold = (sorted.first + sorted.last) / 2;
    var gap = -1.0;
    for (var i = 1; i < sorted.length; i++) {
      final candidate = sorted[i] - sorted[i - 1];
      if (candidate > gap) {
        gap = candidate;
        threshold = (sorted[i] + sorted[i - 1]) / 2;
      }
    }
    final bits = bars.map((value) => value > threshold ? 1 : 0).toList();
    for (
      var offset = 0;
      offset <= (barCount - barcodePatternLength).clamp(0, 4);
      offset++
    ) {
      if (!List.generate(
        _sync.length,
        (i) => bits[offset + i] == _sync[i],
      ).every((v) => v))
        continue;
      final body = bits.sublist(
        offset + _sync.length,
        offset + _sync.length + 21,
      );
      if (_crc7(body) == _bitsToInt(bits, offset + _sync.length + 21, 7)) {
        return bits.sublist(offset, offset + barcodePatternLength);
      }
    }
  }
  return null;
}

/// Decodes per-cell luminance after the locator has rectified a camera frame.
/// It tolerates a one-cell registration shift and repeating barcode copies.
BarcodeData? decodeBarcodeLuminance(List<double> luminance) {
  if (luminance.length < minBarcodeWidth) return null;
  for (var phase = 0; phase < barcodeBarCells; phase++) {
    final barCount = (luminance.length - phase) ~/ barcodeBarCells;
    if (barCount < barcodePatternLength) continue;
    final bars = List<double>.generate(barCount, (bar) {
      final index = phase + bar * barcodeBarCells;
      return (luminance[index] + luminance[index + 1]) / 2;
    });
    final sorted = [...bars]..sort();
    var threshold = (sorted.first + sorted.last) / 2;
    var gap = -1.0;
    for (var i = 1; i < sorted.length; i++) {
      final candidate = sorted[i] - sorted[i - 1];
      if (candidate > gap) {
        gap = candidate;
        threshold = (sorted[i] + sorted[i - 1]) / 2;
      }
    }
    final bits = bars.map((value) => value > threshold ? 1 : 0).toList();
    final lastOffset = (barCount - barcodePatternLength) < 4
        ? (barCount - barcodePatternLength)
        : 4;
    for (var offset = 0; offset <= lastOffset; offset++) {
      var syncMatches = true;
      for (var i = 0; i < _sync.length; i++) {
        if (bits[offset + i] != _sync[i]) {
          syncMatches = false;
          break;
        }
      }
      if (!syncMatches) continue;
      final body = bits.sublist(
        offset + _sync.length,
        offset + _sync.length + 21,
      );
      final storedCrc = _bitsToInt(bits, offset + _sync.length + 21, 7);
      if (_crc7(body) != storedCrc) continue;
      return _decodeBits(bits, offset);
    }
  }
  return null;
}
