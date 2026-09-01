// NamastePOS — Mobile bill split (F3).
//
// Opened from the running-bill view on a table session. Lets the captain or
// cashier split the bill across multiple guests with equal or custom amounts,
// then mark each split invoice paid as the money lands.

import 'package:flutter/material.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';

class BillSplitScreen extends StatefulWidget {
  final String businessId;
  final String sessionId;
  final double totalInr;
  const BillSplitScreen({
    super.key,
    required this.businessId,
    required this.sessionId,
    required this.totalInr,
  });

  @override
  State<BillSplitScreen> createState() => _BillSplitScreenState();
}

class _BillSplitScreenState extends State<BillSplitScreen> {
  String _mode = 'equal';
  List<Map<String, dynamic>> _guests = [
    {'guestLabel': 'Guest 1', 'amount': 0.0},
    {'guestLabel': 'Guest 2', 'amount': 0.0},
  ];
  Map<String, dynamic>? _split;
  bool _busy = false;

  double get _customSum =>
      _guests.fold<double>(0, (s, g) => s + ((g['amount'] as double?) ?? 0));
  double get _remainder => widget.totalInr - _customSum;
  double get _perHead => widget.totalInr / _guests.length;

  Future<void> _doSplit() async {
    setState(() => _busy = true);
    try {
      final body = {
        'mode': _mode,
        'splits': _guests.map((g) => {
              'guestLabel': g['guestLabel'],
              if (_mode == 'custom') 'amount': g['amount'],
              if (g['customerPhone'] != null) 'customerPhone': g['customerPhone'],
            }).toList(),
      };
      final r = await ApiService.instance.splitBill(widget.businessId, widget.sessionId, body);
      if (mounted) setState(() => _split = r);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Couldn't split the bill — " + humanizeError(e)), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // Review 2026-08-28: guard against a double-tap paying the same split
  // invoice twice (duplicate payment record).
  final Set<String> _payingIds = {};

  Future<void> _payInvoice(Map<String, dynamic> inv, String method) async {
    final id = inv['id'].toString();
    if (_payingIds.contains(id)) return;
    setState(() => _payingIds.add(id));
    try {
      final updated = await ApiService.instance
          .paySplitInvoice(widget.businessId, inv['id'], method);
      if (!mounted) return;
      setState(() {
        final list = (_split!['invoices'] as List).cast<Map>();
        final idx = list.indexWhere((x) => x['id'] == updated['id']);
        if (idx >= 0) list[idx] = updated.cast<String, dynamic>();
      });
    } catch (e) {
      // FB-20 (2026-09-01): guard context after await — if the screen was
      // popped while the pay request was in flight, ScaffoldMessenger.of(context)
      // hits a deactivated element and throws (crashes in release too).
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e))),
      );
    } finally {
      if (mounted) setState(() => _payingIds.remove(id));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Split bill'),
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
      ),
      body: _split == null ? _configBody() : _settleBody(),
    );
  }

  Widget _configBody() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  const Text('Total to split',
                      style: TextStyle(color: AppColors.textSecondary)),
                  const Spacer(),
                  Text(AppFmt.money(widget.totalInr, decimals: true),
                      style: const TextStyle(
                          fontWeight: FontWeight.w900, fontSize: 22)),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _modeBtn('equal', 'Equal split'),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _modeBtn('custom', 'Custom amounts'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (_mode == 'equal')
              Text('Each guest pays approximately ${AppFmt.money(_perHead, decimals: true)}',
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.textSecondary))
            else
              Text(
                'Sum: ${AppFmt.money(_customSum, decimals: true)}'
                '${_remainder.abs() >= 0.01 ? "  · remaining ${AppFmt.money(_remainder, decimals: true)}" : ""}',
                style: TextStyle(
                  fontSize: 12,
                  color: _remainder.abs() < 0.01
                      ? AppColors.success
                      : AppColors.warning,
                ),
              ),
            const SizedBox(height: 12),
            Expanded(
              child: ListView.builder(
                itemCount: _guests.length,
                itemBuilder: (_, i) => _guestRow(i),
              ),
            ),
            TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Add guest'),
              onPressed: () => setState(() => _guests.add({
                    'guestLabel': 'Guest ${_guests.length + 1}',
                    'amount': 0.0,
                  })),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 52,
              child: ElevatedButton(
                onPressed: _busy ||
                        _guests.length < 2 ||
                        (_mode == 'custom' && _remainder.abs() >= 0.01)
                    ? null
                    : _doSplit,
                child: _busy
                    ? const SizedBox(
                        height: 22, width: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : Text('Split into ${_guests.length} bills',
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 16)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _modeBtn(String value, String label) {
    final selected = _mode == value;
    return InkWell(
      onTap: () => setState(() => _mode = value),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: selected ? AppColors.primary.withValues(alpha: 0.1) : null,
          border: Border.all(
              color: selected ? AppColors.primary : AppColors.divider,
              width: selected ? 2 : 1),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Center(
          child: Text(label,
              style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: selected ? AppColors.primary : AppColors.textPrimary)),
        ),
      ),
    );
  }

  Widget _guestRow(int i) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: TextField(
              decoration: const InputDecoration(
                labelText: 'Name', isDense: true,
                border: OutlineInputBorder(),
              ),
              controller: TextEditingController(text: _guests[i]['guestLabel'] as String),
              onChanged: (v) => _guests[i]['guestLabel'] = v,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            flex: 2,
            child: _mode == 'custom'
                ? TextField(
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: '₹', isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (v) => setState(() =>
                        _guests[i]['amount'] = double.tryParse(v) ?? 0),
                  )
                : Text(AppFmt.money(_perHead),
                    style: const TextStyle(color: AppColors.textSecondary)),
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, color: AppColors.error),
            onPressed: _guests.length <= 2
                ? null
                : () => setState(() => _guests.removeAt(i)),
          ),
        ],
      ),
    );
  }

  Widget _settleBody() {
    final invoices = (_split!['invoices'] as List).cast<Map>();
    final allPaid = invoices.every((iv) => iv['status'] == 'paid');
    return SafeArea(
      child: Column(
        children: [
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: invoices.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _settleRow(invoices[i].cast<String, dynamic>()),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: allPaid ? AppColors.success : null,
                  ),
                  child: Text(allPaid ? 'Done — all paid' : 'Close (settle later)',
                      style: const TextStyle(fontWeight: FontWeight.w800)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _settleRow(Map<String, dynamic> inv) {
    final paid = inv['status'] == 'paid';
    return Container(
      decoration: BoxDecoration(
        color: paid ? Colors.green.shade50 : AppColors.surface,
        border: Border.all(
            color: paid ? Colors.green.shade300 : AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(inv['guest_label'] as String? ?? '?',
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                    if (inv['customer_phone'] != null)
                      Text('📞 ${inv['customer_phone']}',
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.textSecondary)),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(AppFmt.money(((inv['amount_paise'] as int?) ?? 0) / 100, decimals: true),
                      style: const TextStyle(
                          fontWeight: FontWeight.w900, fontSize: 16)),
                  Container(
                    margin: const EdgeInsets.only(top: 2),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: paid ? Colors.green : AppColors.warning,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                        paid ? 'PAID · ${(inv['payment_method'] ?? '').toString().toUpperCase()}' : 'UNPAID',
                        style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                            fontSize: 9)),
                  ),
                ],
              ),
            ],
          ),
          if (!paid) ...[
            const SizedBox(height: 8),
            Row(
              children: ['cash', 'upi', 'card'].map((m) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: OutlinedButton(
                    onPressed: () => _payInvoice(inv, m),
                    child: Text(m.toUpperCase(),
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                  ),
                ),
              )).toList(),
            ),
          ],
        ],
      ),
    );
  }
}
