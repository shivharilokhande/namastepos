// NamastePOS — Mobile daily closing (H10).
//
// Cashier punches in physical cash count at end of day; the screen shows
// expected cash (from collected orders) vs counted, surfaces variance,
// and locks the date so duplicate closings can't happen.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class DailyClosingScreen extends StatefulWidget {
  const DailyClosingScreen({super.key});

  @override
  State<DailyClosingScreen> createState() => _DailyClosingScreenState();
}

class _DailyClosingScreenState extends State<DailyClosingScreen> {
  final _cash = TextEditingController(text: '0');
  final _notes = TextEditingController();
  Map<String, dynamic>? _result;
  bool _busy = false;

  // 2026-08-23 (founder): show today's method-wise takings + yesterday's
  // counted cash BEFORE closing, so the cashier knows what to count.
  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _lastClosing;
  bool _loadingPreview = true;

  @override
  void initState() {
    super.initState();
    _loadPreview();
  }

  @override
  void dispose() {
    // M6 (2026-08-23, review): controllers were never disposed.
    _cash.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _loadPreview() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() => _loadingPreview = false);
      return;
    }
    try {
      final p = await ApiService.instance.dio
          .get('/businesses/${biz.id}/daily-closings/preview');
      final l = await ApiService.instance.dio
          .get('/businesses/${biz.id}/daily-closings');
      if (!mounted) return;
      final closings = (l.data['closings'] as List?) ?? [];
      setState(() {
        _preview = (p.data['preview'] as Map?)?.cast<String, dynamic>();
        _lastClosing = closings.isNotEmpty
            ? (closings.first as Map).cast<String, dynamic>()
            : null;
        _loadingPreview = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingPreview = false);
    }
  }

  static const _pmLabels = {
    'cash': 'Cash', 'upi': 'UPI', 'card': 'Card',
    'online': 'Online', 'unpaid': 'Unpaid (open bills)',
  };

  Future<void> _submit() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _busy = true);
    try {
      // Backend Joi expects `cashCounted` in PAISE (integer), not rupees.
      // Also the field is `notes` (matches schema's optional string).
      final cashRupees = double.tryParse(_cash.text) ?? 0;
      final r = await ApiService.instance.dailyClosing(biz.id, {
        'date': DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30)).toIso8601String().substring(0, 10),
        'cashCounted': (cashRupees * 100).round(),
        if (_notes.text.isNotEmpty) 'notes': _notes.text,
      });
      if (mounted) setState(() => _result = r);
      _loadPreview(); // refresh yesterday/today panel after closing
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(humanizeError(e)), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Daily closing')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ListView(
            children: [
              const Text('End-of-day cash count',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              Text(DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30)).toIso8601String().substring(0, 10),
                  style: const TextStyle(color: AppColors.textSecondary)),
              const SizedBox(height: 12),
              // ── Today so far + yesterday's cash ─────────────────────
              if (_loadingPreview)
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_preview != null) ...[
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.divider),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(children: [
                        const Text('Today so far',
                            style: TextStyle(fontWeight: FontWeight.w800)),
                        const Spacer(),
                        Text(
                          '${_preview!['orderCount'] ?? 0} orders · '
                          '${AppFmt.money(((_preview!['grossSales'] as num?) ?? 0).toDouble())}',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ]),
                      const Divider(),
                      ...(() {
                        final bd = (_preview!['paymentBreakdown'] as Map?) ??
                            const {};
                        return _pmLabels.entries
                            .where((e) => bd.containsKey(e.key))
                            .map((e) {
                          final v = (bd[e.key] as Map).cast<String, dynamic>();
                          return Padding(
                            padding: const EdgeInsets.symmetric(vertical: 3),
                            child: Row(children: [
                              Text(e.value,
                                  style: const TextStyle(
                                      color: AppColors.textSecondary)),
                              const Spacer(),
                              Text(
                                '${v['count']}× · ${AppFmt.money(((v['amount'] as num?) ?? 0).toDouble())}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700),
                              ),
                            ]),
                          );
                        }).toList();
                      })(),
                      const Divider(),
                      Row(children: [
                        const Text('Expected cash in counter',
                            style: TextStyle(fontWeight: FontWeight.w800)),
                        const Spacer(),
                        Text(
                          AppFmt.money(
                              ((_preview!['cashExpectedPaise'] as num?) ?? 0) /
                                  100,
                              decimals: true),
                          style: const TextStyle(
                              fontWeight: FontWeight.w900,
                              color: AppColors.primary),
                        ),
                      ]),
                      if (_lastClosing != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Row(children: [
                            Text(
                              'Yesterday (${(_lastClosing!['closing_date'] ?? '').toString().split('T').first}) counted',
                              style: const TextStyle(
                                  fontSize: 12,
                                  color: AppColors.textSecondary),
                            ),
                            const Spacer(),
                            Text(
                              AppFmt.money(
                                  ((_lastClosing!['cash_counted'] as num?) ??
                                          0) /
                                      100,
                                  decimals: true),
                              style: const TextStyle(
                                  fontSize: 12, fontWeight: FontWeight.w700),
                            ),
                          ]),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],
              TextField(
                controller: _cash,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                  labelText: 'Cash counted (₹)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _notes,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Notes (optional)',
                  hintText: 'short by ₹50, customer dispute on Bill #123',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Close day',
                          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                ),
              ),
              if (_result != null) ...[
                const SizedBox(height: 20),
                _summary(),
              ],
            ],
          ),
        ),
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _summary() {
    final r = _result!;
    // Backend row fields are snake_case and in PAISE.
    final expected = ((r['cash_expected'] as num?)?.toDouble() ?? 0) / 100;
    final counted = ((r['cash_counted'] as num?)?.toDouble() ?? 0) / 100;
    final variance = counted - expected;
    final isShort = variance < 0;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _row('Expected (from orders)', AppFmt.money(expected, decimals: true)),
          _row('Counted', AppFmt.money(counted, decimals: true)),
          const Divider(),
          _row('Variance',
              '${isShort ? "" : "+"}${AppFmt.money(variance, decimals: true)}',
              color: isShort ? AppColors.error : AppColors.success),
        ],
      ),
    );
  }

  Widget _row(String k, String v, {Color? color}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Text(k, style: const TextStyle(color: AppColors.textSecondary)),
            const Spacer(),
            Text(v, style: TextStyle(fontWeight: FontWeight.w900, color: color)),
          ],
        ),
      );
}
