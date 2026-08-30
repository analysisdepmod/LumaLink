import 'dart:math' as math;
import 'dart:typed_data';

import 'color8.dart';
import 'frame_locator.dart';
import 'meta_barcode.dart';

class Yuv420Frame {
  const Yuv420Frame({
    required this.width,
    required this.height,
    required this.y,
    required this.u,
    required this.v,
    required this.yRowStride,
    required this.uRowStride,
    required this.vRowStride,
    required this.uPixelStride,
    required this.vPixelStride,
  });

  final int width;
  final int height;
  final Uint8List y;
  final Uint8List u;
  final Uint8List v;
  final int yRowStride;
  final int uRowStride;
  final int vRowStride;
  final int uPixelStride;
  final int vPixelStride;

  LumaPlane get luma => LumaPlane(
    width: width,
    height: height,
    bytes: y,
    bytesPerRow: yRowStride,
  );

  (double, double, double) rgbAt(int x, int yPos) {
    final safeX = x < 0 ? 0 : (x >= width ? width - 1 : x);
    final safeY = yPos < 0 ? 0 : (yPos >= height ? height - 1 : yPos);
    final yy = y[safeY * yRowStride + safeX];
    final ux = safeX ~/ 2;
    final uy = safeY ~/ 2;
    final uu = u[uy * uRowStride + ux * uPixelStride];
    final vv = v[uy * vRowStride + ux * vPixelStride];
    final c = yy - 16;
    final d = uu - 128;
    final e = vv - 128;
    final red = (1.164 * c + 1.596 * e).clamp(0, 255).toDouble();
    final green = (1.164 * c - 0.392 * d - 0.813 * e).clamp(0, 255).toDouble();
    final blue = (1.164 * c + 2.017 * d).clamp(0, 255).toDouble();
    return (red, green, blue);
  }
}

/// Samples a located Color8 matrix without allocating a full RGB camera bitmap.
/// Android's YUV planes stay native until only the 64×64 cell centres are read.
Color8Grid sampleColor8(
  Yuv420Frame image,
  MatrixRect outer,
  BarcodeData barcode,
) {
  final data = outer.dataRegion;
  final cells = barcode.gridWidth * barcode.gridHeight;
  final red = Float32List(cells);
  final green = Float32List(cells);
  final blue = Float32List(cells);
  final reliability = Float32List(cells);
  final cellWidth = data.width / barcode.gridWidth;
  final cellHeight = data.height / barcode.gridHeight;
  // Fast 64/72 profile: a bounded 3×3 centre sample avoids mixing neighbouring
  // colours and cuts YUV work sharply on mobile CPUs.
  final radius = math
      .min(1, math.max(0, math.min(cellWidth, cellHeight).floor() ~/ 4))
      .toInt();
  for (var gy = 0; gy < barcode.gridHeight; gy++) {
    for (var gx = 0; gx < barcode.gridWidth; gx++) {
      final centreX = data.left + (gx + 0.5) * cellWidth;
      final centreY = data.top + (gy + 0.5) * cellHeight;
      var sr = 0.0;
      var sg = 0.0;
      var sb = 0.0;
      var sl = 0.0;
      var sl2 = 0.0;
      var count = 0;
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          final rgb = image.rgbAt(
            (centreX + dx).round(),
            (centreY + dy).round(),
          );
          sr += rgb.$1;
          sg += rgb.$2;
          sb += rgb.$3;
          final luminance = rgb.$1 * 0.299 + rgb.$2 * 0.587 + rgb.$3 * 0.114;
          sl += luminance;
          sl2 += luminance * luminance;
          count++;
        }
      }
      final index = gy * barcode.gridWidth + gx;
      red[index] = sr / count;
      green[index] = sg / count;
      blue[index] = sb / count;
      final variance = math.max(0, sl2 / count - (sl / count) * (sl / count));
      reliability[index] = 1 / (1 + variance / (28 * 28));
    }
  }
  return Color8Grid(
    gridWidth: barcode.gridWidth,
    gridHeight: barcode.gridHeight,
    red: red,
    green: green,
    blue: blue,
    reliability: reliability,
  );
}
