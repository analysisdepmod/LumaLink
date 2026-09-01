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
    this.topLeft,
    this.topRight,
    this.bottomRight,
    this.bottomLeft,
    this.refined = false,
  });
  final double left;
  final double top;
  final double width;
  final double height;
  final math.Point<double>? topLeft;
  final math.Point<double>? topRight;
  final math.Point<double>? bottomRight;
  final math.Point<double>? bottomLeft;
  final bool refined;

  math.Point<double> _corner(math.Point<double>? value, double x, double y) =>
      value ?? math.Point<double>(x, y);

  /// Project a point from the data-cell unit square into the photographed
  /// quadrilateral. This removes the row drift produced by a tilted tablet.
  math.Point<double> mapData(double u, double v) {
    const frameRatio = 0.07;
    const inset = frameRatio / (1 + 2 * frameRatio);
    final outerU = inset + u * (1 - 2 * inset);
    final outerV = inset + v * (1 - 2 * inset);
    final p0 = _corner(topLeft, left, top);
    final p1 = _corner(topRight, left + width, top);
    final p2 = _corner(bottomRight, left + width, top + height);
    final p3 = _corner(bottomLeft, left, top + height);
    final dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
    final dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    final dx3 = p0.x - p1.x + p2.x - p3.x;
    final dy3 = p0.y - p1.y + p2.y - p3.y;
    var g = 0.0, h = 0.0;
    final determinant = dx1 * dy2 - dx2 * dy1;
    if ((dx3.abs() + dy3.abs()) > 1e-6 && determinant.abs() > 1e-6) {
      g = (dx3 * dy2 - dx2 * dy3) / determinant;
      h = (dx1 * dy3 - dx3 * dy1) / determinant;
    }
    final a = p1.x - p0.x + g * p1.x;
    final b = p3.x - p0.x + h * p3.x;
    final d = p1.y - p0.y + g * p1.y;
    final e = p3.y - p0.y + h * p3.y;
    final denominator = g * outerU + h * outerV + 1;
    return math.Point<double>(
      (a * outerU + b * outerV + p0.x) / denominator,
      (d * outerU + e * outerV + p0.y) / denominator,
    );
  }

  double dataCellSize(int gridWidth, int gridHeight) {
    final a = mapData(0, 0), b = mapData(1, 0), c = mapData(0, 1);
    return math.min(a.distanceTo(b) / gridWidth, a.distanceTo(c) / gridHeight);
  }

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

class _FinderHit {
  const _FinderHit(this.point, this.moduleSize, this.count, this.ok);
  final math.Point<double> point;
  final double moduleSize;
  final int count;
  final bool ok;
}

double _finderRatio(int c0, int c1, int c2, int c3, int c4) {
  final total = c0 + c1 + c2 + c3 + c4;
  if (total < 7) return 0;
  final module = total / 7;
  final variance = module * 0.6;
  if ((module - c0).abs() < variance &&
      (module - c1).abs() < variance &&
      (3 * module - c2).abs() < 3 * variance &&
      (module - c3).abs() < variance &&
      (module - c4).abs() < variance) {
    return module;
  }
  return 0;
}

void _scanFinderLine(
  bool Function(int) dark,
  int length,
  double minModule,
  double maxModule,
  void Function(double center, double module) onHit,
) {
  final runs = Int32List(5);
  var current = 0;
  var started = false;
  for (var i = 0; i < length; i++) {
    if (dark(i)) {
      if (current.isOdd) current++;
      runs[current]++;
      started = true;
    } else {
      if (!started) continue;
      if (current.isEven) {
        if (current == 4) {
          final module = _finderRatio(
            runs[0],
            runs[1],
            runs[2],
            runs[3],
            runs[4],
          );
          if (module >= minModule && module <= maxModule) {
            onHit(i - runs[4] - runs[3] - runs[2] / 2, module);
          }
          runs[0] = runs[2];
          runs[1] = runs[3];
          runs[2] = runs[4];
          runs[3] = 1;
          runs[4] = 0;
          current = 3;
        } else {
          current++;
          runs[current]++;
        }
      } else {
        runs[current]++;
      }
    }
  }
}

