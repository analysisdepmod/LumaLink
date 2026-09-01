import 'dart:math' as math;
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
  }) : reliability = reliability ?? Float32List(gridWidth * gridHeight)
         ..fillRange(0, gridWidth * gridHeight, 1) {
    final cells = gridWidth * gridHeight;
    if (red.length < cells ||
        green.length < cells ||
        blue.length < cells ||
        this.reliability.length < cells) {
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

double _neighbourCorrelation(
  Float32List values,
  int gridWidth,
  int gridHeight,
  int from,
) {
  var sum = 0.0, sumSquared = 0.0, count = 0;
  for (var i = from; i < values.length; i++) {
    final value = values[i];
    sum += value;
    sumSquared += value * value;
    count++;
  }
  if (count < 16) return 0;
  final mean = sum / count;
  final variance = sumSquared / count - mean * mean;
  if (variance <= 16) return 0;
  var covariance = 0.0, pairs = 0;
  for (var y = 0; y < gridHeight; y++) {
    for (var x = 0; x < gridWidth; x++) {
      final i = y * gridWidth + x;
      if (i < from) continue;
      final centered = values[i] - mean;
      if (x + 1 < gridWidth && i + 1 >= from) {
        covariance += centered * (values[i + 1] - mean);
        pairs++;
      }
      if (y + 1 < gridHeight && i + gridWidth >= from) {
        covariance += centered * (values[i + gridWidth] - mean);
        pairs++;
      }
    }
  }
  return pairs == 0 ? 0 : covariance / pairs / variance;
}

double estimateColor8SpatialBlur(Color8Grid grid) {
  final from = grid.gridWidth * barcodeRows;
  final correlation =
      (_neighbourCorrelation(grid.red, grid.gridWidth, grid.gridHeight, from) +
          _neighbourCorrelation(
            grid.green,
            grid.gridWidth,
            grid.gridHeight,
            from,
          ) +
          _neighbourCorrelation(
            grid.blue,
            grid.gridWidth,
            grid.gridHeight,
            from,
          )) /
      3;
  return ((correlation - 0.08) * 0.82).clamp(0, 0.34).toDouble();
}

/// Allocation-bounded port of the browser's blind spatial equalizer. The
/// whitened payload should have no neighbour correlation, so measured positive
/// correlation estimates camera/display blur and drives a bounded inverse filter.
class Color8SpatialEqualizer {
  Float32List _red = Float32List(0);
  Float32List _green = Float32List(0);
  Float32List _blue = Float32List(0);
  Float32List _temporary = Float32List(0);

  void _ensure(int length) {
    if (_red.length == length) return;
    _red = Float32List(length);
    _green = Float32List(length);
    _blue = Float32List(length);
    _temporary = Float32List(length);
  }

  void _sharpen(
    Float32List source,
    Float32List output,
    int width,
    int height,
    int from,
    double strength,
  ) {
    var low = double.infinity, high = double.negativeInfinity;
    for (var i = from; i < source.length; i++) {
      low = math.min(low, source[i]);
      high = math.max(high, source[i]);
      output[i] = source[i];
    }
    for (var i = 0; i < from; i++) {
      output[i] = source[i];
    }
    final padding = math.max(4, (high - low) * 0.08);
    final minimum = low - padding, maximum = high + padding;
    final spill = math.min(0.49, strength * 1.6);
    final iterations = strength > 0.18 ? 3 : (strength > 0.09 ? 2 : 1);
    for (var iteration = 0; iteration < iterations; iteration++) {
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          final i = y * width + x;
          if (i < from ||
              x == 0 ||
              x + 1 == width ||
              y == 0 ||
              y + 1 == height) {
            _temporary[i] = output[i];
            continue;
          }
          final neighbours =
              (output[i - 1] +
                  output[i + 1] +
                  output[i - width] +
                  output[i + width]) /
              4;
          _temporary[i] = (1 - spill) * output[i] + spill * neighbours;
        }
      }
      for (var y = 1; y + 1 < height; y++) {
        for (var x = 1; x + 1 < width; x++) {
          final i = y * width + x;
          if (i < from) continue;
          output[i] = (output[i] + source[i] - _temporary[i])
              .clamp(minimum, maximum)
              .toDouble();
        }
      }
    }
  }

  Color8Grid apply(Color8Grid grid, double strength) {
    if (strength < 0.025) return grid;
    final length = grid.gridWidth * grid.gridHeight;
    _ensure(length);
    final from = grid.gridWidth * barcodeRows;
    _sharpen(grid.red, _red, grid.gridWidth, grid.gridHeight, from, strength);
    _sharpen(
      grid.green,
      _green,
      grid.gridWidth,
      grid.gridHeight,
      from,
      strength,
    );
    _sharpen(grid.blue, _blue, grid.gridWidth, grid.gridHeight, from, strength);
    return Color8Grid(
      gridWidth: grid.gridWidth,
      gridHeight: grid.gridHeight,
      red: _red,
      green: _green,
      blue: _blue,
      reliability: grid.reliability,
    );
  }
}

