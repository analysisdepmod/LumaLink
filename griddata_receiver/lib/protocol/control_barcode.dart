const int controlBarcodeRow = 1;
const int controlPageCount = 10;
const int _barCells = 2;
const int _patternBits = 32;
const int _payloadBits = 10;
const int _dataBits = 21;
const int _type = 2;
const List<int> _sync = <int>[1, 1, 0, 1];

class TransferControl {
  const TransferControl({
    required this.id,
    required this.k,
    required this.chunk,
    required this.compressedBytes,
  });
  final int id;
  final int k;
  final int chunk;
  final int compressedBytes;
}

class TransferControlPage {
  const TransferControlPage({
    required this.page,
    required this.tag,
    required this.payload,
  });
  final int page;
  final int tag;
  final int payload;
}

List<int> _descriptorBits(TransferControl control) => <int>[
  ..._intBits(control.id & 0xffffffff, 32),
  ..._intBits(control.k, 20),
  ..._intBits(control.chunk, 16),
  ..._intBits(control.compressedBytes, 30),
];

int _crc7(List<int> bits) {
  var crc = 0;
  for (final bit in bits) {
    final feedback = ((crc >> 6) & 1) ^ (bit & 1);
    crc = (crc << 1) & 0x7f;
    if (feedback != 0) crc ^= 0x09;
  }
  return crc;
}

List<int> _intBits(int value, int count) =>
    List<int>.generate(count, (index) => (value >> (count - index - 1)) & 1);

int _bitsInt(List<int> bits, int offset, int count) {
  var value = 0;
  for (var index = 0; index < count; index++) {
    value = value * 2 + (bits[offset + index] & 1);
  }
  return value;
}

int _tag(int id) => (id ^ (id >> 5) ^ (id >> 13) ^ (id >> 21)) & 0x1f;

TransferControlPage controlPage(TransferControl control, int page) {
  page = ((page % controlPageCount) + controlPageCount) % controlPageCount;
  final bits = _descriptorBits(control);
  var payload = 0;
  for (var bit = 0; bit < _payloadBits; bit++) {
    final index = page * _payloadBits + bit;
    payload = (payload << 1) | (index < bits.length ? bits[index] : 0);
  }
  return TransferControlPage(
    page: page,
    tag: _tag(control.id),
    payload: payload,
  );
}

List<double> encodeControlBarcodeLuminance(
  TransferControl control,
  int page,
  int gridWidth,
) {
  final value = controlPage(control, page);
  final data = <int>[
    ..._intBits(_type, 2),
    ..._intBits(value.page, 4),
    ..._intBits(value.tag, 5),
    ..._intBits(value.payload, _payloadBits),
  ];
  final pattern = <int>[..._sync, ...data, ..._intBits(_crc7(data), 7)];
  return List<double>.generate(
    gridWidth,
    (cell) => pattern[(cell ~/ _barCells) % _patternBits] == 1 ? 239 : 16,
  );
}

TransferControlPage? decodeControlBarcodeLuminance(List<double> luminance) {
  if (luminance.length < _patternBits * _barCells) return null;
  for (var phase = 0; phase < _barCells; phase++) {
    final barCount = (luminance.length - phase) ~/ _barCells;
    if (barCount < _patternBits) continue;
    final bars = List<double>.generate(barCount, (bar) {
      final index = phase + bar * _barCells;
      return (luminance[index] + luminance[index + 1]) / 2;
    });
    final sorted = List<double>.from(bars)..sort();
    var threshold = (sorted.first + sorted.last) / 2;
    var gap = -1.0;
    for (var index = 1; index < sorted.length; index++) {
      final candidate = sorted[index] - sorted[index - 1];
      if (candidate > gap) {
        gap = candidate;
        threshold = (sorted[index] + sorted[index - 1]) / 2;
      }
    }
    final bits = bars.map((value) => value > threshold ? 1 : 0).toList();
    final lastOffset = (barCount - _patternBits).clamp(0, 4);
    for (var offset = 0; offset <= lastOffset; offset++) {
      var sync = true;
      for (var index = 0; index < _sync.length; index++) {
        if (bits[offset + index] != _sync[index]) sync = false;
      }
      if (!sync) continue;
      final data = bits.sublist(
        offset + _sync.length,
        offset + _sync.length + _dataBits,
      );
      if (_bitsInt(data, 0, 2) != _type) continue;
      if (_crc7(data) != _bitsInt(bits, offset + _sync.length + _dataBits, 7)) {
        continue;
      }
      final page = _bitsInt(data, 2, 4);
      if (page >= controlPageCount) continue;
      return TransferControlPage(
        page: page,
        tag: _bitsInt(data, 6, 5),
        payload: _bitsInt(data, 11, _payloadBits),
      );
    }
  }
  return null;
}

class TransferControlAssembler {
  int _currentTag = -1;
  final Map<int, int> _pages = <int, int>{};

  void reset() {
    _currentTag = -1;
    _pages.clear();
  }

  TransferControl? add(TransferControlPage page) {
    if (_currentTag != page.tag) {
      _currentTag = page.tag;
      _pages.clear();
    }
    _pages[page.page] = page.payload;
    if (_pages.length < controlPageCount) return null;
    final bits = <int>[];
    for (var index = 0; index < controlPageCount; index++) {
      final payload = _pages[index];
      if (payload == null) return null;
      bits.addAll(_intBits(payload, _payloadBits));
    }
    final control = TransferControl(
      id: _bitsInt(bits, 0, 32),
      k: _bitsInt(bits, 32, 20),
      chunk: _bitsInt(bits, 52, 16),
      compressedBytes: _bitsInt(bits, 68, 30),
    );
    if (_tag(control.id) != _currentTag || control.k < 1 || control.chunk < 1) {
      return null;
    }
    return control;
  }
}
