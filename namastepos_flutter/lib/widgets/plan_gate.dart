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

class PlanGate extends StatelessWidget {
  final String featureKey;
  final Widget child;
  final Widget? lockedWidget;
  const PlanGate({super.key, required this.featureKey, required this.child, this.lockedWidget});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    if (auth.has(featureKey)) return child;
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
          trailing: unlocked ? null : _LockedBadge(currentTier: auth.plan.tierKind),
          onTap: () {
            // Bug fix (2026-08-22): unlocked path used to call onTap()
            // directly without closing the drawer first. A drawer is
            // ScaffoldState-owned (not a Navigator route), so
            // Navigator.push over an open drawer leaves the drawer
            // "open" internally — when the pushed screen later pops
            // (e.g. user taps another bottom-nav tab), the drawer
            // re-appears on HomeScreen, looking like "More opens
            // hamburger". Pop the drawer FIRST in both branches.
            Navigator.of(ctx).pop();
            if (unlocked) { onTap(); return; }
            Navigator.push(ctx, MaterialPageRoute(
              builder: (_) => const billing.BillingScreen(),
            ));
          },
        );
      });
}

class _LockedBadge extends StatelessWidget {
  final String currentTier;
  const _LockedBadge({required this.currentTier});
  @override
  Widget build(BuildContext context) {
    final next = currentTier == 'starter' ? 'PRO' : 'ENTERPRISE';
    // P2 (2026-08-22): TalkBack needs to hear "locked, upgrade to <next>"
    // — the visual gradient + tiny padlock icon are invisible to
    // screen-reader users.
    return Semantics(
      label: 'Locked. Upgrade to $next to unlock.',
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

class _DefaultLocked extends StatelessWidget {
  final String featureKey;
  const _DefaultLocked({required this.featureKey});
  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final next = auth.plan.tierKind == 'starter' ? 'Pro' : 'Enterprise';
    return Scaffold(
      appBar: AppBar(title: const Text('Upgrade required')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline, size: 64, color: AppColors.primary),
            const SizedBox(height: 16),
            Text('Available on the $next plan',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text('You\'re currently on ${_human(auth.plan.tierKind)}. '
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
  String _human(String t) =>
      t == 'starter' ? 'the free Starter plan' :
      t == 'pro' ? 'the Pro plan' :
      'the Enterprise plan';
}
