// NamastePOS — Plan-gate widget. Wraps any UI that requires a specific
// feature key, showing either the child (if allowed) or an "Upgrade" CTA.
//
// Usage:
//   PlanGate(featureKey: 'kds', child: KdsScreen(...))
//
// or as a list-tile decoration:
//   PlanGate.tile(
//     featureKey: 'kds', icon: Icons.restaurant,
//     title: 'Kitchen (KDS)', onTap: () => ...,
//   )

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../constants/colors.dart';
import '../providers/auth_provider.dart';
import '../screens/billing/billing_screen.dart' as billing;
import '../services/upsell_hints.dart';

/// The plan the owner should buy to unlock [featureKey], AS THE SERVER NAMED
/// IT — never worked out here.
///
/// 2026-09-04. This used to be `tierKind == 'starter' ? 'Pro' : 'Enterprise'`,
/// which was wrong twice over: the kind 'pro' is the **Growth** plan (Rs 299)
/// and the plan named **Pro** is the kind 'pro_plan', so a Growth, Pro or
/// Advanced tenant was pitched Enterprise (Rs 1,999) with every plan in
/// between skipped. The ladder is backend-only (services/planTiers.js); the
/// app just prints what it is given:
///   1. the label from the 402 FEATURE_LOCKED body for this exact feature
///      (UpsellHints, filled by ApiService's error interceptor),
///   2. else `plan.nextTierLabel` from /auth/me's plan summary,
///   3. else null — and the caller says "a higher plan". We do not guess.
String? serverUpgradeLabel(AuthProvider auth, String featureKey) =>
    UpsellHints.instance.labelFor(featureKey) ?? auth.plan.nextTierLabel;

/// "the Pro plan" / "a higher plan" — safe to drop into a sentence.
String upgradeTargetPhrase(AuthProvider auth, String featureKey) {
  final label = serverUpgradeLabel(auth, featureKey);
  return label == null ? 'a higher plan' : 'the $label plan';
}

/// "You're currently on the Growth plan." Uses the server's label for the
/// CURRENT plan; stays vague rather than naming the wrong one.
String currentPlanPhrase(AuthProvider auth) {
  final label = auth.plan.tierLabel ?? UpsellHints.instance.currentLabel;
  return label == null ? 'your current plan' : 'the $label plan';
}

class PlanGate extends StatelessWidget {
  final String featureKey;
  final Widget child;
  final Widget? lockedWidget;
  const PlanGate({super.key, required this.featureKey, required this.child, this.lockedWidget});

  /// The imperative form, for the many gated surfaces that are a button, a
  /// menu action or a dialog rather than a whole screen — an `if` in a build
  /// method, not a wrapper widget.
  ///
  /// Use this (or `context.watch<AuthProvider>().has(...)`) rather than
  /// reading PlanInfo directly, and always pass a `Features.` constant:
  /// constants/feature_keys.dart is the single list, and
  /// test/entitlements_test.dart fails the build on a raw string literal.
  ///
  /// Watches, so a plan change that arrives while the screen is open rebuilds
  /// it. Fails closed via AuthProvider.has — unknown entitlements deny.
  static bool allows(BuildContext context, String featureKey) =>
      context.watch<AuthProvider>().has(featureKey);

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    if (auth.has(featureKey)) return child;
    // Entitlements not resolved yet: deny (that is the whole point) but say
    // nothing about plans. An "Upgrade to X" pitch here would be a guess
    // shown to an owner who may well be paying for this already.
    if (!auth.entitlementsKnown) return const _EntitlementsLoading();
    return lockedWidget ?? _DefaultLocked(featureKey: featureKey);
  }

  /// Use as a drop-in for `ListTile` inside a Drawer / settings list.
  ///
  /// Behaviour (per owner's request): when the feature is NOT in the
  /// active plan + addon set, the tile is hidden entirely (returns
  /// `SizedBox.shrink()`). The previous behaviour of greying it out and
  /// showing an "Upgrade" badge is opt-in via `showLockedAsUpgrade: true`
  /// for callers that want to drive billing-page conversions from the
  /// drawer instead of hiding.
  static Widget tile({
    required String featureKey,
    required IconData icon,
    required String title,
    String? subtitle,
    required VoidCallback onTap,
    bool showLockedAsUpgrade = false,
  }) =>
      Builder(builder: (ctx) {
        final auth = ctx.watch<AuthProvider>();
        // Until entitlements are known, show NOTHING — not even the locked
        // "upgrade" variant. A drawer row that offers to sell a feature the
        // owner already bought is as wrong as one that hands out a feature
        // they did not. The row appears (locked or unlocked) the moment
        // /auth/me answers, which on a warm start is before first paint.
        if (!auth.entitlementsKnown) return const SizedBox.shrink();
        final unlocked = auth.has(featureKey);
        if (!unlocked && !showLockedAsUpgrade) {
          return const SizedBox.shrink();
        }
        return ListTile(
          dense: true, // Match the direct-ListTile entries in the drawer
          leading: Icon(icon, color: unlocked ? null : AppColors.textHint),
          title: Text(title,
              style: TextStyle(
                  color: unlocked ? null : AppColors.textSecondary)),
          subtitle: subtitle == null ? null : Text(subtitle),
          trailing: unlocked
              ? null
              : _LockedBadge(target: serverUpgradeLabel(auth, featureKey)),
          onTap: () {
            // Bug fix (2026-08-22): unlocked path used to call onTap()
            // directly without closing the drawer first. A drawer is
            // ScaffoldState-owned (not a Navigator route), so
            // Navigator.push over an open drawer leaves the drawer
            // "open" internally — when the pushed screen later pops
            // (e.g. user taps another bottom-nav tab), the drawer
            // re-appears on HomeScreen, looking like "More opens
            // hamburger". Close the drawer FIRST in both branches.
            //
            // 2026-09-05 (review #5): close it via the ScaffoldState, NOT
            // `Navigator.pop`. HomeScreen fixed the same crash for its own
            // tiles on 2026-08-23 (`_closeDrawer`): on a double-tap, tap #1
            // popped the drawer's local history entry and tap #2 popped the
            // ROOT route — black screen. Every plan-gated tile still did the
            // pop. `closeDrawer()` can never pop a route, and is a no-op when
            // the tile is not inside an open drawer.
            closeEnclosingDrawer(ctx);
            if (unlocked) { onTap(); return; }
            Navigator.push(ctx, MaterialPageRoute(
              builder: (_) => const billing.BillingScreen(),
            ));
          },
        );
      });
}

