// NamastePOS — 402 SnackBars carry a "View plans" action (2026-09-05,
// review #11).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/services/api_service.dart';
import 'package:namastepos/widgets/error_snackbar.dart';

Widget _host(Object error, {String? prefix}) => MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => TextButton(
            onPressed: () => showApiErrorSnackBar(ctx, error, prefix: prefix),
            child: const Text('boom'),
          ),
        ),
      ),
    );

void main() {
  testWidgets('402 → humanised message + View plans action', (tester) async {
    await tester.pumpWidget(_host(ApiException('Upgrade to Growth', 402),
        prefix: 'Could not place order: '));
    await tester.tap(find.text('boom'));
    await tester.pump();
    expect(find.text('Could not place order: Upgrade to Growth'), findsOneWidget);
    expect(find.text('View plans'), findsOneWidget);
  });

  testWidgets('other statuses → plain message, no action', (tester) async {
    await tester.pumpWidget(_host(ApiException('Table already open', 409)));
    await tester.tap(find.text('boom'));
    await tester.pump();
    expect(find.text('Table already open'), findsOneWidget);
    expect(find.text('View plans'), findsNothing);
  });

  test('apiStatusOf reads ApiException and ignores unknown errors', () {
    expect(apiStatusOf(ApiException('x', 402)), 402);
    expect(apiStatusOf(Exception('x')), isNull);
  });
}
