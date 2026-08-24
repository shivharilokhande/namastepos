// NamastePOS — Trial countdown banner (Push 11 / mobile-first GTM).
//
// Slim strip pinned to the top of the home Scaffold body. Shows during the
// 14-day Starter trial; clears automatically once the user subscribes or
// the trial expires (the trial-expired full-screen gate takes over from
// SubscriptionProvider after that).
//
// Tap → BillingScreen. Tone: friendly nudge, not aggressive.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../constants/colors.dart';
import '../providers/auth_provider.dart';
import '../providers/subscription_provider.dart';
import '../screens/billing/billing_screen.dart';

class TrialBanner extends StatelessWidget {
  const TrialBanner({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<SubscriptionProvider>(
      builder: (context, sub, _) {
        final s = sub.subscription;
        // Hide if not trialing, trial expired, OR user is already on a paid
        // tier (last check protects against stale SubscriptionProvider — if
        // AuthProvider.plan says Pro/Enterprise, no banner regardless of
        // what /billing returned).
        final tier = context.watch<AuthProvider>().plan.tierKind;
        final onPaidTier = tier == 'pro' || tier == 'enterprise';
        if (onPaidTier || s == null || !s.isTrialing || s.trialExpired) {
          return const SizedBox.shrink();
        }
        final days = s.trialDaysLeft ?? 0;
        // Last 3 days → switch to amber to make the urgency obvious.
        final isUrgent = days <= 3;
        final bg = isUrgent ? AppColors.warning : AppColors.primary;
        return Material(
          color: bg,
          child: InkWell(
            onTap: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => const BillingScreen(),
            )),
            child: Padding(
              // 6px vertical (was 8) → shaves enough total height to clear
              // the 4.7px RenderFlex overflow that the screens inside the
              // IndexedStack were complaining about (their SliverAppBar +
              // bottom-nav math is tight).
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              child: Row(
                children: [
                  Icon(isUrgent ? Icons.warning_amber_rounded : Icons.bolt,
                      color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _label(days),
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w800,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  const Text('Upgrade',
                      style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                          fontSize: 12,
                          decoration: TextDecoration.underline)),
                  const SizedBox(width: 4),
                  const Icon(Icons.chevron_right, color: Colors.white, size: 18),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  String _label(int days) {
    if (days == 0) return 'Trial ends today — upgrade to keep using NamastePOS';
    if (days == 1) return '1 day left in your trial';
    return '$days days left in your trial';
  }
}
