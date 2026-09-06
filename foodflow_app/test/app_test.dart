import 'package:flutter_test/flutter_test.dart';
import 'package:feastly/main.dart';

void main() {
  testWidgets('customer app opens and displays restaurant discovery', (tester) async {
    await tester.pumpWidget(const FeastlyApp());
    expect(find.text('Good evening, Arjun'), findsOneWidget);
    expect(find.text('Top picks near you'), findsOneWidget);
    expect(find.text('Bombay Bowl'), findsOneWidget);
  });
}
