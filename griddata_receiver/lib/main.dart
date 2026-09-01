import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'native_decode_worker.dart';
import 'protocol/frame_codec.dart';
import 'protocol/fountain_decoder.dart';
import 'protocol/meta_barcode.dart';
import 'protocol/transfer_manifest.dart';

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
  static const int _maxPendingDataFrames = 192;
  final List<BarcodeData?> _barcodes = <BarcodeData?>[null, null];
  final List<int> _lastTicks = <int>[-1, -1];
  final List<DecodedFrame> _pendingData = <DecodedFrame>[];
  ManifestAssembler _manifestAssembler = ManifestAssembler();
  TransferManifest? _manifest;
  FountainDecoder? _fountain;
  bool _savingTransfer = false;
  final ReceivePort _decodeReplies = ReceivePort();
  SendPort? _decodeRequests;
  Isolate? _decodeIsolate;
  int _decodeRequestId = 0;
  String? _decoderError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_startDecoder());
    unawaited(_openCamera());
  }

  Future<void> _startDecoder() async {
    _decodeReplies.listen(_onDecodeMessage);
    _decodeIsolate = await Isolate.spawn(
      nativeDecodeWorkerEntry,
      _decodeReplies.sendPort,
      debugName: 'LumaLink native optical decoder',
    );
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
    _windowFrames++;
    final elapsed = DateTime.now().difference(_windowStarted).inMilliseconds;
    if (elapsed >= 500 && mounted) {
      setState(() => _captureFps = _windowFrames * 1000 / elapsed);
      _windowFrames = 0;
      _windowStarted = DateTime.now();
    }
    final decoder = _decodeRequests;
    if (_busy || decoder == null || image.planes.length < 3) return;
    final nowUs = DateTime.now().microsecondsSinceEpoch;
    // Synchronize native capture with the sender's CRC-protected timing row.
    if (nowUs < _nextDecodeUs) return;
    _nextDecodeUs = nowUs + (1000000 / _senderFps.clamp(2, 30)).round();
    _busy = true;
    decoder.send(<String, Object?>{
      'id': ++_decodeRequestId,
      'width': image.width,
      'height': image.height,
      'y': TransferableTypedData.fromList(<Uint8List>[image.planes[0].bytes]),
      'u': TransferableTypedData.fromList(<Uint8List>[image.planes[1].bytes]),
      'v': TransferableTypedData.fromList(<Uint8List>[image.planes[2].bytes]),
      'yRowStride': image.planes[0].bytesPerRow,
      'uRowStride': image.planes[1].bytesPerRow,
      'vRowStride': image.planes[2].bytesPerRow,
      'uPixelStride': image.planes[1].bytesPerPixel ?? 1,
      'vPixelStride': image.planes[2].bytesPerPixel ?? 1,
      'barcodes': _barcodes
          .map((value) => value == null ? null : barcodeToMessage(value))
          .toList(),
      'lastTicks': List<int>.from(_lastTicks),
    });
  }

  void _onDecodeMessage(Object? message) {
    if (message is SendPort) {
      _decodeRequests = message;
      return;
    }
    if (message is! Map) return;
    _busy = false;
    _decodeMs = (message['ms'] as num?)?.toDouble() ?? 0;
    final workerError = message['error'];
    if (workerError is String && workerError.isNotEmpty) {
      _decoderError = workerError;
    }
    final results = message['results'] as List? ?? const <Object?>[];
    for (final value in results) {
      if (value is! Map || value['lane'] is! int) continue;
      final lane = value['lane'] as int;
      if (lane < 0 || lane > 1) continue;
      final barcode = barcodeFromMessage(value['barcode']);
      if (barcode == null) continue;
      _barcodes[lane] = barcode;
      final fps = value['fps'];
      if (fps is num) _senderFps = fps.toDouble().clamp(2, 30);
      if (value['duplicate'] == true) continue;
      final type = value['type'];
      final seed = value['seed'];
      final payload = value['payload'];
      if (type is! int || seed is! int || payload is! TransferableTypedData)
        continue;
      final tick = value['tick'];
      if (tick is int) _lastTicks[lane] = tick;
      _validFrames++;
      _decoderError = null;
      _acceptFrame(
        DecodedFrame(
          type: type,
          seed: seed,
          payload: payload.materialize().asUint8List(),
        ),
        barcode,
      );
    }
    if (mounted && _manifest == null) {
      setState(
        () => _state = message['locked'] == true
            ? 'تم القفل على المصفوفة — جاري استلام معلومات الملف'
            : 'جاري البحث عن المصفوفة',
      );
    } else if (mounted) {
      setState(() {});
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
        mediumWideEvery: manifest.version == 8
            ? 1
            : (manifest.version >= 9 ? 2 : 4),
      );
      if (manifest.senderFps != null)
        _senderFps = manifest.senderFps!.clamp(2, 30);
      // Turbo can deliver valid data while the receiver is still assembling
      // the repeated manifest. Keep those frames and replay them immediately;
      // dropping them made the phone look completely idle with short files and
      // unnecessarily delayed every larger transfer.
      final earlyFrames = List<DecodedFrame>.from(_pendingData);
      _pendingData.clear();
      for (final early in earlyFrames) {
        _fountain!.addFrame(early.seed, early.payload);
      }
      if (mounted) {
        setState(
          () => _state = earlyFrames.isEmpty
              ? 'بدأ الاستلام: ${manifest.name}'
              : 'بدأ الاستلام: ${manifest.name} — استُعيدت ${earlyFrames.length} حزمة مبكرة',
        );
      }
      if (_fountain!.isComplete) {
        _savingTransfer = true;
        unawaited(_finish(_fountain!, manifest));
      }
      return;
    }
    if (frame.type != frameData) return;
    final manifest = _manifest;
    final fountain = _fountain;
    if (manifest == null || fountain == null) {
      if (_pendingData.length < _maxPendingDataFrames) {
        _pendingData.add(frame);
      }
      return;
    }
    if (_savingTransfer) return;
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
      final camera = _camera;
      if (camera != null && camera.value.isStreamingImages) {
        await camera.stopImageStream();
      }
      if (mounted) {
        setState(() => _state = 'تم استلام كل الحزم\nجاري فك الضغط والتحقق…');
      }
      await Future<void>.delayed(Duration.zero);
      final reconstructed = fountain.reconstruct();
      final bytes = await Isolate.run(
        () => finishTransfer(reconstructed, manifest),
      );
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

  Future<void> _restartReception() async {
    setState(() {
      _manifestAssembler = ManifestAssembler();
      _manifest = null;
      _fountain = null;
      _pendingData.clear();
      _barcodes
        ..clear()
        ..addAll(<BarcodeData?>[null, null]);
      _lastTicks
        ..clear()
        ..addAll(<int>[-1, -1]);
      _validFrames = 0;
      _savingTransfer = false;
      _decoderError = null;
      _state = 'وجّه الكاميرا نحو مصفوفتَي LumaLink';
    });
    final camera = _camera;
    if (camera != null &&
        camera.value.isInitialized &&
        !camera.value.isStreamingImages) {
      await camera.startImageStream(_onFrame);
    }
  }

  Future<void> _exitApp() async {
    await _camera?.dispose();
    _camera = null;
    await SystemNavigator.pop();
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
    _decodeIsolate?.kill(priority: Isolate.immediate);
    _decodeReplies.close();
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
                  _Header(
                    onTorch: _toggleTorch,
                    onReset: _restartReception,
                    onExit: _exitApp,
                    torch: _torch,
                  ),
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
                    bufferedFrames: _pendingData.length,
                    decoderError: _decoderError,
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
  const _Header({
    required this.onTorch,
    required this.onReset,
    required this.onExit,
    required this.torch,
  });
  final VoidCallback onTorch;
  final VoidCallback onReset;
  final VoidCallback onExit;
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
          tooltip: 'المصباح',
          icon: Icon(torch ? Icons.flashlight_on : Icons.flashlight_off),
        ),
        IconButton(
          onPressed: onReset,
          tooltip: 'إعادة الاستقبال',
          icon: const Icon(Icons.refresh),
        ),
        IconButton(
          onPressed: onExit,
          tooltip: 'خروج',
          icon: const Icon(Icons.close),
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
    required this.bufferedFrames,
    required this.decoderError,
  });
  final String state;
  final double progress;
  final int chunks, total, equations, validFrames;
  final double captureFps, senderFps, decodeMs;
  final bool turbo;
  final int bufferedFrames;
  final String? decoderError;

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
        if (total == 0 && bufferedFrames > 0)
          Text(
            'حزم بيانات محفوظة بانتظار معلومات الملف: $bufferedFrames',
            style: const TextStyle(color: Color(0xffffd166), fontSize: 12),
          ),
        if (decoderError != null)
          Text(
            'خطأ فك الترميز: $decoderError',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xffff7b7b), fontSize: 11),
          ),
      ],
    ),
  );
}
