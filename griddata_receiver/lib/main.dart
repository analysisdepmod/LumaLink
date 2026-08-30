import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import 'protocol/color8.dart';
import 'protocol/frame_codec.dart';
import 'protocol/frame_locator.dart';
import 'protocol/fountain_decoder.dart';
import 'protocol/meta_barcode.dart';
import 'protocol/multicolor.dart';
import 'protocol/transfer_manifest.dart';
import 'protocol/yuv_sampler.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final cameras = await availableCameras();
  runApp(GridDataReceiverApp(cameras: cameras));
}

class GridDataReceiverApp extends StatelessWidget {
  const GridDataReceiverApp({super.key, required this.cameras});
  final List<CameraDescription> cameras;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff19d7c5),
        brightness: Brightness.dark,
      ),
      useMaterial3: true,
    ),
    home: ReceiverScreen(cameras: cameras),
  );
}

class ReceiverScreen extends StatefulWidget {
  const ReceiverScreen({super.key, required this.cameras});
  final List<CameraDescription> cameras;

  @override
  State<ReceiverScreen> createState() => _ReceiverScreenState();
}

class _ReceiverScreenState extends State<ReceiverScreen>
    with WidgetsBindingObserver {
  CameraController? _camera;
  String _state = 'جاري تشغيل الكاميرا…';
  double _captureFps = 0;
  double _decodeMs = 0;
  double _senderFps = 12;
  int _validFrames = 0;
  int _windowFrames = 0;
  int _nextDecodeUs = 0;
  DateTime _windowStarted = DateTime.now();
  bool _busy = false;
  bool _torch = false;
  final List<BarcodeData?> _barcodes = <BarcodeData?>[null, null];
  final List<int> _lastTicks = <int>[-1, -1];
  final ManifestAssembler _manifestAssembler = ManifestAssembler();
  TransferManifest? _manifest;
  FountainDecoder? _fountain;
  bool _savingTransfer = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_openCamera());
  }

  Future<void> _openCamera() async {
    final rear = widget.cameras.where(
      (camera) => camera.lensDirection == CameraLensDirection.back,
    );
    final description = rear.isNotEmpty
        ? rear.first
        : (widget.cameras.isEmpty ? null : widget.cameras.first);
    if (description == null) {
      if (mounted) setState(() => _state = 'لم يتم العثور على كاميرا');
      return;
    }
    final controller = CameraController(
      description,
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.yuv420,
    );
    try {
      await controller.initialize();
      await controller.setFocusMode(FocusMode.auto);
      await controller.setExposureMode(ExposureMode.auto);
      await controller.startImageStream(_onFrame);
      if (!mounted) return;
      setState(() {
        _camera = controller;
        _state = 'وجّه الكاميرا نحو مصفوفتَي LumaLink';
      });
    } on CameraException catch (error) {
      await controller.dispose();
      if (mounted) setState(() => _state = 'خطأ الكاميرا: ${error.code}');
    }
  }

  void _onFrame(CameraImage image) {
    if (_busy || image.planes.length < 3) return;
    final nowUs = DateTime.now().microsecondsSinceEpoch;
    _windowFrames++;
    final elapsed = DateTime.now().difference(_windowStarted).inMilliseconds;
    if (elapsed >= 500 && mounted) {
      setState(() => _captureFps = _windowFrames * 1000 / elapsed);
      _windowFrames = 0;
      _windowStarted = DateTime.now();
    }
    // Synchronize native capture with the sender's CRC-protected timing row.
    if (nowUs < _nextDecodeUs) return;
    _nextDecodeUs = nowUs + (1000000 / _senderFps.clamp(2, 30)).round();
    _busy = true;
    final watch = Stopwatch()..start();
    try {
      _decodeExposure(image);
    } finally {
      watch.stop();
      _decodeMs = watch.elapsedMicroseconds / 1000;
      _busy = false;
    }
  }

  void _decodeExposure(CameraImage image) {
    final frame = Yuv420Frame(
      width: image.width,
      height: image.height,
      y: image.planes[0].bytes,
      u: image.planes[1].bytes,
      v: image.planes[2].bytes,
      yRowStride: image.planes[0].bytesPerRow,
      uRowStride: image.planes[1].bytesPerRow,
      vRowStride: image.planes[2].bytesPerRow,
      uPixelStride: image.planes[1].bytesPerPixel ?? 1,
      vPixelStride: image.planes[2].bytesPerPixel ?? 1,
    );
    final outers = locateOuterFrames(frame.luma, maxCount: 2);
    if (outers.isEmpty) return;
    for (var visualIndex = 0; visualIndex < outers.length; visualIndex++) {
      final outer = outers[visualIndex];
      final found = locateBarcode(frame.luma, outer);
      final barcode = found ?? _barcodes[visualIndex];
      if (barcode == null || barcode.gridWidth == 0) continue;
      final timing = locateTimingBarcode(frame.luma, outer, barcode);
      final lane = timing?.lane ?? visualIndex.clamp(0, 1);
      _barcodes[lane] = barcode;
      if (timing != null) {
        if (_lastTicks[lane] == timing.tick) continue;
        _senderFps = timing.fps.clamp(2, 30);
      }
      final sampled = sampleColor8(frame, outer, barcode);
      final capacity = switch (barcode.encoding) {
        GridEncoding.bw => bwCapacityBytes(
          barcode.gridWidth,
          barcode.gridHeight,
        ),
        GridEncoding.color8 => color8CapacityBytes(
          barcode.gridWidth,
          barcode.gridHeight,
        ),
        _ => multiColorCapacityBytes(sampled, barcode.encoding),
      };
      final llr = switch (barcode.encoding) {
        GridEncoding.bw => softDemodulateBw(sampled),
        GridEncoding.color8 => softDemodulateColor8(sampled),
        _ => softDemodulateMultiColor(sampled, barcode.encoding),
      };
      final decoded = decodeFrameLlr(
        llr,
        capacity,
        barcode.rate,
        iterations:
            barcode.encoding == GridEncoding.color8 && barcode.gridWidth <= 72
            ? 12
            : 16,
      );
      if (decoded == null) continue;
      if (timing != null) _lastTicks[lane] = timing.tick;
      _validFrames++;
      _acceptFrame(decoded, barcode);
    }
    if (mounted && _manifest == null) {
      setState(
        () => _state = _barcodes.any((value) => value != null)
            ? 'تم القفل على المصفوفة — جاري استلام معلومات الملف'
            : 'جاري البحث عن المصفوفة',
      );
    }
  }

  void _acceptFrame(DecodedFrame frame, BarcodeData barcode) {
    if (frame.type == frameManifest) {
      final manifest = _manifestAssembler.add(frame.payload, optical: barcode);
      if (manifest == null || _manifest?.id == manifest.id) return;
      _manifest = manifest;
      _fountain = FountainDecoder(
        manifest.k,
        manifest.chunkSize,
        mediumWideEvery: manifest.version == 8 ? 1 : (manifest.version >= 9 ? 2 : 4),
      );
      if (manifest.senderFps != null)
        _senderFps = manifest.senderFps!.clamp(2, 30);
      if (mounted) setState(() => _state = 'بدأ الاستلام: ${manifest.name}');
      return;
    }
    if (frame.type != frameData) return;
    final manifest = _manifest;
    final fountain = _fountain;
    if (manifest == null || fountain == null || _savingTransfer) return;
    fountain.addFrame(frame.seed, frame.payload);
    if (mounted) setState(() => _state = 'استلام ${manifest.name}');
    if (fountain.isComplete) {
      _savingTransfer = true;
      unawaited(_finish(fountain, manifest));
    }
  }

  Future<void> _finish(
    FountainDecoder fountain,
    TransferManifest manifest,
  ) async {
    try {
      final bytes = await finishTransfer(fountain.reconstruct(), manifest);
      final file = await saveTransfer(bytes, manifest);
      if (mounted)
        setState(() => _state = 'اكتمل النقل وتحقق SHA-256\n${file.path}');
    } catch (error) {
      if (mounted) setState(() => _state = 'فشل التحقق: $error');
    } finally {
      _savingTransfer = false;
    }
  }

  Future<void> _toggleTorch() async {
    final camera = _camera;
    if (camera == null) return;
    _torch = !_torch;
    await camera.setFlashMode(_torch ? FlashMode.torch : FlashMode.off);
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) {
      unawaited(_camera?.dispose());
      _camera = null;
    } else if (state == AppLifecycleState.resumed && _camera == null) {
      unawaited(_openCamera());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_camera?.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final camera = _camera;
    final fountain = _fountain;
    final progress = fountain == null || _manifest == null
        ? 0.0
        : fountain.uniqueChunks / _manifest!.k;
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          fit: StackFit.expand,
          children: [
            if (camera != null && camera.value.isInitialized)
              CameraPreview(camera)
            else
              const ColoredBox(color: Colors.black),
            SafeArea(
              child: Column(
                children: [
                  _Header(onTorch: _toggleTorch, torch: _torch),
                  const Spacer(),
                  _StatusCard(
                    state: _state,
                    progress: progress,
                    chunks: fountain?.uniqueChunks ?? 0,
                    total: _manifest?.k ?? 0,
                    equations: fountain?.receivedEquations ?? 0,
                    validFrames: _validFrames,
                    captureFps: _captureFps,
                    senderFps: _senderFps,
                    decodeMs: _decodeMs,
                    turbo: _barcodes.any((value) => value?.lanes == 2),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onTorch, required this.torch});
  final VoidCallback onTorch;
  final bool torch;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.all(12),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(
      color: const Color(0xe60a1924),
      borderRadius: BorderRadius.circular(18),
    ),
    child: Row(
      children: [
        Image.asset('assets/directorate_logo.png', width: 46, height: 46),
        const SizedBox(width: 10),
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'LumaLink',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                  color: Color(0xff65f1df),
                ),
              ),
              Text(
                'المستقبل البصري الأصلي',
                style: TextStyle(fontSize: 12, color: Colors.white70),
              ),
            ],
          ),
        ),
        IconButton(
          onPressed: onTorch,
          icon: Icon(torch ? Icons.flashlight_on : Icons.flashlight_off),
        ),
      ],
    ),
  );
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.state,
    required this.progress,
    required this.chunks,
    required this.total,
    required this.equations,
    required this.validFrames,
    required this.captureFps,
    required this.senderFps,
    required this.decodeMs,
    required this.turbo,
  });
  final String state;
  final double progress;
  final int chunks, total, equations, validFrames;
  final double captureFps, senderFps, decodeMs;
  final bool turbo;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.all(12),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: const Color(0xee071722),
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: const Color(0x884de4d0)),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          state,
          textAlign: TextAlign.center,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        if (total > 0) ...[
          const SizedBox(height: 12),
          LinearProgressIndicator(
            value: progress.clamp(0, 1),
            minHeight: 9,
            borderRadius: BorderRadius.circular(9),
          ),
          const SizedBox(height: 7),
          Text(
            '${(progress * 100).toStringAsFixed(1)}%  •  $chunks / $total  •  $equations معادلة',
          ),
        ],
        const SizedBox(height: 10),
        Text(
          '${turbo ? 'Turbo ×2' : 'مسار واحد'}  •  إرسال ${senderFps.toStringAsFixed(1)}fps  •  كاميرا ${captureFps.toStringAsFixed(1)}fps',
        ),
        Text(
          'فك ${decodeMs.toStringAsFixed(0)}ms  •  إطارات صحيحة $validFrames',
          style: const TextStyle(color: Colors.white70, fontSize: 12),
        ),
      ],
    ),
  );
}
