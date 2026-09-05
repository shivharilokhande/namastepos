// Membership offer at billing time (2026-08-23, founder request).
//
// Shown right when money changes hands — POS "Pay & Place" and table
// settle. Two modes:
//   * expired != null → RENEW the lapsed plan
//   * otherwise       → offer the available plans (buy)
// On purchase we subscribe immediately (recorded as a membership
// payment) and return the plan price so the caller can show a combined
// "collect ₹bill + ₹membership" amount. The bundle is active from the
// very next order created (server-side auto-redeem).
//
// Returns the membership fee in INR when bought/renewed, else null
// ("Not now" → normal billing continues untouched).

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../constants/colors.dart';
import '../constants/feature_keys.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../utils/error_humanizer.dart';
import '../utils/formatters.dart';

Future<double?> showMembershipOfferDialog(
  BuildContext context, {
  required String customerId,
  String? customerLabel,
  Map<String, dynamic>? expired,
}) async {
  final auth = context.read<AuthProvider>();
  final biz = auth.business;
  if (biz == null) return null;

  // 2026-09-05 entitlement audit. This dialog is the ONE chokepoint for the
  // billing-time membership offer — POS "Pay & Place" and the captain settle
  // sheet both come through here — so the gate belongs here rather than at
  // two call sites that would drift apart.
  //
  // /memberships is gated on `memberships` server-side. Without this check
  // the RENEW branch never asks the server at all: it renders straight from
  // the lookupCustomer payload, so an unentitled tenant was shown a real
  // "Add Rs 499 & renew" button whose subscribe call then 402'd — after the
  // cashier had already told the guest the total. Fails closed via
  // AuthProvider.has: unknown entitlements make no offer.
  if (!auth.has(Features.memberships)) return null;

  Map<String, dynamic>? chosen; // plan to subscribe to

  if (expired != null) {
    final priceInr = ((expired['price_paise'] as num?) ?? 0) / 100;
    final name = expired['name']?.toString() ?? 'Membership';
    final days = expired['validity_days'] ?? 30;
    final expiredOn = (expired['expires_at'] ?? '').toString().split('T').first;
    final renew = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: Text('$name membership expired'),
        content: Text(
          '${customerLabel ?? 'This customer'}\'s $name membership expired '
          'on $expiredOn.\n\nRenew for ${AppFmt.money(priceInr)} '
          '($days days)? The amount is added to this bill and the bundle '
          'works from this order.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dCtx, false),
              child: const Text('Not now')),
          ElevatedButton(
              onPressed: () => Navigator.pop(dCtx, true),
              child: Text('Add ${AppFmt.money(priceInr)} & renew')),
        ],
      ),
    );
    if (renew != true) return null;
    chosen = {
      'id': expired['membership_id'],
      'name': name,
      'price_paise': expired['price_paise'],
    };
  } else {
    // Buy-new mode: fetch the plans; nothing to offer → stay silent.
    List<dynamic> plans = const [];
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/memberships');
      plans = (r.data['memberships'] as List?) ?? const [];
    } catch (_) {
      return null;
    }
    if (plans.isEmpty || !context.mounted) return null;
    chosen = await showDialog<Map<String, dynamic>?>(
      context: context,
      builder: (dCtx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: const Text('Offer a membership?'),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${customerLabel ?? 'This customer'} doesn\'t have a '
                'membership. Add one to this bill?',
                style: const TextStyle(
                    fontSize: 13, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 8),
              for (final p in plans)
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.card_membership,
                      color: AppColors.primary),
                  title: Text((p as Map)['name']?.toString() ?? 'Plan'),
                  subtitle: Text(
                      '${AppFmt.moneyPaise((p['price_paise'] ?? 0) as num)}'
                      ' · ${p['validity_days'] ?? 30} days'),
                  onTap: () =>
                      Navigator.pop(dCtx, p.cast<String, dynamic>()),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dCtx, null),
              child: const Text('Not now')),
        ],
      ),
    );
    if (chosen == null) return null;
  }

  if (!context.mounted) return null;
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ApiService.instance.dio.post(
      '/businesses/${biz.id}/memberships/subscribe',
      data: {
        'customerId': customerId,
        'membershipId': chosen['id'],
        'paymentMethod': 'cash',
      },
    );
    final fee = (((chosen['price_paise'] ?? 0) as num)) / 100;
    messenger.showSnackBar(SnackBar(
      content: Text('${chosen['name']} membership added ✓ — '
          '${AppFmt.money(fee)} added to this bill.'),
      backgroundColor: AppColors.success,
    ));
    return fee.toDouble();
  } catch (e) {
    messenger.showSnackBar(SnackBar(
        content: Text(humanizeError(e)), backgroundColor: AppColors.error));
    return null;
  }
}
