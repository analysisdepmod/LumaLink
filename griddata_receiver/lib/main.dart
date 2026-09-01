import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'native_decode_worker.dart';
import 'protocol/frame_codec.dart';
import 'protocol/control_barcode.dart';
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
  static const MethodChannel _filesChannel = MethodChannel(
    'com.griddata.griddata_receiver/files',
  );
  CameraController? _camera;
  String _state = 'جاري تشغيل الكاميرا…';
  double _captureFps = 0;
  double _decodeMs = 0;
  double _senderFps = 12;
  int _validFrames = 0;
  int _windowFrames = 0;
  int _nextDecodeUs = 0;
  DateTime _windowStarted = DateTime.now();
  bool _torch = false;
  int _decoderWorkerCount = 0;
  int _deviceMemoryMb = 0;
  static const int _maxPendingDataFrames = 192;
  final List<BarcodeData?> _barcodes = List<BarcodeData?>.filled(6, null);
  final List<int> _lastTicks = List<int>.filled(6, -1);
  final List<DecodedFrame> _pendingData = <DecodedFrame>[];
  ManifestAssembler _manifestAssembler = ManifestAssembler();
  TransferControlAssembler _controlAssembler = TransferControlAssembler();
  TransferControl? _control;
  TransferManifest? _manifest;
  FountainDecoder? _fountain;
  bool _savingTransfer = false;
  final ReceivePort _decodeReplies = ReceivePort();
  final List<SendPort?> _decodeRequests = <SendPort?>[];
  final List<Isolate?> _decodeIsolates = <Isolate?>[];
  final List<bool> _decoderBusy = <bool>[];
  int _nextDecoderWorker = 0;
  int _decodeRequestId = 0;
  String? _decoderError;
  DateTime _lastDiagnosticLog = DateTime.fromMillisecondsSinceEpoch(0);
  File? _diagnosticFile;
  bool _diagnosticWritePending = false;
  DateTime? _lastSpeedSample;
  int _lastSpeedBytes = 0;
  int _receivedPayloadBytes = 0;
  double _transferBytesPerSecond = 0;
  File? _completedFile;
  bool _retainingFile = false;

  int get _activeLaneCount => _barcodes
      .whereType<BarcodeData>()
      .fold<int>(1, (count, barcode) => math.max(count, barcode.lanes))
      .clamp(1, 6);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_startDecoder());
    unawaited(_openCamera());
  }

  Future<void> _startDecoder() async {
    _decodeReplies.listen(_onDecodeMessage);
    final cores = Platform.numberOfProcessors;
    try {
      final memInfo = await File('/proc/meminfo').readAsString();
      final match = RegExp(r'MemTotal:\s+(\d+)\s+kB').firstMatch(memInfo);
      _deviceMemoryMb = (int.tryParse(match?.group(1) ?? '') ?? 0) ~/ 1024;
    } catch (_) {
      _deviceMemoryMb = 0;
    }
    _decoderWorkerCount = switch ((cores, _deviceMemoryMb)) {
      (>= 10, >= 8000) => 6,
      (>= 8, >= 5500) => 4,
      (>= 6, >= 3000) => 3,
      _ => 1,
    };
    _decodeRequests.addAll(List<SendPort?>.filled(_decoderWorkerCount, null));
    _decodeIsolates.addAll(List<Isolate?>.filled(_decoderWorkerCount, null));
    _decoderBusy.addAll(List<bool>.filled(_decoderWorkerCount, false));
    for (var workerId = 0; workerId < _decoderWorkerCount; workerId++) {
      _decodeIsolates[workerId] = await Isolate.spawn<Object>(
        nativeDecodeWorkerEntry,
        <String, Object?>{
          'parent': _decodeReplies.sendPort,
          'workerId': workerId,
        },
        debugName: 'LumaLink optical decoder ${workerId + 1}',
      );
    }
  }

  Future<void> _persistDiagnostic(String line) async {
    if (_diagnosticWritePending) return;
    _diagnosticWritePending = true;
    try {
      final file = _diagnosticFile ??= File(
        '${(await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory()).path}${Platform.pathSeparator}lumalink-receiver.jsonl',
      );
      if (await file.exists() && await file.length() > 4 * 1024 * 1024) {
        final previous = File('${file.path}.previous');
        if (await previous.exists()) await previous.delete();
        await file.rename(previous.path);
        _diagnosticFile = File(file.path);
      }
      await _diagnosticFile!.writeAsString(
        '${DateTime.now().toIso8601String()} $line\n',
        mode: FileMode.append,
        flush: false,
      );
    } catch (_) {
      // Diagnostics must never interrupt the optical receiver.
    } finally {
      _diagnosticWritePending = false;
    }
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
      ResolutionPreset.veryHigh,
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
        _state = 'وجّه الكاميرا نحو مصفوفات LumaLink';
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
    if (image.planes.length < 3) return;
    var workerId = -1;
    for (var offset = 0; offset < _decoderWorkerCount; offset++) {
      final candidate = (_nextDecoderWorker + offset) % _decoderWorkerCount;
      if (!_decoderBusy[candidate] && _decodeRequests[candidate] != null) {
        workerId = candidate;
        break;
      }
    }
    if (workerId < 0) return;
    final nowUs = DateTime.now().microsecondsSinceEpoch;
    // Feed every available decoder core. The CRC-protected timing row rejects
    // repeated camera looks at the same displayed frame.
    if (nowUs < _nextDecodeUs) return;
    _nextDecodeUs = nowUs + 30000;
    _decoderBusy[workerId] = true;
    _nextDecoderWorker = (workerId + 1) % _decoderWorkerCount;
    _decodeRequests[workerId]!.send(<String, Object?>{
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
      if (_barcodes.any((value) => (value?.lanes ?? 1) > 1))
        'preferredLane': _decodeRequestId % _activeLaneCount,
    });
  }

  void _onDecodeMessage(Object? message) {
    if (message is Map && message['ready'] == true) {
      final workerId = message['workerId'];
      final port = message['port'];
      if (workerId is int &&
          workerId >= 0 &&
          workerId < _decoderWorkerCount &&
          port is SendPort) {
        _decodeRequests[workerId] = port;
      }
      return;
    }
    if (message is! Map) return;
    final workerId = message['workerId'];
    if (workerId is int && workerId >= 0 && workerId < _decoderWorkerCount) {
      _decoderBusy[workerId] = false;
    }
    _decodeMs = (message['ms'] as num?)?.toDouble() ?? 0;
    final workerError = message['error'];
    if (workerError is String && workerError.isNotEmpty) {
      _decoderError = workerError;
    }
    final results = message['results'] as List? ?? const <Object?>[];
    for (final value in results) {
      if (value is! Map || value['lane'] is! int) continue;
      final lane = value['lane'] as int;
      if (lane < 0 || lane > 5) continue;
      final barcode = barcodeFromMessage(value['barcode']);
      if (barcode == null) continue;
      _barcodes[lane] = barcode;
      final controlValue = value['controlPage'];
      if (controlValue is Map) {
        final page = controlValue['page'];
        final tag = controlValue['tag'];
        final payload = controlValue['payload'];
        if (page is int && tag is int && payload is int) {
          final control = _controlAssembler.add(
            TransferControlPage(page: page, tag: tag, payload: payload),
          );
          if (control != null) _acceptControl(control);
        }
      }
      final fps = value['fps'];
      if (fps is num) _senderFps = fps.toDouble().clamp(2, 30);
      if (value['duplicate'] == true) continue;
      final type = value['type'];
      final seed = value['seed'];
      final payload = value['payload'];
      if (type is! int || seed is! int || payload is! TransferableTypedData) {
        continue;
      }
      final tick = value['tick'];
      if (tick is int && value['opticalComplete'] == true) {
        _lastTicks[lane] = tick;
      }
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
    final now = DateTime.now();
    if (now.difference(_lastDiagnosticLog).inMilliseconds >= 1000) {
      _lastDiagnosticLog = now;
      final diagnosticLine = jsonEncode(<String, Object?>{
        'request': message['id'],
        'workerId': workerId,
        'workerPool': _decoderWorkerCount,
        'busyWorkers': _decoderBusy.where((busy) => busy).length,
        'deviceCores': Platform.numberOfProcessors,
        'deviceMemoryMb': _deviceMemoryMb,
        'decodeMs': _decodeMs,
        'locked': message['locked'] == true,
        'worker': message['diagnostic'],
        'resultCount': results.length,
        'validFrames': _validFrames,
        'manifestAccepted': _manifest != null,
        'pendingData': _pendingData.length,
        'captureFps': _captureFps,
        'transferBytesPerSecond': _transferBytesPerSecond,
        'decoderError': _decoderError,
        'fountain': _fountain == null
            ? null
            : '${_fountain!.uniqueChunks}/${_manifest?.k ?? _control?.k ?? 0} chunks, ${_fountain!.receivedEquations} equations',
        'senderFps': _senderFps,
        'knownBarcodes': _barcodes
            .map(
              (value) => value == null
                  ? null
                  : '${value.encoding.name}:${value.gridWidth}x${value.gridHeight}@${value.rate}',
            )
            .toList(),
        if (workerError is String) 'error': workerError,
      });
      developer.log(diagnosticLine, name: 'LumaLinkRx');
      debugPrint('LumaLinkRx $diagnosticLine');
      unawaited(_persistDiagnostic(diagnosticLine));
    }
    if (mounted && _manifest == null) {
      setState(
        () => _state = _control != null
            ? 'تم قفل معلومات النقل — جاري استلام الملف'
            : message['locked'] == true
            ? 'تم القفل على المصفوفة — جاري استلام معلومات الملف'
            : 'جاري البحث عن المصفوفة',
      );
    } else if (mounted) {
      setState(() {});
    }
  }

  void _acceptControl(TransferControl control) {
    if (control.k < 1 ||
        control.k > 1000000 ||
        control.chunk < 1 ||
        control.chunk > 65535 ||
        control.compressedBytes < 0 ||
        control.compressedBytes > 1073741824) {
      return;
    }
    if (_manifest?.id == control.id &&
        _manifest?.k == control.k &&
        _manifest?.chunkSize == control.chunk &&
        _fountain != null) {
      _control = control;
      return;
    }
    if (_control?.id == control.id && _fountain != null) return;
    if (_manifest != null && _manifest!.id != control.id) {
      _manifest = null;
      _manifestAssembler = ManifestAssembler();
      _completedFile = null;
      _savingTransfer = false;
    }
    _control = control;
    _fountain = FountainDecoder(control.k, control.chunk, mediumWideEvery: 2);
    final earlyFrames = List<DecodedFrame>.from(_pendingData);
    _pendingData.clear();
    for (final early in earlyFrames) {
      if (_fountain!.addFrame(early.seed, early.payload)) {
        _receivedPayloadBytes += early.payload.length;
      }
    }
    _lastSpeedSample = DateTime.now();
    _lastSpeedBytes = _receivedPayloadBytes;
    _transferBytesPerSecond = 0;
    if (mounted) {
      setState(() => _state = 'تم قفل معلومات النقل — جاري استلام الملف');
    }
  }

  void _acceptFrame(DecodedFrame frame, BarcodeData barcode) {
    if (frame.type == frameManifest) {
      final manifest = _manifestAssembler.add(frame.payload, optical: barcode);
      if (manifest == null || _manifest?.id == manifest.id) return;
      _manifest = manifest;
      developer.log(
        jsonEncode(<String, Object?>{
          'event': 'manifest-accepted',
          'version': manifest.version,
          'name': manifest.name,
          'k': manifest.k,
          'chunk': manifest.chunkSize,
        }),
        name: 'LumaLinkRx',
      );
      debugPrint(
        'LumaLinkRx manifest accepted: v${manifest.version} ${manifest.name} K=${manifest.k}',
      );
      unawaited(
        _persistDiagnostic(
          jsonEncode(<String, Object?>{
            'event': 'manifest-accepted',
            'version': manifest.version,
            'name': manifest.name,
            'k': manifest.k,
            'chunk': manifest.chunkSize,
          }),
        ),
      );
      final reuseControlDecoder =
          _control?.id == manifest.id &&
          _control?.k == manifest.k &&
          _control?.chunk == manifest.chunkSize &&
          _fountain != null;
      if (!reuseControlDecoder) {
        _fountain = FountainDecoder(
          manifest.k,
          manifest.chunkSize,
          mediumWideEvery: manifest.version == 8
              ? 1
              : (manifest.version >= 9 ? 2 : 4),
        );
      }
      _control = TransferControl(
        id: manifest.id,
        k: manifest.k,
        chunk: manifest.chunkSize,
        compressedBytes: manifest.compressedBytes,
      );
      if (manifest.senderFps != null) {
        _senderFps = manifest.senderFps!.clamp(2, 30);
      }
      // Turbo can deliver valid data while the receiver is still assembling
      // the repeated manifest. Keep those frames and replay them immediately;
      // dropping them made the phone look completely idle with short files and
      // unnecessarily delayed every larger transfer.
      final earlyFrames = List<DecodedFrame>.from(_pendingData);
      _pendingData.clear();
      for (final early in earlyFrames) {
        if (_fountain!.addFrame(early.seed, early.payload)) {
          _receivedPayloadBytes += early.payload.length;
        }
      }
      _lastSpeedSample = DateTime.now();
      _lastSpeedBytes = _receivedPayloadBytes;
      _transferBytesPerSecond = 0;
      if (mounted) {
        setState(
          () => _state = earlyFrames.isEmpty
              ? 'بدأ استلام الملف'
              : 'بدأ الاستلام — تمت استعادة الحزم المبكرة',
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
    if (fountain == null) {
      if (_pendingData.length < _maxPendingDataFrames) {
        _pendingData.add(frame);
      }
      return;
    }
    if (_savingTransfer) return;
    if (fountain.addFrame(frame.seed, frame.payload)) {
      _receivedPayloadBytes += frame.payload.length;
      _updateTransferSpeed();
    }
    if (mounted) setState(() => _state = 'جاري استلام الملف');
    if (fountain.isComplete && manifest != null) {
      _savingTransfer = true;
      unawaited(_finish(fountain, manifest));
    }
  }

  void _updateTransferSpeed() {
    if (_fountain == null || (_manifest == null && _control == null)) return;
    final now = DateTime.now();
    final bytes = _receivedPayloadBytes;
    final previous = _lastSpeedSample;
    if (previous == null) {
      _lastSpeedSample = now;
      _lastSpeedBytes = bytes;
      return;
    }
    final seconds = now.difference(previous).inMicroseconds / 1000000;
    if (seconds < 0.75) return;
    final instant = math.max(0, bytes - _lastSpeedBytes) / seconds;
    _transferBytesPerSecond = _transferBytesPerSecond == 0
        ? instant
        : _transferBytesPerSecond * 0.65 + instant * 0.35;
    _lastSpeedSample = now;
    _lastSpeedBytes = bytes;
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
      if (mounted) {
        setState(() {
          _completedFile = file;
          _state = 'اكتمل النقل وتم التحقق من الملف';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _state = 'فشل التحقق: $error');
    } finally {
      _savingTransfer = false;
    }
  }

  Future<void> _retainCompletedFile() async {
    final file = _completedFile;
    final manifest = _manifest;
    if (file == null || manifest == null || _retainingFile) return;
    setState(() => _retainingFile = true);
    try {
      final saved = await _filesChannel.invokeMethod<bool>('saveCopy', {
        'sourcePath': file.path,
        'name': manifest.name,
        'mime': manifest.mime,
      });
      if (mounted && saved == true) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('تم حفظ نسخة من الملف')));
      }
    } on PlatformException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('تعذّر حفظ النسخة: ${error.message ?? error.code}'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _retainingFile = false);
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
      _controlAssembler = TransferControlAssembler();
      _control = null;
      _manifest = null;
      _fountain = null;
      _pendingData.clear();
      _barcodes
        ..clear()
        ..addAll(List<BarcodeData?>.filled(6, null));
      _lastTicks
        ..clear()
        ..addAll(List<int>.filled(6, -1));
      _validFrames = 0;
      _savingTransfer = false;
      _decoderError = null;
      _lastSpeedSample = null;
      _lastSpeedBytes = 0;
      _receivedPayloadBytes = 0;
      _transferBytesPerSecond = 0;
      _completedFile = null;
      _retainingFile = false;
      _state = 'وجّه الكاميرا نحو مصفوفات LumaLink';
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
    for (final isolate in _decodeIsolates) {
      isolate?.kill(priority: Isolate.immediate);
    }
    _decodeReplies.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final camera = _camera;
    final fountain = _fountain;
    final targetK = _manifest?.k ?? _control?.k;
    final targetBytes = _manifest?.compressedBytes ?? _control?.compressedBytes;
    final chunkSize = _manifest?.chunkSize ?? _control?.chunk;
    final progress = fountain == null || targetK == null
        ? 0.0
        : fountain.uniqueChunks / targetK;
    final receivedBytes =
        fountain == null || targetBytes == null || chunkSize == null
        ? 0
        : math.min(targetBytes, fountain.uniqueChunks * chunkSize);
    final remainingSeconds = _transferBytesPerSecond <= 0 || targetBytes == null
        ? null
        : ((targetBytes - receivedBytes) / _transferBytesPerSecond).ceil();
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
                    fileName: _manifest?.name,
                    totalBytes: _manifest?.total,
                    progress: progress,
                    transferStarted: _manifest != null || _control != null,
                    bytesPerSecond: _transferBytesPerSecond,
                    remainingSeconds: remainingSeconds,
                    completed: _completedFile != null,
                    retaining: _retainingFile,
                    onRetain: _retainCompletedFile,
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
    required this.fileName,
    required this.totalBytes,
    required this.progress,
    required this.transferStarted,
    required this.bytesPerSecond,
    required this.remainingSeconds,
    required this.completed,
    required this.retaining,
    required this.onRetain,
  });
  final String state;
  final String? fileName;
  final int? totalBytes;
  final double progress;
  final bool transferStarted;
  final double bytesPerSecond;
  final int? remainingSeconds;
  final bool completed;
  final bool retaining;
  final VoidCallback onRetain;

  String get _speed {
    if (bytesPerSecond >= 1024 * 1024) {
      return '${(bytesPerSecond / (1024 * 1024)).toStringAsFixed(1)} ميگابايت/ث';
    }
    return '${(bytesPerSecond / 1024).toStringAsFixed(1)} كيلوبايت/ث';
  }

  String get _remaining {
    final seconds = remainingSeconds;
    if (seconds == null || seconds <= 0) return 'جاري حساب الوقت المتبقي';
    if (seconds < 60) return 'متبقي تقريباً $seconds ثانية';
    final minutes = (seconds / 60).ceil();
    return 'متبقي تقريباً $minutes دقيقة';
  }

  String get _fileSize {
    final bytes = totalBytes ?? 0;
    if (bytes >= 1024 * 1024 * 1024) {
      return '${_short(bytes / (1024 * 1024 * 1024))} GB';
    }
    if (bytes >= 1024 * 1024) {
      return '${_short(bytes / (1024 * 1024))} MB';
    }
    if (bytes >= 1024) {
      return '${_short(bytes / 1024)} KB';
    }
    return '$bytes B';
  }

  String _short(double value) {
    final text = value.toStringAsFixed(value >= 10 ? 0 : 1);
    return text.endsWith('.0') ? text.substring(0, text.length - 2) : text;
  }

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
        if (fileName != null) ...[
          Text(
            '$fileName  •  $_fileSize',
            textDirection: TextDirection.ltr,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xff65f1df),
              fontSize: 16,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
        ],
        Text(
          state,
          textAlign: TextAlign.center,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        if (transferStarted) ...[
          const SizedBox(height: 12),
          LinearProgressIndicator(
            value: progress.clamp(0, 1),
            minHeight: 9,
            borderRadius: BorderRadius.circular(9),
          ),
          const SizedBox(height: 7),
          Text(
            '${(progress * 100).toStringAsFixed(1)}%',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          if (!completed) ...[
            Text(
              'سرعة النقل: $_speed',
              style: const TextStyle(
                color: Color(0xff65f1df),
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
            Text(_remaining, style: const TextStyle(color: Colors.white70)),
          ] else ...[
            const SizedBox(height: 4),
            FilledButton.icon(
              onPressed: retaining ? null : onRetain,
              icon: retaining
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_alt),
              label: Text(retaining ? 'جاري الحفظ…' : 'حفظ نسخة بالجهاز'),
            ),
          ],
        ],
      ],
    ),
  );
}
