import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/native_decode_worker.dart';

void main() {
  test(
    'persistent decoder isolate accepts transferred YUV without blocking caller',
    () async {
      final replies = ReceivePort();
      final isolate = await Isolate.spawn(
        nativeDecodeWorkerEntry,
        replies.sendPort,
      );
      final iterator = StreamIterator<Object?>(replies);
      expect(await iterator.moveNext(), isTrue);
      final requests = iterator.current as SendPort;
      requests.send(<String, Object?>{
        'id': 1,
        'width': 64,
        'height': 64,
        'y': TransferableTypedData.fromList(<Uint8List>[
          Uint8List(64 * 64)..fillRange(0, 64 * 64, 255),
        ]),
        'u': TransferableTypedData.fromList(<Uint8List>[
          Uint8List(32 * 32)..fillRange(0, 32 * 32, 128),
        ]),
        'v': TransferableTypedData.fromList(<Uint8List>[
          Uint8List(32 * 32)..fillRange(0, 32 * 32, 128),
        ]),
        'yRowStride': 64,
        'uRowStride': 32,
        'vRowStride': 32,
        'uPixelStride': 1,
        'vPixelStride': 1,
        'barcodes': const <Object?>[null, null],
        'lastTicks': const <int>[-1, -1],
      });
      expect(await iterator.moveNext(), isTrue);
      final response = iterator.current as Map;
      expect(response['id'], 1);
      expect(response['locked'], isFalse);
      expect(response['results'], isEmpty);
      isolate.kill(priority: Isolate.immediate);
      await iterator.cancel();
      replies.close();
    },
  );
}
