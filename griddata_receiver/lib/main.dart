import 'dart:async';
import 'dart:math' as math;

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
        theme: ThemeData.dark(useMaterial3: true),
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
  var _state = 'Starting native camera…';
  var _fps = 0.0;
  var _frameMs = 0.0;
  var _frames = 0;
  var _inputFrames = 0;
  var _validFrames = 0;
  var _windowStarted = DateTime.now();
  var _lastFrameAt = DateTime.now();
  var _busy = false;
  BarcodeData? _barcode;
  var _lastBarcodeProbe = 0;
  final _manifestAssembler = ManifestAssembler();
  TransferManifest? _manifest;
  FountainDecoder? _fountain;
  var _savingTransfer = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _openCamera();
  }

  Future<void> _openCamera() async {
    final rear = widget.cameras.where((c) => c.lensDirection == CameraLensDirection.back);
    final description = rear.isNotEmpty ? rear.first : (widget.cameras.isEmpty ? null : widget.cameras.first);
    if (description == null) {
      setState(() => _state = 'No camera found');
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
        _state = 'Native receiver ready — point at GridData matrix';
      });
    } on CameraException catch (error) {
      await controller.dispose();
      if (mounted) setState(() => _state = 'Camera error: ${error.code}');
    }
  }

  void _onFrame(CameraImage image) {
    // This native stream is newest-first and avoids browser ImageBitmap queues.
    // The protocol engine will consume this same Y plane (locator → cells → LDPC).
    if (_busy || image.planes.isEmpty) return;
    _busy = true;
    try {
      final now = DateTime.now();
      final bytes = image.planes.first.bytes;
      var checksum = 0;
      final step = math.max(1, bytes.length ~/ 512);
      for (var i = 0; i < bytes.length; i += step) {
        checksum ^= bytes[i];
      }
      if (checksum == -1) return;
      _inputFrames++;
      // Camera runs around 30fps while the sender is normally 5–7fps. Decode
      // every third sensor frame, keeping native CPU time for genuinely new tiles.
      if (_inputFrames % 3 == 0 && image.planes.length >= 3) {
        _decodeGridData(image);
      }
      _frames++;
      if (now.difference(_windowStarted).inMilliseconds >= 500 && mounted) {
        setState(() {
          _fps = _frames * 1000 / now.difference(_windowStarted).inMilliseconds;
          _frameMs = now.difference(_lastFrameAt).inMicroseconds / 1000;
        });
        _frames = 0;
        _windowStarted = now;
      }
      _lastFrameAt = now;
    } finally {
      _busy = false;
    }
  }

  void _decodeGridData(CameraImage image) {
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
    final outer = locateOuterFrame(frame.luma);
    if (outer == null) return;
    if (_barcode == null || _inputFrames - _lastBarcodeProbe >= 30) {
      _lastBarcodeProbe = _inputFrames;
      final found = locateBarcode(frame.luma, outer);
      if (found != null) _barcode = found;
    }
    final barcode = _barcode;
    if (barcode == null) return;
    if (barcode.gridWidth == 0) {
      if (mounted) setState(() => _state = 'Native lock: zoned profile is not enabled in this receiver build');
      return;
    }
    final sampled = sampleColor8(frame, outer, barcode);
    final capacity = switch (barcode.encoding) {
      GridEncoding.bw => bwCapacityBytes(barcode.gridWidth, barcode.gridHeight),
      GridEncoding.color8 => color8CapacityBytes(barcode.gridWidth, barcode.gridHeight),
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
      iterations: 16,
    );
    if (decoded == null) {
      if (mounted) setState(() => _state = 'Native lock: Color8 ${barcode.gridWidth}×${barcode.gridHeight} — decoding');
      return;
    }
    _validFrames++;
    _acceptFrame(decoded);
    if (mounted) {
      setState(() {
        if (_manifest == null) {
          _state = 'Native frame $_validFrames  type ${decoded.type}  seed ${decoded.seed}  ${decoded.payload.length} bytes';
        }
      });
    }
  }

  void _acceptFrame(DecodedFrame frame) {
    if (frame.type == frameManifest) {
      final manifest = _manifestAssembler.add(frame.payload);
      if (manifest == null) return;
      if (_manifest?.id == manifest.id) return;
      _manifest = manifest;
      _fountain = FountainDecoder(manifest.k, manifest.chunkSize);
      if (mounted) {
        setState(() {
          _state = 'Native transfer locked: ${manifest.name} — 0/${manifest.k} chunks';
        });
      }
      return;
    }
    if (frame.type != frameData) return;
    final manifest = _manifest;
    final fountain = _fountain;
    if (manifest == null || fountain == null || _savingTransfer) return;
    fountain.addFrame(frame.seed, frame.payload);
    if (mounted) {
      setState(() {
        _state = 'Native transfer: ${fountain.uniqueChunks}/${manifest.k} chunks';
      });
    }
    if (fountain.isComplete) {
      _savingTransfer = true;
      unawaited(_finishTransfer(fountain, manifest));
    }
  }

  Future<void> _finishTransfer(FountainDecoder fountain, TransferManifest manifest) async {
    try {
      final bytes = await finishTransfer(fountain.reconstruct(), manifest);
      final file = await saveTransfer(bytes, manifest);
      if (mounted) {
        setState(() {
          _state = 'Transfer complete: ${file.path}';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _state = 'Transfer verification failed: $error');
    } finally {
      _savingTransfer = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) {
      _camera?.dispose();
      _camera = null;
    }
    if (state == AppLifecycleState.resumed && _camera == null) _openCamera();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _camera?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final camera = _camera;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          if (camera != null && camera.value.isInitialized)
            CameraPreview(camera)
          else
            const ColoredBox(color: Colors.black),
          SafeArea(
            child: Align(
              alignment: Alignment.topCenter,
              child: _Banner(text: _state),
            ),
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.bottomCenter,
              child: _Banner(
                text: 'Native capture  ${_fps.toStringAsFixed(1)} fps  ·  ${_frameMs.toStringAsFixed(1)} ms',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.all(12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(10)),
        child: Text(text, textAlign: TextAlign.center),
      );
}
