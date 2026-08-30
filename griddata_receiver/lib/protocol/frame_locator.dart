import 'dart:math' as math;
import 'dart:typed_data';

import 'meta_barcode.dart';

class LumaPlane {
  const LumaPlane({
    required this.width,
    required this.height,
    required this.bytes,
    required this.bytesPerRow,
    this.bytesPerPixel = 1,
  });

  final int width;
  final int height;
  final Uint8List bytes;
  final int bytesPerRow;
  final int bytesPerPixel;

  int at(int x, int y) {
    final safeX = x < 0 ? 0 : (x >= width ? width - 1 : x);
    final safeY = y < 0 ? 0 : (y >= height ? height - 1 : y);
    return bytes[safeY * bytesPerRow + safeX * bytesPerPixel];
  }
}

class MatrixRect {
  const MatrixRect({
    required this.left,
    required this.top,
    required this.width,
    required this.height,
  });
  final double left;
  final double top;
  final double width;
  final double height;

  /// Strip away GridData's outer black finder ring, leaving data cells only.
  MatrixRect get dataRegion {
    const frameRatio = 0.07;
    const inset = frameRatio / (1 + 2 * frameRatio);
    return MatrixRect(
      left: left + width * inset,
      top: top + height * inset,
      width: width * (1 - 2 * inset),
      height: height * (1 - 2 * inset),
    );
  }
}

int _otsu(List<int> values) {
  final histogram = Int32List(256);
  var sum = 0.0;
  for (final value in values) {
    histogram[value]++;
    sum += value;
  }
  var backgroundCount = 0;
  var backgroundSum = 0.0;
  var bestThreshold = 70;
  var bestVariance = -1.0;
  for (var threshold = 0; threshold < 256; threshold++) {
    backgroundCount += histogram[threshold];
    if (backgroundCount == 0) continue;
    final foregroundCount = values.length - backgroundCount;
    if (foregroundCount == 0) break;
    backgroundSum += threshold * histogram[threshold];
    final backgroundMean = backgroundSum / backgroundCount;
    final foregroundMean = (sum - backgroundSum) / foregroundCount;
    final variance =
        (backgroundCount *
                foregroundCount *
                math.pow(backgroundMean - foregroundMean, 2))
            .toDouble();
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

/// Fast, allocation-bounded locator for the outer black GridData frame. It is
/// deliberately coarse: the app re-runs it each frame, so it self-corrects if
/// the phone moves. Sampling is centred inside every data cell afterwards.
MatrixRect? locateOuterFrame(LumaPlane image) {
  final frames = locateOuterFrames(image, maxCount: 1);
  return frames.isEmpty ? null : frames.first;
}

/// Returns both independently displayed Turbo tiles from one camera exposure.
/// Candidates are scored before being sorted spatially, so a noisy dark patch
/// cannot displace a valid second matrix merely because it appears first.
List<MatrixRect> locateOuterFrames(LumaPlane image, {int maxCount = 2}) {
  const longest = 160;
  final sampleWidth = image.width >= image.height
      ? longest
      : math.max(1, (longest * image.width / image.height).round());
  final sampleHeight = image.height > image.width
      ? longest
      : math.max(1, (longest * image.height / image.width).round());
  final sx = image.width / sampleWidth;
  final sy = image.height / sampleHeight;
  final luma = List<int>.filled(sampleWidth * sampleHeight, 0);
  for (var y = 0; y < sampleHeight; y++) {
    final sourceY = (y * sy).floor();
    for (var x = 0; x < sampleWidth; x++) {
      luma[y * sampleWidth + x] = image.at((x * sx).floor(), sourceY);
    }
  }
  // Pure black borders can make Otsu choose 0 on a synthetic/very high-contrast
  // frame; retain a small absolute black floor so those pixels are not excluded.
  final threshold = math.max(40, _otsu(luma));
  final dark = Uint8List(luma.length);
  for (var i = 0; i < luma.length; i++) {
    dark[i] = luma[i] < threshold ? 1 : 0;
  }
  final visited = Uint8List(luma.length);
  final queue = Int32List(luma.length);
  final candidates = <(double, MatrixRect)>[];
  for (var start = 0; start < dark.length; start++) {
    if (dark[start] == 0 || visited[start] != 0) continue;
    var read = 0;
    var write = 0;
    queue[write++] = start;
    visited[start] = 1;
    var minX = sampleWidth;
    var maxX = 0;
    var minY = sampleHeight;
    var maxY = 0;
    while (read < write) {
      final point = queue[read++];
      final x = point % sampleWidth;
      final y = point ~/ sampleWidth;
      minX = math.min(minX, x);
      maxX = math.max(maxX, x);
      minY = math.min(minY, y);
      maxY = math.max(maxY, y);
      void add(int nx, int ny) {
        if (nx < 0 || ny < 0 || nx >= sampleWidth || ny >= sampleHeight) return;
        final next = ny * sampleWidth + nx;
        if (dark[next] == 1 && visited[next] == 0) {
          visited[next] = 1;
          queue[write++] = next;
        }
      }

      add(x - 1, y);
      add(x + 1, y);
      add(x, y - 1);
      add(x, y + 1);
    }
    final width = maxX - minX + 1;
    final height = maxY - minY + 1;
    if (write < 80 || width < 20 || height < 20) continue;
    final ratio = width / height;
    if (ratio < 0.45 || ratio > 2.2) continue;
    final fill = write / (width * height);
    final score = (write * math.min(width, height) * (fill < 0.02 ? 0.1 : 1))
        .toDouble();
    candidates.add((
      score,
      MatrixRect(
        left: minX * sx,
        top: minY * sy,
        width: width * sx,
        height: height * sy,
      ),
    ));
  }
  candidates.sort((a, b) => b.$1.compareTo(a.$1));
  final selected = candidates.take(maxCount).map((value) => value.$2).toList();
  selected.sort((a, b) => a.left.compareTo(b.left));
  return selected;
}

double _sampleWindow(LumaPlane image, double x, double y, double cellSize) {
  final radius = math.min(1, math.max(0, (cellSize / 4).floor()));
  var total = 0.0;
  var count = 0;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      total += image.at((x + dx).round(), (y + dy).round());
      count++;
    }
  }
  return count == 0 ? 0 : total / count;
}

