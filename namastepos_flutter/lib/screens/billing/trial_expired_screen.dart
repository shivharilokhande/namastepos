// NamastePOS — Trial-expired hard gate (Push 11).
//
// Full-screen takeover shown when subscription.trialExpired == true.
// Blocks the rest of the app behind a single Upgrade CTA. The user can
// still log out (in case they want to switch accounts) but they cannot
// reach any business screens until they pay.
//
// Mounted as a guard in app.dart's auth-routed widget — see the
// `_authedRoot` builder there. It runs AFTER login, so this guard only
// fires for logged-in users whose trial ran out.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/subscription.dart';
import '../../providers/auth_provider.dart';
import '../../providers/subscription_provider.dart';
import 'billing_screen.dart';

class TrialExpiredScreen extends StatelessWidget {
  const TrialExpiredScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final bizName = auth.business?.name ?? 'your business';
    // Round 2 MOB #2 (CONTRACTS §6): if the row is admin-suspended the way out
    // is support, not checkout — say so and offer no upgrade CTA. Any other
    // status (incl. ones this build has never heard of) falls through to the
    // normal trial copy; nothing here can throw on an unknown status.
    final sub = context.watch<SubscriptionProvider>().subscription;
    final suspended = sub?.isSuspended == true;
    if (suspended) return _suspended(context, sub!);

    return Scaffold(
      backgroundColor: AppColors.surface,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  color: AppColors.warning.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.lock_clock,
                    size: 48, color: AppColors.warning),
              ),
              const SizedBox(height: 28),
              // No hardcoded trial length (TRIAL_DAYS is a server env; it has
              // been 7, not 14, since 2026-08-26).
              const Text('Your free trial has ended',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
              const SizedBox(height: 10),
              Text(
                'Thanks for trying NamastePOS with $bizName. To keep taking '
                'orders, managing your menu, and using Captain, choose a '
                'plan to continue.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 14, height: 1.4),
              ),
              const SizedBox(height: 28),
              // Plan tease — quick price callout so the CTA isn't a leap of
              // faith. Real plan comparison lives on BillingScreen.
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.divider),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: AppColors.primary.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: const Icon(Icons.bolt, color: AppColors.primary),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Hardcode-audit fix (2026-08-24): no hardcoded
                          // price on the conversion screen — the billing
                          // screen shows live prices from /plans.
                          Text('Plans for every stall & cafe',
                              style: TextStyle(
                                  fontWeight: FontWeight.w900, fontSize: 15)),
                          Text(
                              'KDS, variants, bill split, captain, driver, '
                              'and more.',
                              style: TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 12)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  icon: const Icon(Icons.upgrade),
                  label: const Text('Choose a plan',
                      style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => const BillingScreen(),
                  )),
                ),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () async {
                  await context.read<AuthProvider>().logout();
                },
                child: const Text('Log out',
                    style: TextStyle(color: AppColors.textSecondary)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Suspended variant — same takeover layout, support message, log-out only.
  Widget _suspended(BuildContext context, Subscription sub) {
    final since = sub.suspension?.since;
    return Scaffold(
      backgroundColor: AppColors.surface,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.block, size: 48, color: AppColors.error),
              ),
              const SizedBox(height: 28),
              const Text('Account suspended — contact support',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
              const SizedBox(height: 10),
              Text(
                '${sub.suspension?.message ?? SuspensionInfo.defaultMessage}'
                '${since == null ? '' : '\nSuspended since ${since.toLocal().toIso8601String().substring(0, 10)}.'}',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 14, height: 1.4),
              ),
              const SizedBox(height: 24),
              TextButton(
                onPressed: () async {
                  await context.read<AuthProvider>().logout();
                },
                child: const Text('Log out',
                    style: TextStyle(color: AppColors.textSecondary)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
