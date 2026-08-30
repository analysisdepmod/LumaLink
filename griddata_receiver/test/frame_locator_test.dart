import 'dart:typed_data';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/frame_locator.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
  test('finds an outer dark GridData frame in a camera-like luma plane', () {
    const width = 320;
    const height = 240;
    final pixels = Uint8List(width * height)..fillRange(0, width * height, 220);
    for (var y = 40; y < 200; y++) {
      for (var x = 80; x < 240; x++) {
        final border = x < 92 || x >= 228 || y < 52 || y >= 188;
        pixels[y * width + x] = border ? 8 : 150;
      }
    }
    final actual = locateOuterFrame(
      LumaPlane(
        width: width,
        height: height,
        bytes: pixels,
        bytesPerRow: width,
      ),
    );

    expect(actual, isNotNull);
    expect(actual!.left, closeTo(80, 8));
    expect(actual.top, closeTo(40, 8));
    expect(actual.width, closeTo(160, 12));
    expect(actual.height, closeTo(160, 12));
  });

  test('perspective projection keeps a tilted 72-cell barcode aligned', () {
    const width = 320, height = 260;
    final pixels = Uint8List(width * height)..fillRange(0, width * height, 127);
    const outer = MatrixRect(
      left: 30,
      top: 20,
      width: 240,
      height: 200,
      topLeft: math.Point<double>(30, 20),
      topRight: math.Point<double>(270, 40),
      bottomRight: math.Point<double>(250, 220),
      bottomLeft: math.Point<double>(50, 210),
    );
    const barcode = BarcodeData(
      encoding: GridEncoding.color8,
      rate: 0.625,
      zones: false,
      gridWidth: 72,
      gridHeight: 72,
      lanes: 2,
    );
    final encoded = encodeBarcodeRow(barcode, 72);
    for (var cell = 0; cell < 72; cell++) {
      final point = outer.mapData((cell + 0.5) / 72, 0.5 / 72);
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          pixels[(point.y.round() + dy) * width + point.x.round() + dx] =
              encoded[cell * 3];
        }
      }
    }
    final plane = LumaPlane(
      width: width,
      height: height,
      bytes: pixels,
      bytesPerRow: width,
    );
    final decoded = decodeBarcodeLuminance(
      sampleBarcodeLuma(plane, outer, 72, 72),
    );
    expect(decoded?.gridWidth, 72);
    expect(decoded?.lanes, 2);
    expect(decoded?.rate, 0.625);
  });
}
