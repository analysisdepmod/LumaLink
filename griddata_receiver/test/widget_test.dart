import 'package:flutter_test/flutter_test.dart';
import 'package:griddata_receiver/main.dart';

void main() {
  testWidgets('shows a useful state when no camera is available', (
    tester,
  ) async {
    await tester.pumpWidget(const GridDataReceiverApp(cameras: []));
    await tester.pump();

    expect(find.text('لم يتم العثور على كاميرا'), findsOneWidget);
  });
}
