import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/color8.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';
import 'package:griddata_receiver/protocol/multicolor.dart';

void main() {
  test('Color16 anchor calibration produces valid soft bit directions', () {
    const width = 64;
    const height = 64;
    final cells = width * height;
    final red = Float32List(cells);
    final green = Float32List(cells);
    final blue = Float32List(cells);
    final reliability = Float32List(cells)..fillRange(0, cells, 1);
    var anchor = width * barcodeRows;
    // Color16 anchors: R(0,1), G(0..3), B(0,1).
    for (final value in [0, 255]) {
      red[anchor++] = value.toDouble();
    }
    for (final value in [0, 80, 170, 255]) {
      green[anchor++] = value.toDouble();
    }
    for (final value in [0, 255]) {
      blue[anchor++] = value.toDouble();
    }
    // Word bits: R=1, G=10 (physical level 3), B=0.
    red[anchor] = 255;
    green[anchor] = 255;
    blue[anchor] = 0;
    final grid = Color8Grid(
      gridWidth: width,
      gridHeight: height,
      red: red,
      green: green,
      blue: blue,
      reliability: reliability,
    );

    final llr = softDemodulateMultiColor(grid, GridEncoding.color16);

    expect(llr[0], lessThan(0));
    expect(llr[1], lessThan(0));
    expect(llr[2], greaterThan(0));
    expect(llr[3], greaterThan(0));
  });
}
