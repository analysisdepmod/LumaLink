import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/protocol/meta_barcode.dart';

void main() {
  test('round-trips the GridData v2 barcode at a 64-cell width', () {
    const source = BarcodeData(
      encoding: GridEncoding.color8,
      rate: 0.65,
      zones: false,
      gridWidth: 64,
      gridHeight: 64,
    );
    final encoded = encodeBarcodeRow(source, source.gridWidth);
    final luminance = <double>[
      for (var cell = 0; cell < source.gridWidth; cell++)
        encoded[cell * 3].toDouble(),
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
      for (var cell = 0; cell < source.gridWidth; cell++)
        encoded[cell * 3].toDouble(),
    ];
    // Flip both cells of one data bar (not merely one physical cell). This
    // simulates an actual wrong bit after the receiver averages the pair.
    luminance[10] = luminance[10] == 0 ? 255 : 0;
    luminance[11] = luminance[11] == 0 ? 255 : 0;

    expect(decodeBarcodeLuminance(luminance), isNull);
  });

  test('carries Turbo lane count and 0.625 rate at 72 cells', () {
    const source = BarcodeData(
      encoding: GridEncoding.color8,
      rate: 0.625,
      zones: false,
      gridWidth: 72,
      gridHeight: 72,
      lanes: 2,
    );
    final row = encodeBarcodeRow(source, 72);
    final decoded = decodeBarcodeLuminance([
      for (var cell = 0; cell < 72; cell++) row[cell * 3].toDouble(),
    ]);
    expect(decoded?.gridWidth, 72);
    expect(decoded?.gridHeight, 72);
    expect(decoded?.rate, 0.625);
    expect(decoded?.lanes, 2);
  });

  test('decodes sender fps, tick and physical lane', () {
    const timing = TimingBarcodeData(fps: 12, tick: 777, lane: 1);
    final row = encodeTimingBarcodeRow(timing, 72);
    final decoded = decodeTimingBarcodeLuminance([
      for (var cell = 0; cell < 72; cell++) row[cell * 3].toDouble(),
    ]);
    expect(decoded?.fps, 12);
    expect(decoded?.tick, 777);
    expect(decoded?.lane, 1);
  });
}