_FinderHit _findFinderNear(
  LumaPlane image,
  math.Point<double> predicted,
  double framePixels,
) {
  final finderSize = framePixels * 0.9;
  final expectedModule = finderSize / 9;
  final half = (finderSize * 1.35).round() + 3;
  final x0 = math.max(0, predicted.x.round() - half);
  final x1 = math.min(image.width - 1, predicted.x.round() + half);
  final y0 = math.max(0, predicted.y.round() - half);
  final y1 = math.min(image.height - 1, predicted.y.round() + half);
  final downsample = math.max(1, (expectedModule / 3).round());
  final width = math.max(1, (x1 - x0 + 1) ~/ downsample);
  final height = math.max(1, (y1 - y0 + 1) ~/ downsample);
  final values = Float32List(width * height);
  var low = 255.0, high = 0.0;
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var sum = 0.0, count = 0;
      for (var dy = 0; dy < downsample; dy++) {
        for (var dx = 0; dx < downsample; dx++) {
          final px = x0 + x * downsample + dx;
          final py = y0 + y * downsample + dy;
          if (px <= x1 && py <= y1) {
            sum += image.at(px, py);
            count++;
          }
        }
      }
      final value = count == 0 ? 0.0 : sum / count;
      values[y * width + x] = value;
      low = math.min(low, value);
      high = math.max(high, value);
    }
  }
  final threshold = (low + high) / 2;
  final expected = expectedModule / downsample;
  var sumX = 0.0, sumY = 0.0, sumModule = 0.0, hits = 0;
  void add(double x, double y, double module) {
    sumX += x;
    sumY += y;
    sumModule += module;
    hits++;
  }

  for (var y = 0; y < height; y++) {
    _scanFinderLine(
      (x) => values[y * width + x] < threshold,
      width,
      expected * 0.3,
      expected * 3,
      (center, module) => add(
        x0 + center * downsample,
        (y0 + y * downsample).toDouble(),
        module * downsample,
      ),
    );
  }
  for (var x = 0; x < width; x++) {
    _scanFinderLine(
      (y) => values[y * width + x] < threshold,
      height,
      expected * 0.3,
      expected * 3,
      (center, module) => add(
        (x0 + x * downsample).toDouble(),
        y0 + center * downsample,
        module * downsample,
      ),
    );
  }
  final minimumHits = math.max(4, expected.round());
  return _FinderHit(
    hits == 0 ? predicted : math.Point<double>(sumX / hits, sumY / hits),
    hits == 0 ? 0 : sumModule / hits,
    hits,
    hits >= minimumHits,
  );
}