int color8CapacityBytes(int gridWidth, int gridHeight) {
  final usableCells = gridWidth * gridHeight - gridWidth * barcodeRows;
  return (usableCells * 3) ~/ 8;
}

List<int> segmentedColor8Capacities(int gridWidth, int gridHeight) {
  final dataRows = math.max(0, gridHeight - barcodeRows);
  final left = (gridWidth + 1) ~/ 2;
  final right = gridWidth ~/ 2;
  final top = (dataRows + 1) ~/ 2;
  final bottom = dataRows ~/ 2;
  return <int>[
    left * top,
    right * top,
    left * bottom,
    right * bottom,
  ].map((cells) => cells * 3 ~/ 8).toList(growable: false);
}

int _color8Segment(int x, int y, int gridWidth, int gridHeight) {
  final topRows = (gridHeight - barcodeRows + 1) ~/ 2;
  return (y - barcodeRows < topRows ? 0 : 2) +
      (x < (gridWidth + 1) ~/ 2 ? 0 : 1);
}

List<Float64List> splitSegmentedColor8Llr(
  Float64List llr,
  int gridWidth,
  int gridHeight,
) {
  final capacities = segmentedColor8Capacities(gridWidth, gridHeight);
  final output = capacities
      .map((capacity) => Float64List(capacity * 8))
      .toList(growable: false);
  final cursors = <int>[0, 0, 0, 0];
  for (var y = barcodeRows; y < gridHeight; y++) {
    for (var x = 0; x < gridWidth; x++) {
      final segment = _color8Segment(x, y, gridWidth, gridHeight);
      final source = ((y - barcodeRows) * gridWidth + x) * 3;
      final destination = cursors[segment];
      for (
        var channel = 0;
        channel < 3 && destination + channel < output[segment].length;
        channel++
      ) {
        output[segment][destination + channel] = llr[source + channel];
      }
      cursors[segment] += 3;
    }
  }
  return output;
}

int bwCapacityBytes(int gridWidth, int gridHeight) =>
    (gridWidth * gridHeight - gridWidth * barcodeRows) ~/ 8;

double _llrFor(double channel, double reliability) {
  // 127.5 is the midpoint between GridData's 0 and 255 channel levels.
  // Keep the scale finite so an overexposed camera pixel cannot dominate LDPC.
  final boundedReliability = reliability < 0
      ? 0.0
      : (reliability > 1 ? 1.0 : reliability);
  final llr = ((127.5 - channel) / 32) * boundedReliability;
  if (llr > 10) return 10;
  if (llr < -10) return -10;
  return llr;
}

(double, double) _adaptiveBinaryModel(Float32List channel, int from, int to) {
  final histogram = Int32List(256);
  for (var i = from; i < to; i++) {
    histogram[channel[i].round().clamp(0, 255)]++;
  }
  final count = to - from;
  int percentile(double fraction) {
    final target = (count * fraction).round();
    var seen = 0;
    for (var value = 0; value < histogram.length; value++) {
      seen += histogram[value];
      if (seen >= target) return value;
    }
    return 255;
  }

  final dark = percentile(0.1).toDouble();
  final light = percentile(0.9).toDouble();
  return ((dark + light) * 0.5, 8 / (light - dark).clamp(16, 255));
}

double _adaptiveLlr(
  double value,
  double midpoint,
  double scale,
  double reliability,
) {
  final llr = (midpoint - value) * scale * reliability.clamp(0, 1);
  return llr.clamp(-20, 20).toDouble();
}

