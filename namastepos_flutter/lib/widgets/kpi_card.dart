// NamastePOS - KPI card for the dashboard

import 'package:flutter/material.dart';
import '../constants/colors.dart';

class KpiCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;
  final String? trend;
  /// Optional tap handler — when set the card becomes a tappable
  /// surface (ink splash + chevron-style affordance). Reports screen
  /// uses this to navigate to the detailed report for each metric.
  final VoidCallback? onTap;

  const KpiCard({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
    this.trend,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(icon, size: 18, color: color),
              ),
              const Spacer(),
              if (trend != null)
                Text(
                  trend!,
                  style: TextStyle(
                    color: trend!.startsWith('-') ? AppColors.error : AppColors.success,
                    fontWeight: FontWeight.w600,
                    fontSize: 12,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            value,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
              if (onTap != null)
                const Icon(Icons.chevron_right_rounded,
                    size: 16, color: AppColors.textHint),
            ],
          ),
        ],
      ),
    );
    // Use Material + InkWell so the ripple is visible and the surface
    // still keeps the rounded border. When `onTap` is null the card is
    // a plain non-interactive tile (same look as before).
    // Material's `shape` already encodes the rounded corner — passing
    // both `shape` and `borderRadius` trips an assertion (Material
    // line 209). Stick with `shape` only so the InkWell ripple is
    // clipped to the rounded outline.
    return Material(
      color: AppColors.surface,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppColors.divider),
      ),
      child: onTap == null
          ? card
          : InkWell(onTap: onTap, child: card),
    );
  }
}
