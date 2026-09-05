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
import '../models/subscription.dart';
import '../providers/subscription_provider.dart';
import '../screens/billing/billing_screen.dart';

class SubscriptionBanner extends StatelessWidget {
  const SubscriptionBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final sub = context.watch<SubscriptionProvider>().subscription;
    if (sub == null) return const SizedBox.shrink();

    Widget? banner;
    if (sub.isSuspended) {
      // Round 2 MOB #2 (CONTRACTS §6): an admin suspension is not a pause the
      // owner can undo — say so, and offer NO upgrade/resume CTA (the server
      // 403s ACCOUNT_SUSPENDED on every billing action anyway).
      banner = _build(
        bg: AppColors.error.withValues(alpha: 0.10),
        fg: AppColors.error,
        icon: Icons.block,
        title: 'Account suspended — contact support',
        body: sub.suspension?.message ?? SuspensionInfo.defaultMessage,
      );
    } else if (sub.status == 'past_due') {
      // N1 dunning — a charge failed. Give an actionable "update payment" CTA
      // straight to the in-app billing screen.
      banner = _build(
        bg: AppColors.error.withValues(alpha: 0.10),
        fg: AppColors.error,
        icon: Icons.error_outline,
        title: 'Payment failed — plan past due',
        body: 'Update your payment to keep loyalty, reports & add-ons active.',
        cta: 'Update',
        onCta: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => const BillingScreen(),
        )),
      );
    } else if (sub.reactivationPending) {
      banner = _build(
        bg: AppColors.primary.withValues(alpha: 0.10),
        fg: AppColors.primary,
        icon: Icons.hourglass_top,
        title: 'Reactivation pending',
        body: 'Waiting for your first payment to clear — your plan comes back automatically.',
      );
    } else if (sub.isPaused) {
      // Resumable in-app since round 2 (POST /billing/resume on BillingScreen).
      banner = _build(
        bg: AppColors.error.withValues(alpha: 0.10),
        fg: AppColors.error,
        icon: Icons.pause_circle_outline,
        title: 'Plan paused',
        body: 'Nothing is deleted. Resume from Plans & billing to start billing again.',
        cta: 'Resume',
        onCta: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => const BillingScreen(),
        )),
      );
    } else if (sub.pendingPlan != null) {
      final at = sub.pendingPlanEffectiveAt;
      banner = _build(
        bg: AppColors.warning.withValues(alpha: 0.10),
        fg: AppColors.warning,
        icon: Icons.schedule,
        title: 'Moves to ${sub.pendingPlan!.name}'
            '${at == null ? '' : ' on ${at.toLocal().toString().substring(0, 10)}'}',
        body: 'You keep ${sub.plan?.name ?? 'your current plan'} until then.',
        cta: 'Billing',
        onCta: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => const BillingScreen(),
        )),
      );
    } else if (sub.cancelAtPeriodEnd) {
      banner = _build(
        bg: AppColors.warning.withValues(alpha: 0.10),
        fg: AppColors.warning,
        icon: Icons.cancel_schedule_send_outlined,
        title: 'Subscription will cancel',
        body: 'Ends ${sub.currentPeriodEnd.toLocal().toString().substring(0, 10)}. Keep it from Plans & billing.',
        cta: 'Keep plan',
        onCta: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => const BillingScreen(),
        )),
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