/// Produces GridData's transmitted-bit LLRs from a perspective-rectified,
/// per-cell RGB read. The three barcode rows are deliberately excluded.
Float64List softDemodulateColor8(Color8Grid grid) {
  final capacity = color8CapacityBytes(grid.gridWidth, grid.gridHeight);
  final output = Float64List(capacity * 8);
  final firstDataCell = grid.gridWidth * barcodeRows;
  final cells = grid.gridWidth * grid.gridHeight;
  final redModel = _adaptiveBinaryModel(grid.red, firstDataCell, cells);
  final greenModel = _adaptiveBinaryModel(grid.green, firstDataCell, cells);
  final blueModel = _adaptiveBinaryModel(grid.blue, firstDataCell, cells);
  var out = 0;
  for (
    var cell = firstDataCell;
    cell < grid.gridWidth * grid.gridHeight && out < output.length;
    cell++
  ) {
    final reliability = grid.reliability[cell];
    output[out++] = _adaptiveLlr(
      grid.red[cell],
      redModel.$1,
      redModel.$2,
      reliability,
    );
    if (out >= output.length) break;
    output[out++] = _adaptiveLlr(
      grid.green[cell],
      greenModel.$1,
      greenModel.$2,
      reliability,
    );
    if (out >= output.length) break;
    output[out++] = _adaptiveLlr(
      grid.blue[cell],
      blueModel.$1,
      blueModel.$2,
      reliability,
    );
  }
  return output;
}

Float64List softDemodulateBw(Color8Grid grid) {
  final capacity = bwCapacityBytes(grid.gridWidth, grid.gridHeight);
  final output = Float64List(capacity * 8);
  var out = 0;
  for (
    var cell = grid.gridWidth * barcodeRows;
    cell < grid.gridWidth * grid.gridHeight && out < output.length;
    cell++
  ) {
    final luminance =
        grid.red[cell] * 0.299 +
        grid.green[cell] * 0.587 +
        grid.blue[cell] * 0.114;
    output[out++] = _llrFor(luminance, grid.reliability[cell]);
  }
  return output;
}

/// Native test/diagnostic helper: maps a transmitted GridData frame to exact
/// Color8 cells, retaining the barcode region for the caller to paint separately.
Color8Grid encodeColor8Cells(Uint8List frame, int gridWidth, int gridHeight) {
  final capacity = color8CapacityBytes(gridWidth, gridHeight);
  if (frame.length != capacity) {
    throw ArgumentError('Frame does not match Color8 capacity');
  }
  final cells = gridWidth * gridHeight;
  final red = Float32List(cells);
  final green = Float32List(cells);
  final blue = Float32List(cells);
  final reliability = Float32List(cells)..fillRange(0, cells, 1);
  var bit = 0;
  for (
    var cell = gridWidth * barcodeRows;
    cell < cells && bit < frame.length * 8;
    cell++
  ) {
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
  return Color8Grid(
    gridWidth: gridWidth,
    gridHeight: gridHeight,
    red: red,
    green: green,
    blue: blue,
    reliability: reliability,
  );
}

/// Test/diagnostic mirror of the web v11 quadrant mapper.
Color8Grid encodeSegmentedColor8Cells(
  List<Uint8List> frames,
  int gridWidth,
  int gridHeight,
) {
  final capacities = segmentedColor8Capacities(gridWidth, gridHeight);
  if (frames.length != 4) {
    throw ArgumentError('Four segment frames are required');
  }
  for (var segment = 0; segment < 4; segment++) {
    if (frames[segment].length != capacities[segment]) {
      throw ArgumentError('Segment $segment does not match its capacity');
    }
  }
  final cells = gridWidth * gridHeight;
  final red = Float32List(cells);
  final green = Float32List(cells);
  final blue = Float32List(cells);
  final reliability = Float32List(cells)..fillRange(0, cells, 1);
  final cursors = <int>[0, 0, 0, 0];
  double read(int segment) {
    final bit = cursors[segment]++;
    if (bit >= frames[segment].length * 8) return 0;
    return ((frames[segment][bit ~/ 8] >> (7 - (bit % 8))) & 1) == 1 ? 255 : 0;
  }

  for (var y = barcodeRows; y < gridHeight; y++) {
    for (var x = 0; x < gridWidth; x++) {
      final segment = _color8Segment(x, y, gridWidth, gridHeight);
      final cell = y * gridWidth + x;
      red[cell] = read(segment);
      green[cell] = read(segment);
      blue[cell] = read(segment);
    }
  }
  return Color8Grid(
    gridWidth: gridWidth,
    gridHeight: gridHeight,
    red: red,
    green: green,
    blue: blue,
    reliability: reliability,
  );
}
