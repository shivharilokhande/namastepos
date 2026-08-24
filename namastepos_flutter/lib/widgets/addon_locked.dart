// NamastePOS - Locked-feature placeholder shown when an add-on isn't purchased.
//
// Usage:
//   if (!context.watch<SubscriptionProvider>().hasAddon('online-orders')) {
//     return const AddonLocked(
//       slug: 'online-orders',
//       title: 'Online Orders',
//       reason: 'Get Zomato & Swiggy orders pushed straight into this app.',
//     );
//   }

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config/app_config.dart';
import '../constants/colors.dart';

class AddonLocked extends StatelessWidget {
  final String slug;
  final String title;
  final String reason;
  final IconData icon;

  const AddonLocked({
    super.key,
    required this.slug,
    required this.title,
    required this.reason,
    this.icon = Icons.lock_rounded,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 84, height: 84,
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(22),
              ),
              child: Icon(icon, size: 42, color: AppColors.primary),
            ),
            const SizedBox(height: 18),
            Text(
              '$title is a paid add-on',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 22, fontWeight: FontWeight.w800,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              reason,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 14, height: 1.5),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: () => launchUrl(
                Uri.parse('${AppConfig.webAppUrl}/marketplace?addon=$slug'),
                mode: LaunchMode.externalApplication,
              ),
              icon: const Icon(Icons.shopping_bag_rounded),
              label: const Text('Browse marketplace'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
              ),
            ),
            const SizedBox(height: 12),
            const Text(
              'Open the NamastePOS dashboard on your laptop to subscribe.',
              style: TextStyle(color: AppColors.textHint, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}
