// NamastePOS - Basic smoke test

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:namastepos/widgets/primary_button.dart';

void main() {
  testWidgets('PrimaryButton renders label and fires onPressed',
      (WidgetTester tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PrimaryButton(
          label: 'Tap me',
          onPressed: () => taps += 1,
        ),
      ),
    ));
    expect(find.text('Tap me'), findsOneWidget);
    await tester.tap(find.text('Tap me'));
    expect(taps, 1);
  });

  testWidgets('PrimaryButton shows spinner when loading',
      (WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: PrimaryButton(label: 'X', loading: true),
      ),
    ));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
