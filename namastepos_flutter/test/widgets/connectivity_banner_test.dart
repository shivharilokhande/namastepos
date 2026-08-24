// Widget test — ConnectivityBanner (FF-219 + FF-260).
//
// Verifies the banner is hidden when we haven't primed offline state,
// and doesn't crash the widget tree during initial build. Full offline
// simulation requires mocking the Connectivity() plugin which is
// covered separately in an integration test.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/widgets/connectivity_banner.dart';

void main() {
  testWidgets('renders child inside banner wrapper', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: const ConnectivityBanner(
        child: Scaffold(body: Center(child: Text('hello'))),
      ),
    ));
    expect(find.text('hello'), findsOneWidget);
  });

  testWidgets('offline banner is hidden by default', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: const ConnectivityBanner(
        child: SizedBox(),
      ),
    ));
    // The offline copy is only present when _offline=true.
    expect(find.textContaining("offline"), findsNothing);
  });
}
