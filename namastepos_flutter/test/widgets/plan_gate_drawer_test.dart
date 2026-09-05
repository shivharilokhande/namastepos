// NamastePOS — drawer tiles must never pop the root route (2026-09-05,
// review #5).
//
// PlanGate.tile used `Navigator.of(ctx).pop()` to dismiss the drawer. On a
// double-tap the second pop removed the ROOT route — a black screen (the
// same crash HomeScreen fixed for its own tiles on 2026-08-23). The tile now
// calls [closeEnclosingDrawer], which goes through ScaffoldState and can never
// touch the route stack. PlanGate.tile itself needs a live AuthProvider (whose
// constructor bootstraps secure storage), so the mechanism is exercised here
// through a plain tile wired the same way.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/widgets/plan_gate.dart';

void main() {
  testWidgets('closeEnclosingDrawer twice leaves the root route in place',
      (tester) async {
    final key = GlobalKey<ScaffoldState>();
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        key: key,
        appBar: AppBar(title: const Text('Home')),
        drawer: Drawer(
          child: Builder(
            builder: (ctx) => ListTile(
              title: const Text('Gated tile'),
              onTap: () {
                taps += 1;
                // Exactly what PlanGate.tile does before navigating.
                closeEnclosingDrawer(ctx);
              },
            ),
          ),
        ),
        body: const Text('root body'),
      ),
    ));

    key.currentState!.openDrawer();
    await tester.pumpAndSettle();
    expect(find.text('Gated tile'), findsOneWidget);

    // Tap #1 closes the drawer; tap #2 (the double-tap) hits the same tile
    // while it is still on screen mid-animation. With Navigator.pop this
    // second call used to pop the root route.
    await tester.tap(find.text('Gated tile'));
    await tester.pump();
    await tester.tap(find.text('Gated tile'), warnIfMissed: false);
    await tester.pumpAndSettle();

    expect(taps, greaterThanOrEqualTo(1));
    expect(key.currentState!.isDrawerOpen, isFalse);
    // The root route survived: its body and app bar are still there.
    expect(find.text('root body'), findsOneWidget);
    expect(find.text('Home'), findsOneWidget);
  });

  testWidgets('closeEnclosingDrawer is a no-op outside an open drawer',
      (tester) async {
    late BuildContext captured;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(builder: (ctx) {
          captured = ctx;
          return const Text('plain');
        }),
      ),
    ));
    // No drawer configured at all — must not throw or pop anything.
    closeEnclosingDrawer(captured);
    await tester.pumpAndSettle();
    expect(find.text('plain'), findsOneWidget);
  });
}
