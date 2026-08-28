import 'dart:typed_data';

import 'meta_barcode.dart';

class Color8Grid {
  Color8Grid({
    required this.gridWidth,
    required this.gridHeight,
    required this.red,
    required this.green,
    required this.blue,
    Float32List? reliability,
  }) : reliability = reliability ?? Float32List(gridWidth * gridHeight)..fillRange(0, gridWidth * gridHeight, 1) {
    final cells = gridWidth * gridHeight;
    if (red.length < cells || green.length < cells || blue.length < cells || this.reliability.length < cells) {
      throw ArgumentError('Every channel must contain one sample per cell');
    }
  }

  final int gridWidth;
  final int gridHeight;
  final Float32List red;
  final Float32List green;
  final Float32List blue;
  final Float32List reliability;
}

int color8CapacityBytes(int gridWidth, int gridHeight) {
  final usableCells = gridWidth * gridHeight - gridWidth * barcodeRows;
  return (usableCells * 3) ~/ 8;
}

int bwCapacityBytes(int gridWidth, int gridHeight) =>
    (gridWidth * gridHeight - gridWidth * barcodeRows) ~/ 8;

double _llrFor(double channel, double reliability) {
  // 127.5 is the midpoint between GridData's 0 and 255 channel levels.
  // Keep the scale finite so an overexposed camera pixel cannot dominate LDPC.
  final boundedReliability = reliability < 0 ? 0.0 : (reliability > 1 ? 1.0 : reliability);
  final llr = ((127.5 - channel) / 32) * boundedReliability;
  if (llr > 10) return 10;
  if (llr < -10) return -10;
  return llr;
}

/// Produces GridData's transmitted-bit LLRs from a perspective-rectified,
/// per-cell RGB read. The three barcode rows are deliberately excluded.
Float64List softDemodulateColor8(Color8Grid grid) {
  final capacity = color8CapacityBytes(grid.gridWidth, grid.gridHeight);
  final output = Float64List(capacity * 8);
  final firstDataCell = grid.gridWidth * barcodeRows;
  var out = 0;
  for (var cell = firstDataCell; cell < grid.gridWidth * grid.gridHeight && out < output.length; cell++) {
    final reliability = grid.reliability[cell];
    output[out++] = _llrFor(grid.red[cell], reliability);
    if (out >= output.length) break;
    output[out++] = _llrFor(grid.green[cell], reliability);
    if (out >= output.length) break;
    output[out++] = _llrFor(grid.blue[cell], reliability);
  }
  return output;
}

Float64List softDemodulateBw(Color8Grid grid) {
  final capacity = bwCapacityBytes(grid.gridWidth, grid.gridHeight);
  final output = Float64List(capacity * 8);
  var out = 0;
  for (var cell = grid.gridWidth * barcodeRows; cell < grid.gridWidth * grid.gridHeight && out < output.length; cell++) {
    final luminance = grid.red[cell] * 0.299 + grid.green[cell] * 0.587 + grid.blue[cell] * 0.114;
    output[out++] = _llrFor(luminance, grid.reliability[cell]);
  }
  return output;
}

/// Native test/diagnostic helper: maps a transmitted GridData frame to exact
/// Color8 cells, retaining the barcode region for the caller to paint separately.
Color8Grid encodeColor8Cells(Uint8List frame, int gridWidth, int gridHeight) {
  final capacity = color8CapacityBytes(gridWidth, gridHeight);
  if (frame.length != capacity) throw ArgumentError('Frame does not match Color8 capacity');
  final cells = gridWidth * gridHeight;
  final red = Float32List(cells);
  final green = Float32List(cells);
  final blue = Float32List(cells);
  final reliability = Float32List(cells)..fillRange(0, cells, 1);
  var bit = 0;
  for (var cell = gridWidth * barcodeRows; cell < cells && bit < frame.length * 8; cell++) {
    double readBit() {
      if (bit >= frame.length * 8) return 0.0;
      final value = (frame[bit ~/ 8] >> (7 - (bit % 8))) & 1;
      bit++;
      return value == 1 ? 255.0 : 0.0;
    }
    red[cell] = readBit();
    green[cell] = readBit();
    blue[cell] = readBit();
  }
  return Color8Grid(gridWidth: gridWidth, gridHeight: gridHeight, red: red, green: green, blue: blue, reliability: reliability);
}
