import 'dart:math' as math;
import 'dart:typed_data';

import 'color8.dart';
import 'meta_barcode.dart';

List<int>? _channelBits(GridEncoding encoding) => switch (encoding) {
  GridEncoding.color16 => const [1, 2, 1],
  GridEncoding.color32 => const [2, 2, 1],
  GridEncoding.color64 => const [2, 2, 2],
  _ => null,
};

int _grayToBinary(int gray) {
  var binary = 0;
  for (var value = gray; value > 0; value >>= 1) {
    binary ^= value;
  }
  return binary;
}

int _anchorCount(List<int> bits) =>
    bits.fold(0, (sum, value) => sum + (1 << value));

int multiColorCapacityBytes(Color8Grid grid, GridEncoding encoding) {
  final bits = _channelBits(encoding);
  if (bits == null) throw ArgumentError('Encoding is not multi-level');
  final usable =
      grid.gridWidth * grid.gridHeight -
      grid.gridWidth * barcodeRows -
      _anchorCount(bits);
  return (usable * bits.reduce((a, b) => a + b)) ~/ 8;
}

/// Soft-demodulates GridData Color16/32/64 cells using the protocol's leading
/// per-channel calibration anchors. The anchors absorb display gamma, exposure,
/// and white balance; the LLRs still preserve confidence for LDPC.
Float64List softDemodulateMultiColor(Color8Grid grid, GridEncoding encoding) {
  final bits = _channelBits(encoding);
  if (bits == null) throw ArgumentError('Encoding is not multi-level');
  final capacity = multiColorCapacityBytes(grid, encoding);
  final output = Float64List(capacity * 8);
  final channels = <Float32List>[grid.red, grid.green, grid.blue];
  final centres = List<List<double>>.generate(3, (_) => <double>[]);
  var anchor = grid.gridWidth * barcodeRows;
  for (var channel = 0; channel < 3; channel++) {
    final levels = 1 << bits[channel];
    for (var level = 0; level < levels; level++) {
      centres[channel].add(channels[channel][anchor++]);
    }
  }
  var out = 0;
  for (
    var cell = anchor;
    cell < grid.gridWidth * grid.gridHeight && out < output.length;
    cell++
  ) {
    final reliability = grid.reliability[cell] < 0
        ? 0.0
        : (grid.reliability[cell] > 1 ? 1.0 : grid.reliability[cell]);
    for (var channel = 0; channel < 3 && out < output.length; channel++) {
      final channelBits = bits[channel];
      final observed = channels[channel][cell];
      for (var bit = channelBits - 1; bit >= 0 && out < output.length; bit--) {
        var nearestZero = double.infinity;
        var nearestOne = double.infinity;
        for (var word = 0; word < (1 << channelBits); word++) {
          final physicalLevel = _grayToBinary(word);
          final distance = (observed - centres[channel][physicalLevel]).abs();
          if (((word >> bit) & 1) == 0) {
            nearestZero = math.min(nearestZero, distance);
          } else {
            nearestOne = math.min(nearestOne, distance);
          }
        }
        final llr = (nearestOne - nearestZero) * reliability / 18;
        output[out++] = llr.clamp(-10, 10).toDouble();
      }
    }
  }
  return output;
}
