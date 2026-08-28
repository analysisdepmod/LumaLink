import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
  test('round-trips the GridData v1 barcode at a 64-cell width', () {
    const source = BarcodeData(
      encoding: GridEncoding.color8,
      rate: 0.65,
      zones: false,
      gridWidth: 64,
      gridHeight: 64,
    );
    final encoded = encodeBarcodeRow(source, source.gridWidth);
    final luminance = <double>[
      for (var cell = 0; cell < source.gridWidth; cell++) encoded[cell * 3].toDouble(),
    ];

    final decoded = decodeBarcodeLuminance(luminance);

    expect(decoded, isNotNull);
    expect(decoded!.version, barcodeVersion);
    expect(decoded.encoding, source.encoding);
    expect(decoded.rate, source.rate);
    expect(decoded.gridWidth, source.gridWidth);
    expect(decoded.gridHeight, source.gridHeight);
  });

  test('rejects a barcode with a corrupted CRC', () {
    const source = BarcodeData(
      encoding: GridEncoding.color16,
      rate: 0.675,
      zones: false,
      gridWidth: 64,
      gridHeight: 64,
    );
    final encoded = encodeBarcodeRow(source, source.gridWidth);
    final luminance = <double>[
      for (var cell = 0; cell < source.gridWidth; cell++) encoded[cell * 3].toDouble(),
    ];
    // Flip both cells of one data bar (not merely one physical cell). This
    // simulates an actual wrong bit after the receiver averages the pair.
    luminance[10] = 0;
    luminance[11] = 0;

    expect(decodeBarcodeLuminance(luminance), isNull);
  });
}
