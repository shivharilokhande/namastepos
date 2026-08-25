// NamastePOS — Food coupons (mobile parity, 2026-08-25).
//
// Owner-managed promo codes customers apply to restaurant bills. Mirrors
// the dashboard CouponsPage.tsx: list (incl. deactivated), create dialog
// with a percent cap ("10% up to ₹50"), and soft-deactivate.
//
// Backs onto:
//   GET    /businesses/:id/food-coupons?includeInactive=true
//   POST   /businesses/:id/food-coupons        (owner)
//   DELETE /businesses/:id/food-coupons/:id     (owner → deactivate)

import 'package:flutter/material.dart';
import 'package:flutter/services.dart'
    show
        FilteringTextInputFormatter,
        LengthLimitingTextInputFormatter,
        TextSelection;
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class CouponsScreen extends StatefulWidget {
  const CouponsScreen({super.key});
  @override
  State<CouponsScreen> createState() => _CouponsScreenState();
}

class _CouponsScreenState extends State<CouponsScreen> {
  List<dynamic> _list = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() { _loading = false; _error = 'No business selected.'; });
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      // includeInactive so deactivated coupons stay visible (soft-deleted
      // rows are kept for redemption history) — matches the dashboard.
      final list =
          await ApiService.instance.listFoodCoupons(biz.id, includeInactive: true);
      if (mounted) setState(() { _list = list; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = humanizeError(e); _loading = false; });
    }
  }

  // pg NUMERIC columns arrive as strings — coerce before math/formatting.
  double _num(dynamic v) => (v is num) ? v.toDouble() : (double.tryParse('$v') ?? 0);

  // "10% up to ₹50" — the founder's exact ask; flat coupons are just ₹.
  String _valueLabel(Map<String, dynamic> c) {
    if (c['type'] == 'percent') {
      final cap = c['max_discount_inr'];
      final capStr =
          cap != null ? ' up to ${AppFmt.money(_num(cap))}' : '';
      return '${_num(c['value']).toInt()}%$capStr';
    }
    return AppFmt.money(_num(c['value']));
  }

  Future<void> _confirmDeactivate(Map<String, dynamic> c) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final yes = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Deactivate coupon?'),
        content: Text('Customers will no longer be able to use "${c['code']}". '
            'Its redemption history is kept.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dCtx, false),
              child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.pop(dCtx, true),
            child: const Text('Deactivate'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    try {
      await ApiService.instance.deleteFoodCoupon(biz.id, c['id'].toString());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Coupon deactivated ✓')));
        await _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(humanizeError(e)), backgroundColor: AppColors.error));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true)
            ? const HomeDrawerButton()
            : null,
        title: const Text('Food coupons'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await _showCreateDialog();
          if (created == true && mounted) await _load();
        },
        icon: const Icon(Icons.add),
        label: const Text('New coupon'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.error_outline,
                            color: AppColors.error, size: 36),
                        const SizedBox(height: 12),
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 12),
                        ElevatedButton(
                            onPressed: _load, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : _list.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(
                          'No food coupons yet — tap "New coupon" to offer a '
                          'discount like "10% off up to ₹50".',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textSecondary),
                        ),
                      ),
                    )
                  : ListView.separated(
                      itemCount: _list.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (_, i) {
                        final c = _list[i] as Map<String, dynamic>;
                        final active = c['status'] == 'active';
                        // Platform-wide coupons (business_id null) aren't the
                        // owner's to deactivate — the backend 404s the delete.
                        final ownCoupon = c['business_id'] != null;
                        final used = (c['redemption_count'] as num?)?.toInt() ?? 0;
                        final max = (c['max_redemptions'] as num?)?.toInt();
                        final expiresRaw = c['expires_at'] as String?;
                        final expires = expiresRaw != null
                            ? DateTime.tryParse(expiresRaw)
                            : null;
                        return ListTile(
                          leading: Icon(
                            Icons.local_offer,
                            color: active
                                ? AppColors.primary
                                : AppColors.textHint,
                          ),
                          title: Row(
                            children: [
                              Text(
                                c['code']?.toString() ?? '?',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w800,
                                    fontFamily: 'monospace'),
                              ),
                              const SizedBox(width: 8),
                              _typeBadge(c['type']?.toString() ?? ''),
                            ],
                          ),
                          subtitle: Text(
                            '${_valueLabel(c)}'
                            ' · $used/${max ?? '∞'} used'
                            '${expires != null ? " · expires ${AppFmt.date(expires)}" : ""}'
                            '${active ? "" : " · inactive"}',
                          ),
                          trailing: (ownCoupon && active)
                              ? IconButton(
                                  icon: const Icon(Icons.block,
                                      color: AppColors.error),
                                  tooltip: 'Deactivate',
                                  onPressed: () => _confirmDeactivate(c),
                                )
                              : null,
                        );
                      },
                    ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _typeBadge(String type) {
    final isPercent = type == 'percent';
    final color = isPercent ? AppColors.info : AppColors.secondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        type.isEmpty ? '?' : type,
        style: TextStyle(
            fontSize: 11, fontWeight: FontWeight.w700, color: color),
      ),
    );
  }

  /// Create dialog. Returns true when a coupon was created so the caller
  /// can reload. Local StatefulBuilder so the percent-only "Max discount"
  /// field can show/hide as the type dropdown changes.
  Future<bool?> _showCreateDialog() {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return Future.value(false);

    final codeCtl = TextEditingController();
    final valueCtl = TextEditingController();
    final maxDiscCtl = TextEditingController();
    final maxRedCtl = TextEditingController();
    String type = 'percent';
    DateTime? expiresAt;
    bool saving = false;

    return showDialog<bool>(
      context: context,
      builder: (dCtx) {
        return StatefulBuilder(
          builder: (dCtx, setLocal) {
            final isPercent = type == 'percent';
            final value = double.tryParse(valueCtl.text) ?? 0;
            final canSave = codeCtl.text.trim().length >= 3 &&
                value > 0 &&
                (!isPercent || value <= 100);

            Future<void> submit() async {
              setLocal(() => saving = true);
              try {
                final body = <String, dynamic>{
                  'code': codeCtl.text.trim().toUpperCase(),
                  'type': type,
                  'value': value,
                };
                // Backend Joi forbids maxDiscountInr on flat coupons (a flat
                // coupon IS its own cap) — only attach it for percent.
                if (isPercent && maxDiscCtl.text.trim().isNotEmpty) {
                  body['maxDiscountInr'] =
                      double.tryParse(maxDiscCtl.text.trim());
                }
                if (expiresAt != null) {
                  body['expiresAt'] = expiresAt!.toUtc().toIso8601String();
                }
                if (maxRedCtl.text.trim().isNotEmpty) {
                  body['maxRedemptions'] = int.tryParse(maxRedCtl.text.trim());
                }
                await ApiService.instance.createFoodCoupon(biz.id, body);
                if (dCtx.mounted) Navigator.pop(dCtx, true);
              } catch (e) {
                setLocal(() => saving = false);
                if (dCtx.mounted) {
                  ScaffoldMessenger.of(dCtx).showSnackBar(SnackBar(
                      content: Text(humanizeError(e)),
                      backgroundColor: AppColors.error));
                }
              }
            }

            return AlertDialog(
              title: const Text('New coupon'),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: codeCtl,
                      textCapitalization: TextCapitalization.characters,
                      // Backend wants 3-30 alphanumeric; uppercase live so the
                      // owner sees exactly what customers will type.
                      inputFormatters: [
                        FilteringTextInputFormatter.allow(RegExp('[A-Za-z0-9]')),
                        LengthLimitingTextInputFormatter(30),
                      ],
                      decoration: const InputDecoration(
                        labelText: 'Code',
                        hintText: 'DIWALI10',
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (v) {
                        final up = v.toUpperCase();
                        if (up != v) {
                          codeCtl.value = codeCtl.value.copyWith(
                            text: up,
                            selection:
                                TextSelection.collapsed(offset: up.length),
                          );
                        }
                        setLocal(() {});
                      },
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      value: type,
                      decoration: const InputDecoration(
                        labelText: 'Type',
                        border: OutlineInputBorder(),
                      ),
                      items: const [
                        DropdownMenuItem(
                            value: 'percent', child: Text('Percent (%)')),
                        DropdownMenuItem(
                            value: 'flat', child: Text('Flat (₹)')),
                      ],
                      onChanged: (v) => setLocal(() {
                        type = v ?? 'percent';
                        // Flat coupons can't carry a percent cap.
                        if (type != 'percent') maxDiscCtl.clear();
                      }),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: valueCtl,
                      keyboardType: const TextInputType.numberWithOptions(
                          decimal: true),
                      decoration: InputDecoration(
                        labelText: isPercent ? 'Value (%)' : 'Value (₹)',
                        border: const OutlineInputBorder(),
                      ),
                      onChanged: (_) => setLocal(() {}),
                    ),
                    // Cap only makes sense for percent — flat is already fixed ₹.
                    if (isPercent) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: maxDiscCtl,
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
                        decoration: const InputDecoration(
                          labelText: 'Max discount ₹ (optional)',
                          hintText: '50',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    InkWell(
                      onTap: () async {
                        final now = DateTime.now();
                        final picked = await showDatePicker(
                          context: dCtx,
                          initialDate: expiresAt ??
                              now.add(const Duration(days: 30)),
                          firstDate: now,
                          lastDate: DateTime(now.year + 5),
                        );
                        if (picked != null) setLocal(() => expiresAt = picked);
                      },
                      child: InputDecorator(
                        decoration: const InputDecoration(
                          labelText: 'Expiry date (optional)',
                          border: OutlineInputBorder(),
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                expiresAt != null
                                    ? AppFmt.date(expiresAt!)
                                    : 'No expiry',
                                style: TextStyle(
                                  color: expiresAt != null
                                      ? AppColors.textPrimary
                                      : AppColors.textHint,
                                ),
                              ),
                            ),
                            if (expiresAt != null)
                              GestureDetector(
                                onTap: () => setLocal(() => expiresAt = null),
                                child: const Icon(Icons.clear, size: 18),
                              )
                            else
                              const Icon(Icons.calendar_today, size: 18),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: maxRedCtl,
                      keyboardType: TextInputType.number,
                      inputFormatters: [
                        FilteringTextInputFormatter.digitsOnly,
                      ],
                      decoration: const InputDecoration(
                        labelText: 'Max redemptions (optional)',
                        hintText: 'Unlimited',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed:
                      saving ? null : () => Navigator.pop(dCtx, false),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: (!canSave || saving) ? null : submit,
                  child: saving
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Text('Create'),
                ),
              ],
            );
          },
        );
      },
    );
  }
}