MatrixRect _refineWithFinders(LumaPlane image, MatrixRect coarse) {
  final corners = <math.Point<double>>[
    coarse.topLeft!,
    coarse.topRight!,
    coarse.bottomRight!,
    coarse.bottomLeft!,
  ];
  const frameRatio = 0.07;
  final framePixels =
      math.min(coarse.width, coarse.height) * frameRatio / (1 + 2 * frameRatio);
  if (framePixels < 8) return coarse;
  math.Point<double> project(double u, double v) {
    final p0 = corners[0], p1 = corners[1], p2 = corners[2], p3 = corners[3];
    return math.Point<double>(
      p0.x * (1 - u) * (1 - v) +
          p1.x * u * (1 - v) +
          p2.x * u * v +
          p3.x * (1 - u) * v,
      p0.y * (1 - u) * (1 - v) +
          p1.y * u * (1 - v) +
          p2.y * u * v +
          p3.y * (1 - u) * v,
    );
  }

  final insetX = framePixels / (2 * math.max(1, coarse.width));
  final insetY = framePixels / (2 * math.max(1, coarse.height));
  final predicted = <math.Point<double>>[
    project(insetX, insetY),
    project(1 - insetX, insetY),
    project(1 - insetX, 1 - insetY),
    project(insetX, 1 - insetY),
  ];
  final hits = predicted
      .map((p) => _findFinderNear(image, p, framePixels))
      .toList();
  final found = hits.where((h) => h.ok).length;
  if (found < 3) return coarse;
  final centers = List<math.Point<double>>.generate(4, (i) => hits[i].point);
  if (found == 3) {
    final missing = hits.indexWhere((h) => !h.ok);
    centers[missing] = math.Point<double>(
      centers[(missing + 1) % 4].x +
          centers[(missing + 3) % 4].x -
          centers[(missing + 2) % 4].x,
      centers[(missing + 1) % 4].y +
          centers[(missing + 3) % 4].y -
          centers[(missing + 2) % 4].y,
    );
  }
  final module =
      hits.where((h) => h.ok).fold<double>(0, (s, h) => s + h.moduleSize) /
      found;
  math.Point<double>? unit(math.Point<double> p) {
    final length = math.sqrt(p.x * p.x + p.y * p.y);
    if (!length.isFinite ||
        length < math.min(coarse.width, coarse.height) * 0.35) {
      return null;
    }
    return math.Point<double>(p.x / length, p.y / length);
  }

  final u = unit(centers[1] - centers[0]);
  final v = unit(centers[3] - centers[0]);
  if (u == null || v == null || !module.isFinite || module <= 0) return coarse;
  final step = 5 * module;
  final tl = centers[0] - (u + v) * step;
  final tr = centers[1] + (u - v) * step;
  final br = centers[2] + (u + v) * step;
  final bl = centers[3] + (math.Point<double>(-u.x, -u.y) + v) * step;
  final minX = math.min(math.min(tl.x, tr.x), math.min(br.x, bl.x));
  final maxX = math.max(math.max(tl.x, tr.x), math.max(br.x, bl.x));
  final minY = math.min(math.min(tl.y, tr.y), math.min(br.y, bl.y));
  final maxY = math.max(math.max(tl.y, tr.y), math.max(br.y, bl.y));
  return MatrixRect(
    left: minX,
    top: minY,
    width: maxX - minX,
    height: maxY - minY,
    topLeft: tl,
    topRight: tr,
    bottomRight: br,
    bottomLeft: bl,
    refined: true,
  );
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

(double, double)? _fitLine(List<math.Point<double>> points) {
  if (points.length < 4) return null;
  var sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0;
  for (final point in points) {
    sx += point.x;
    sy += point.y;
    sxx += point.x * point.x;
    sxy += point.x * point.y;
  }
  final n = points.length.toDouble();
  final denominator = n * sxx - sx * sx;
  if (denominator.abs() < 1e-6) return null;
  final slope = (n * sxy - sx * sy) / denominator;
  return (slope, (sy - slope * sx) / n);
}

math.Point<double>? _intersectBoundaryLines(
  (double, double)? vertical,
  (double, double)? horizontal,
) {
  if (vertical == null || horizontal == null) return null;
  // vertical is x=a*y+b; horizontal is y=c*x+d.
  final denominator = 1 - vertical.$1 * horizontal.$1;
  if (denominator.abs() < 1e-6) return null;
  final x = (vertical.$1 * horizontal.$2 + vertical.$2) / denominator;
  return math.Point<double>(x, horizontal.$1 * x + horizontal.$2);
}

/// Fit the four long black frame edges instead of using a single extreme dark
/// pixel for each corner. QR finder white rings deliberately interrupt the
/// corner pixels, so the old extrema shifted the 72x72 sampling homography by
/// roughly a cell under a tilted phone even though the barcode occasionally
/// locked. Central edge runs stay solid and provide a much stabler quadrilateral.
List<math.Point<double>>? _fitFrameCorners(
  Int32List component,
  int count,
  int sampleWidth,
  int minX,
  int maxX,
  int minY,
  int maxY,
) {
  final rows = maxY - minY + 1;
  final columns = maxX - minX + 1;
  final rowMin = Int32List(rows)..fillRange(0, rows, maxX + 1);
  final rowMax = Int32List(rows)..fillRange(0, rows, -1);
  final columnMin = Int32List(columns)..fillRange(0, columns, maxY + 1);
  final columnMax = Int32List(columns)..fillRange(0, columns, -1);
  for (var i = 0; i < count; i++) {
    final point = component[i];
    final x = point % sampleWidth;
    final y = point ~/ sampleWidth;
    final row = y - minY;
    final column = x - minX;
    rowMin[row] = math.min(rowMin[row], x);
    rowMax[row] = math.max(rowMax[row], x);
    columnMin[column] = math.min(columnMin[column], y);
    columnMax[column] = math.max(columnMax[column], y);
  }
  final xInset = math.max(2, (columns * 0.16).round());
  final yInset = math.max(2, (rows * 0.16).round());
  final top = <math.Point<double>>[];
  final bottom = <math.Point<double>>[];
  for (var column = xInset; column < columns - xInset; column++) {
    if (columnMin[column] <= maxY) {
      top.add(
        math.Point<double>(
          (minX + column).toDouble(),
          columnMin[column].toDouble(),
        ),
      );
    }
    if (columnMax[column] >= minY) {
      bottom.add(
        math.Point<double>(
          (minX + column).toDouble(),
          columnMax[column].toDouble(),
        ),
      );
    }
  }
  final left = <math.Point<double>>[];
  final right = <math.Point<double>>[];
  for (var row = yInset; row < rows - yInset; row++) {
    if (rowMin[row] <= maxX) {
      left.add(
        math.Point<double>((minY + row).toDouble(), rowMin[row].toDouble()),
      );
    }
    if (rowMax[row] >= minX) {
      right.add(
        math.Point<double>((minY + row).toDouble(), rowMax[row].toDouble()),
      );
    }
  }
  final topLine = _fitLine(top);
  final bottomLine = _fitLine(bottom);
  final leftLine = _fitLine(left);
  final rightLine = _fitLine(right);
  final tl = _intersectBoundaryLines(leftLine, topLine);
  final tr = _intersectBoundaryLines(rightLine, topLine);
  final br = _intersectBoundaryLines(rightLine, bottomLine);
  final bl = _intersectBoundaryLines(leftLine, bottomLine);
  if (tl == null || tr == null || br == null || bl == null) return null;
  return <math.Point<double>>[tl, tr, br, bl];
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
    var minSum = double.infinity, maxSum = double.negativeInfinity;
    var minDiff = double.infinity, maxDiff = double.negativeInfinity;
    var tlX = 0, tlY = 0, trX = 0, trY = 0, brX = 0, brY = 0, blX = 0, blY = 0;
    while (read < write) {
      final point = queue[read++];
      final x = point % sampleWidth;
      final y = point ~/ sampleWidth;
      minX = math.min(minX, x);
      maxX = math.max(maxX, x);
      minY = math.min(minY, y);
      maxY = math.max(maxY, y);
      final sum = (x + y).toDouble();
      final diff = (x - y).toDouble();
      if (sum < minSum) {
        minSum = sum;
        tlX = x;
        tlY = y;
      }
      if (sum > maxSum) {
        maxSum = sum;
        brX = x;
        brY = y;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        trX = x;
        trY = y;
      }
      if (diff < minDiff) {
        minDiff = diff;
        blX = x;
        blY = y;
      }
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
    final fitted = _fitFrameCorners(
      queue,
      write,
      sampleWidth,
      minX,
      maxX,
      minY,
      maxY,
    );
    final fittedTl = fitted?[0];
    final fittedTr = fitted?[1];
    final fittedBr = fitted?[2];
    final fittedBl = fitted?[3];
    candidates.add((
      score,
      MatrixRect(
        left: minX * sx,
        top: minY * sy,
        width: width * sx,
        height: height * sy,
        topLeft: math.Point<double>(
          (fittedTl?.x ?? tlX) * sx,
          (fittedTl?.y ?? tlY) * sy,
        ),
        topRight: math.Point<double>(
          (fittedTr?.x ?? trX) * sx,
          (fittedTr?.y ?? trY) * sy,
        ),
        bottomRight: math.Point<double>(
          (fittedBr?.x ?? brX) * sx,
          (fittedBr?.y ?? brY) * sy,
        ),
        bottomLeft: math.Point<double>(
          (fittedBl?.x ?? blX) * sx,
          (fittedBl?.y ?? blY) * sy,
        ),
      ),
    ));
  }
  candidates.sort((a, b) => b.$1.compareTo(a.$1));
  final selected = candidates
      .take(maxCount)
      .map((value) => _refineWithFinders(image, value.$2))
      .toList();
  // Sender layouts are always two columns and up to three rows. Preserve that
  // visual lane order (L0/L1 on the first row, then the rows below) so timing
  // fallback and worker affinity remain deterministic before row 2 locks.
  selected.sort((a, b) {
    final ay = a.top + a.height / 2;
    final by = b.top + b.height / 2;
    final sameRow = (ay - by).abs() < math.min(a.height, b.height) * 0.45;
    return sameRow ? a.left.compareTo(b.left) : ay.compareTo(by);
  });
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
  final cellSize = outer.dataCellSize(gridWidth, gridHeight);
  return List<double>.generate(gridWidth, (x) {
    final point = outer.mapData(
      (x + 0.5) / gridWidth,
      (row + 0.5) / gridHeight,
    );
    return _sampleWindow(image, point.x, point.y, cellSize);
  });
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
  final cellSize = outer.dataCellSize(gridWidth, gridHeight);
  return List<double>.generate(gridWidth, (x) {
    final point = outer.mapData((x + 0.5) / gridWidth, 0.5 / gridHeight);
    return _sampleWindow(image, point.x, point.y, cellSize);
  });
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
        (decoded.version == barcodeVersion || decoded.version == 3) &&
        (decoded.gridWidth == 0 || decoded.gridWidth == width)) {
      return decoded;
    }
  }
  return null;
}
