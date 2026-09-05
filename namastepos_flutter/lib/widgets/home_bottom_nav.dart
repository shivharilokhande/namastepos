// NamastePOS — shared bottom navigation bar.
//
// FF-402 restore-orphans (pass 3): drawer-pushed screens (Inventory, KDS,
// Reviews, Memberships, Staff, Reports, Register reports, Tax invoices,
// Wastage, Daily closing, Reservations, Menu editor, Modifier groups,
// Customers, Marketplace, Billing, QR codes, Bill template, Image upload,
// Surge, Captain, Driver) all lost the bottom navigation bar because
// each was pushed as a full route above `HomeScreen`. Owner wants a
// single, consistent nav on every screen so they can jump between tabs
// without hitting back many times.
//
// Design:
//   * `homeTabIndex` — a top-level `ValueNotifier<int>` that HomeScreen
//     listens to as its selected tab. Pushed screens can flip it and
//     the underlying HomeScreen updates its IndexedStack instantly.
//   * `HomeBottomNav` — drop-in Scaffold.bottomNavigationBar for any
//     screen that isn't HomeScreen itself. When tapped, it pops back
//     to HomeScreen (removing any pushed routes) and sets the tab.
//   * Role-aware: same RolePerms.visibleTabs() filter that HomeScreen
//     uses, so a Captain/Kitchen role sees the same subset of tabs
//     from a pushed screen as they do on Home.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../constants/colors.dart';
import '../constants/feature_keys.dart';
import '../providers/auth_provider.dart';
import '../utils/role_permissions.dart';

/// Which bottom-nav tabs this user may see — role AND plan.
///
/// 2026-09-05 entitlement audit. `RolePerms.visibleTabs` answers only the
/// staff-permission half. Tab 3 ("Tables") renders CaptainScreen, which lives
/// entirely on `/captain/*` — routes featureGate.js gates on `captain_mode`.
/// The DRAWER tile for Captain was plan-gated; this tab, showing the same
/// screen, was not, so removing captain_mode from a plan hid the tile and
/// left the tab. Same class of bug as the Voice POS mic.
///
/// Fails closed with AuthProvider.has: while entitlements are unknown the
/// tab is not offered. Every other tab is baseline (Home / POS / Orders /
/// Reports / More carry no server feature rule), so none is filtered here.
List<int> planAwareVisibleTabs(AuthProvider auth) {
  final visible = <int>[
    ...RolePerms.visibleTabs(auth.role, permissions: auth.permissions),
  ];
  if (!auth.has(Features.captainMode)) visible.remove(3);
  // Never leave the bar with nothing to draw (NavigationBar asserts >= 2).
  if (visible.length < 2) {
    for (final fallback in [1, 5]) {
      if (!visible.contains(fallback)) visible.add(fallback);
      if (visible.length >= 2) break;
    }
    visible.sort();
  }
  return visible;
}

/// Shared source of truth for HomeScreen's active tab. Read/written by
/// HomeScreen and by `HomeBottomNav.onDestinationSelected`.
final ValueNotifier<int> homeTabIndex = ValueNotifier<int>(0);

/// Set to a wall-clock millisecond timestamp whenever the bottom nav
/// initiates a route change. `HomeDrawerButton`'s deferred openDrawer
/// microtask checks this — if the user tapped the bottom nav in the
/// same tick window that scheduled an openDrawer, we skip the open so
/// the drawer doesn't spuriously appear right after a tab switch.
///
/// This solves the reported bug: "when on Inventory and I tap More on
/// the bottom nav, the hamburger drawer opens instead of switching to
/// the More tab". Root cause was a race between the deferred openDrawer
/// from HomeDrawerButton's pop-then-open path and the bottom-nav pop.
int lastBottomNavTapMs = 0;

/// Six-slot destination list, filtered per role at render time. Kept as
/// a static const so both HomeScreen and HomeBottomNav render an
/// identical bar (icons, order, labels).
const _kAllDestinations = <NavigationDestination>[
  NavigationDestination(
      icon: Icon(Icons.home_outlined),
      selectedIcon: Icon(Icons.home_rounded), label: 'Home'),
  NavigationDestination(
      icon: Icon(Icons.point_of_sale_outlined),
      selectedIcon: Icon(Icons.point_of_sale_rounded), label: 'POS'),
  NavigationDestination(
      icon: Icon(Icons.receipt_long_outlined),
      selectedIcon: Icon(Icons.receipt_long_rounded), label: 'Orders'),
  NavigationDestination(
      icon: Icon(Icons.table_restaurant_outlined),
      selectedIcon: Icon(Icons.table_restaurant_rounded), label: 'Tables'),
  NavigationDestination(
      icon: Icon(Icons.bar_chart_outlined),
      selectedIcon: Icon(Icons.bar_chart_rounded), label: 'Reports'),
  NavigationDestination(
      icon: Icon(Icons.settings_outlined),
      selectedIcon: Icon(Icons.settings_rounded), label: 'More'),
];

class HomeBottomNav extends StatelessWidget {
  /// When `popToHome` is true (the default), tapping a destination pops
  /// every route back to HomeScreen and updates the tab. Pass false on
  /// HomeScreen itself — it's already the root, no pop needed.
  final bool popToHome;
  const HomeBottomNav({super.key, this.popToHome = true});

  @override
  Widget build(BuildContext context) {
    // Bug-fix pass: some screens (CaptainScreen, KdsScreen) are used
    // BOTH as HomeScreen's tab content and as drawer-pushed screens.
    // When rendered as tab content they sit inside HomeScreen's
    // Scaffold body — HomeScreen already renders its own bottom nav,
    // so their bottom nav duplicated the bar visually. Fix: when
    // `popToHome` is true (i.e. we're the shared instance mounted
    // on a pushed screen), only render if this route can actually
    // pop back to Home. If we can't pop, the widget is on the root
    // route and someone else is already showing the nav.
    // Fix (2026-08-22): use the route's own isFirst instead of
    // Navigator.canPop() — canPop flips during push/pop transitions,
    // which made the bar vanish/reappear (and on some devices never
    // render on the pushed Captain view). isFirst is stable for the
    // lifetime of the route.
    if (popToHome && (ModalRoute.of(context)?.isFirst ?? true)) {
      return const SizedBox.shrink();
    }
    final auth = context.watch<AuthProvider>();
    final visibleIndices = planAwareVisibleTabs(auth);
    if (visibleIndices.isEmpty) {
      return const SizedBox.shrink();
    }
    final destinations = [
      for (final i in visibleIndices) _kAllDestinations[i]
    ];

    return ValueListenableBuilder<int>(
      valueListenable: homeTabIndex,
      builder: (_, currentIndex, __) {
        final selected = visibleIndices.contains(currentIndex)
            ? visibleIndices.indexOf(currentIndex)
            : 0;
        return NavigationBar(
          selectedIndex: selected,
          onDestinationSelected: (i) {
            // Timestamp so HomeDrawerButton's deferred openDrawer can
            // recognise "the user just changed tabs, don't open the
            // drawer even though I scheduled it a moment ago".
            lastBottomNavTapMs = DateTime.now().millisecondsSinceEpoch;
            final targetTab = visibleIndices[i];
            homeTabIndex.value = targetTab;
            if (popToHome) {
              // Drop any pushed routes so HomeScreen (which is listening
              // to homeTabIndex) is now visible and showing the new tab.
              Navigator.of(context).popUntil((r) => r.isFirst);
            }
          },
          backgroundColor: AppColors.surface,
          indicatorColor: AppColors.primary.withValues(alpha: 0.12),
          destinations: destinations,
        );
      },
    );
  }
}