/// Close the drawer that contains [ctx] without touching the route stack.
/// The Drawer is built in the Scaffold's own subtree, so `Scaffold.maybeOf`
/// from a tile inside it finds HomeScreen's ScaffoldState.
void closeEnclosingDrawer(BuildContext ctx) {
  final s = Scaffold.maybeOf(ctx);
  if (s != null && s.isDrawerOpen) s.closeDrawer();
}

class _LockedBadge extends StatelessWidget {
  /// The plan name the SERVER named as the upgrade target, or null when we
  /// have not been told one — then the badge reads "UPGRADE" rather than
  /// naming a plan that might be the wrong one (or a downgrade).
  final String? target;
  const _LockedBadge({required this.target});
  @override
  Widget build(BuildContext context) {
    final next = (target ?? 'Upgrade').toUpperCase();
    // P2 (2026-08-22): TalkBack needs to hear "locked, upgrade to <next>"
    // — the visual gradient + tiny padlock icon are invisible to
    // screen-reader users.
    return Semantics(
      label: target == null
          ? 'Locked. Upgrade your plan to unlock.'
          : 'Locked. Upgrade to $target to unlock.',
      button: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            colors: [AppColors.primary, AppColors.warning],
          ),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.lock, color: Colors.white, size: 11),
          const SizedBox(width: 3),
          Text(next, style: const TextStyle(
              color: Colors.white,
              fontSize: 9,
              fontWeight: FontWeight.w900,
              letterSpacing: 0.4)),
        ]),
      ),
    );
  }
}

/// Shown by [PlanGate] while we do not yet know what the business is entitled
/// to. Deliberately says nothing about plans — see the note at the call site.
class _EntitlementsLoading extends StatelessWidget {
  const _EntitlementsLoading();
  @override
  Widget build(BuildContext context) => const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
}

class _DefaultLocked extends StatelessWidget {
  final String featureKey;
  const _DefaultLocked({required this.featureKey});
  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final label = serverUpgradeLabel(auth, featureKey);
    return Scaffold(
      appBar: AppBar(title: const Text('Upgrade required')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline, size: 64, color: AppColors.primary),
            const SizedBox(height: 16),
            Text(label == null
                    ? 'Available on a higher plan'
                    : 'Available on the $label plan',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text('You\'re on ${currentPlanPhrase(auth)}. '
                'Upgrade to unlock "$featureKey" and many more features.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textSecondary)),
            const SizedBox(height: 24),
            SizedBox(
              width: 220, height: 48,
              child: ElevatedButton.icon(
                icon: const Icon(Icons.upgrade),
                label: const Text('View plans'),
                onPressed: () => Navigator.pushReplacement(
                  context, MaterialPageRoute(builder: (_) => const billing.BillingScreen()),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
  // _human() used to map a tier KIND to a plan NAME here — 'pro' -> "the Pro
  // plan", which is the Growth plan. Deleted: currentPlanPhrase() prints the
  // server's own label instead (see the top of this file).
}
