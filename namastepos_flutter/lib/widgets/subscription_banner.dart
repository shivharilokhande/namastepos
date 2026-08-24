// NamastePOS - Subscription banner shown on the dashboard
//
// Renders only when there's something the user should know about:
//   - Trial countdown (≤7 days left)
//   - Plan paused / past_due
//   - Cancelled (will not renew)

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config/app_config.dart';
import '../constants/colors.dart';
import '../providers/subscription_provider.dart';

class SubscriptionBanner extends StatelessWidget {
  const SubscriptionBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final sub = context.watch<SubscriptionProvider>().subscription;
    if (sub == null) return const SizedBox.shrink();

    Widget? banner;
    if (sub.isPaused) {
      banner = _build(
        bg: AppColors.error.withValues(alpha: 0.10),
        fg: AppColors.error,
        icon: Icons.pause_circle_outline,
        title: 'Plan paused',
        body: 'Reach out to support or update your payment method to resume.',
      );
    } else if (sub.cancelAtPeriodEnd) {
      banner = _build(
        bg: AppColors.warning.withValues(alpha: 0.10),
        fg: AppColors.warning,
        icon: Icons.cancel_schedule_send_outlined,
        title: 'Subscription will cancel',
        body: 'Ends ${sub.currentPeriodEnd.toLocal().toString().substring(0, 10)}. Reactivate from the dashboard.',
      );
    } else if (sub.isTrialing && (sub.daysLeft ?? 99) <= 7) {
      banner = _build(
        bg: AppColors.primary.withValues(alpha: 0.10),
        fg: AppColors.primary,
        icon: Icons.timer_outlined,
        title: 'Trial ends in ${sub.daysLeft} days',
        body: 'Pick a plan to keep your POS running. ${sub.plan?.name ?? "Free"}.',
        cta: 'Upgrade',
        onCta: () => launchUrl(
          Uri.parse('${AppConfig.webAppUrl}/billing'),
          mode: LaunchMode.externalApplication,
        ),
      );
    }

    if (banner == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: banner,
    );
  }

  Widget _build({
    required Color bg, required Color fg, required IconData icon,
    required String title, required String body,
    String? cta, VoidCallback? onCta,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: fg.withValues(alpha: 0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: fg),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
                Text(body, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
              ],
            ),
          ),
          if (cta != null)
            TextButton(onPressed: onCta, child: Text(cta, style: TextStyle(color: fg, fontWeight: FontWeight.w700))),
        ],
      ),
    );
  }
}