TimingBarcodeData? locateTimingBarcode(
  LumaPlane image,
  MatrixRect outer,
  BarcodeData barcode,
) {
  final row = sampleBarcodeLumaAtRow(
    image,
    outer,
    barcode.gridWidth,
    barcode.gridHeight,
    2,
  );
  return decodeTimingBarcodeLuminance(row);
}

List<double> sampleBarcodeLumaAtRow(
  LumaPlane image,
  MatrixRect outer,
  int gridWidth,
  int gridHeight,
  int row,
) {
  final data = outer.dataRegion;
  final cellWidth = data.width / gridWidth;
  final cellHeight = data.height / gridHeight;
  return List<double>.generate(
    gridWidth,
    (x) => _sampleWindow(
      image,
      data.left + (x + 0.5) * cellWidth,
      data.top + (row + 0.5) * cellHeight,
      math.min(cellWidth, cellHeight),
    ),
  );
}

/// Samples the top barcode row after the frame has been located. [gridHeight]
/// only needs to be a geometry estimate because the barcode itself returns the
/// exact height; this mirrors the inexpensive browser lock-on path.
List<double> sampleBarcodeLuma(
  LumaPlane image,
  MatrixRect outer,
  int gridWidth,
  int gridHeight,
) {
  final data = outer.dataRegion;
  final cellWidth = data.width / gridWidth;
  final cellHeight = data.height / gridHeight;
  return List<double>.generate(
    gridWidth,
    (x) => _sampleWindow(
      image,
      data.left + (x + 0.5) * cellWidth,
      data.top + cellHeight * 0.5,
      math.min(cellWidth, cellHeight),
    ),
  );
}

BarcodeData? locateBarcode(LumaPlane image, MatrixRect outer) {
  for (var width = 40; width <= 256; width += 8) {
    final approximateHeight = math.max(
      barcodeRows + 1,
      (outer.height / outer.width * width).round(),
    );
    final decoded = decodeBarcodeLuminance(
      sampleBarcodeLuma(image, outer, width, approximateHeight),
    );
    if (decoded != null &&
        decoded.version == barcodeVersion &&
        (decoded.gridWidth == 0 || decoded.gridWidth == width)) {
      return decoded;
    }
  }
  return null;
}
