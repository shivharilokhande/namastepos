// Shared "create membership plan" dialog (2026-08-23).
//
// A membership is an ITEM BUNDLE the customer pre-pays for — e.g.
// "20× Cold Coffee + 20× Pizza, ₹1500, 30 days". Covered items are
// auto-discounted from their bills until the bundle runs out.
// Used from Customer detail → Add membership and from the
// Memberships back-office screen.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../constants/colors.dart';
import '../providers/auth_provider.dart';
import '../providers/menu_provider.dart';
import '../services/api_service.dart';
import '../utils/error_humanizer.dart';
import '../utils/formatters.dart';

/// Shows the create dialog. Returns true if a plan was created.
Future<bool> showCreateMembershipPlanDialog(BuildContext context) =>
    showMembershipPlanDialog(context);

/// Shows the create OR edit dialog. Pass [existing] (a membership map from the
/// list) to edit in place; omit it to create. Returns true on save.
Future<bool> showMembershipPlanDialog(BuildContext context,
    {Map<String, dynamic>? existing}) async {
  final isEdit = existing != null;
  if (context.read<AuthProvider>().role != 'business_owner') {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Only the owner can manage membership plans.')));
    return false;
  }
  final biz = context.read<AuthProvider>().business;
  if (biz == null) return false;
  final name = TextEditingController(text: existing?['name'] as String? ?? '');
  final price = TextEditingController(
      text: existing != null
          ? (((existing['price_paise'] as num?)?.toInt() ?? 0) / 100)
              .toStringAsFixed(0)
          : '');
  final days = TextEditingController(
      text: '${(existing?['validity_days'] as num?)?.toInt() ?? 30}');
  final menu = context.read<MenuProvider>().visibleItems;
  final Map<String, int> bundle = {}; // menuItemId → qty
  // Prefill the bundle from an existing plan's benefits.items.
  if (existing != null) {
    final items = ((existing['benefits'] as Map?)?['items'] as List?) ?? const [];
    for (final it in items) {
      final m = it as Map;
      final id = m['menuItemId']?.toString();
      final qty = (m['qty'] as num?)?.toInt() ?? 0;
      if (id != null && qty > 0) bundle[id] = qty;
    }
  }

  final ok = await showDialog<bool>(
    context: context,
    builder: (dCtx) => StatefulBuilder(
      builder: (dCtx, setDState) => AlertDialog(
        title: Text(isEdit ? 'Edit membership plan' : 'New membership plan'),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                    controller: name,
                    decoration: const InputDecoration(
                        labelText: 'Name (e.g. Coffee Club)')),
                TextField(
                    controller: price,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Price (₹)')),
                TextField(
                    controller: days,
                    keyboardType: TextInputType.number,
                    decoration:
                        const InputDecoration(labelText: 'Validity (days)')),
                const SizedBox(height: 12),
                const Text('Bundle items',
                    style: TextStyle(fontWeight: FontWeight.w800)),
                const Text(
                  'What the member gets — e.g. 20× Cold Coffee. These are '
                  'auto-discounted from their bills until used up.',
                  style:
                      TextStyle(fontSize: 11, color: AppColors.textSecondary),
                ),
                const SizedBox(height: 6),
                for (final e in bundle.entries)
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          menu
                              .where((m) => m.id == e.key)
                              .map((m) => m.name)
                              .join(),
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontWeight: FontWeight.w600, fontSize: 13),
                        ),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        icon:
                            const Icon(Icons.remove_circle_outline, size: 20),
                        onPressed: () => setDState(() {
                          if (e.value <= 1) {
                            bundle.remove(e.key);
                          } else {
                            bundle[e.key] = e.value - 1;
                          }
                        }),
                      ),
                      Text('${e.value}',
                          style: const TextStyle(fontWeight: FontWeight.w800)),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        icon: const Icon(Icons.add_circle_outline, size: 20),
                        onPressed: () =>
                            setDState(() => bundle[e.key] = e.value + 1),
                      ),
                    ],
                  ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Add bundle item'),
                    onPressed: () async {
                      final picked = await showModalBottomSheet<String>(
                        context: dCtx,
                        showDragHandle: true,
                        builder: (sheetCtx) => SafeArea(
                          child: ListView(
                            shrinkWrap: true,
                            children: [
                              for (final m in menu)
                                ListTile(
                                  dense: true,
                                  title: Text(m.name),
                                  trailing:
                                      Text(AppFmt.money(m.price)),
                                  onTap: () => Navigator.pop(sheetCtx, m.id),
                                ),
                            ],
                          ),
                        ),
                      );
                      if (picked != null) {
                        setDState(
                            () => bundle[picked] = (bundle[picked] ?? 0) + 1);
                      }
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dCtx, false),
              child: const Text('Cancel')),
          ElevatedButton(
              onPressed: () => Navigator.pop(dCtx, true),
              child: Text(isEdit ? 'Save' : 'Create')),
        ],
      ),
    ),
  );
  if (ok != true) return false;
  try {
    final payload = {
      'name': name.text.trim(),
      'priceInr': double.tryParse(price.text) ?? 0,
      'validityDays': int.tryParse(days.text) ?? 30,
      // On edit always send benefits (possibly empty) so clearing the bundle
      // actually persists; on create only send it when non-empty.
      if (bundle.isNotEmpty || isEdit)
        'benefits': {
          'items': [
            for (final e in bundle.entries)
              {'menuItemId': e.key, 'qty': e.value},
          ],
        },
    };
    if (isEdit) {
      await ApiService.instance
          .updateMembership(biz.id, existing['id'].toString(), payload);
    } else {
      await ApiService.instance.dio
          .post('/businesses/${biz.id}/memberships', data: payload);
    }
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(isEdit
              ? 'Membership plan updated ✓'
              : 'Membership plan created ✓')));
    }
    return true;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    }
    return false;
  }
}
