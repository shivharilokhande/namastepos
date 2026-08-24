// NamastePOS — Hamburger button that opens the HomeScreen's Drawer.
//
// Each top-tab screen (Dashboard / POS / Orders / Stock / Reports / More)
// has its own AppBar with no leading slot by default — putting the system
// back-arrow there because it thinks no back nav is available. We want a
// "≡" instead so first-time users discover the side menu.
//
// Bug fix (2026-08-20): the earlier version silently no-op'd if
// `homeScaffoldKey.currentState` was null (which happens whenever the
// user is on a pushed route above HomeScreen — e.g. after Place order
// → Confirm → dialog closed unexpectedly). Now the button:
//   1. Tries to open the drawer directly.
//   2. Falls back to popping to the first route (HomeScreen), which
//      re-mounts the drawer for the next tap.
//   3. As a last resort, uses pushNamedAndRemoveUntil('/home') so
//      users can never end up stranded on a dead screen.
//
// Usage:
//   AppBar(leading: const HomeDrawerButton(), title: ...)

import 'package:flutter/material.dart';
import '../screens/home/home_screen.dart' show homeScaffoldKey;
import 'home_bottom_nav.dart' show lastBottomNavTapMs;

class HomeDrawerButton extends StatelessWidget {
  const HomeDrawerButton({super.key});

  void _open(BuildContext context) {
    final nav = Navigator.of(context);
    // Bug fix (2026-08-22): the previous version opened
    // `homeScaffoldKey.currentState.openDrawer()` whenever HomeScreen
    // was mounted — but if the user is on a PUSHED route above
    // HomeScreen (e.g. Floors & tables, Inventory), HomeScreen is
    // hidden underneath. The drawer would slide open on that hidden
    // Scaffold and the user saw nothing happen.
    // Correct order: if we can pop, drop back to HomeScreen first so
    // the drawer opens on the visible route.
    if (nav.canPop()) {
      final scheduledAt = DateTime.now().millisecondsSinceEpoch;
      nav.popUntil((r) => r.isFirst);
      // Deferred so the pop settles before we ask for the drawer.
      // If the user has tapped the bottom nav since we scheduled this,
      // skip — they wanted a tab switch, not a drawer open.
      Future.microtask(() {
        if (lastBottomNavTapMs > scheduledAt) return;
        final s = homeScaffoldKey.currentState;
        if (s != null && s.hasDrawer) s.openDrawer();
      });
      return;
    }
    // We're already at the root — just open the drawer.
    final scaffold = homeScaffoldKey.currentState;
    if (scaffold != null && scaffold.hasDrawer) {
      scaffold.openDrawer();
      return;
    }
    // Absolute last resort — force-navigate to /home. Shouldn't fire
    // in practice because the auth gate always lands users on
    // HomeScreen as their root.
    nav.pushNamedAndRemoveUntil('/home', (_) => false);
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Open menu',
      icon: const Icon(Icons.menu_rounded),
      onPressed: () => _open(context),
    );
  }
}
