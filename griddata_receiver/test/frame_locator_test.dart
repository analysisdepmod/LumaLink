import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/frame_locator.dart';

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
}
