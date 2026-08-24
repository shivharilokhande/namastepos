// NamastePOS — shared empty-state widget (P2 close-out, 2026-08-22).
//
// Design decisions:
//   • One widget across Inventory / Customers / Reviews so voice and
//     spacing stay consistent.
//   • Every empty state must have an action CTA — an empty screen with
//     no forward path is the single biggest onboarding drop-off signal.
//   • Semantics wrapped for TalkBack; the visual icon is decorative,
//     the label is the source of truth for screen readers.
//   • Optional `hint` line surfaces the "why should I care" the marketing
//     team wrote (e.g. "Track your masalas before you run out mid-service.").

import 'package:flutter/material.dart';
import '../constants/colors.dart';

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;      // Bold headline (e.g. "No customers yet")
  final String? hint;      // Sub-line explaining the "why"
  final String ctaLabel;
  final VoidCallback onCta;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.ctaLabel,
    required this.onCta,
    this.hint,
    this.secondaryLabel,
    this.onSecondary,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      // TalkBack reads: "<title>. <hint>. <ctaLabel> button, double-tap to activate."
      container: true,
      label: '$title. ${hint ?? ''}',
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 72, height: 72,
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.10),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 36, color: AppColors.primary),
              ),
              const SizedBox(height: 20),
              Text(title,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                )),
              if (hint != null) ...[
                const SizedBox(height: 8),
                Text(hint!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 13, color: AppColors.textSecondary,
                    height: 1.4,
                  )),
              ],
              const SizedBox(height: 20),
              ElevatedButton(
                onPressed: onCta,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
                child: Text(ctaLabel,
                    style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
              if (secondaryLabel != null && onSecondary != null) ...[
                const SizedBox(height: 6),
                TextButton(
                  onPressed: onSecondary,
                  child: Text(secondaryLabel!,
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                      )),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
