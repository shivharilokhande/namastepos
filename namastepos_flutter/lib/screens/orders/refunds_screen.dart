// NamastePOS — Refund history (mobile parity, 2026-08-25).
//
// Read-only list of refunds for this business, with a status filter.
// Issuing a refund already lives in order_detail_screen (via
// ApiService.refundOrder) — this screen is the HISTORY view only and
// never duplicates the refund action.
//
// Backs onto: GET /businesses/:id/refunds?status=&limit=
//   → { refunds: [{ amount, reason, status, createdAt, ... }] }

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class RefundsScreen extends StatefulWidget {
  const RefundsScreen({super.key});
  @override
  State<RefundsScreen> createState() => _RefundsScreenState();
}

class _RefundsScreenState extends State<RefundsScreen> {
  // null = "All". Others match the backend refund_status enum.
  static const _statuses = ['pending', 'processed', 'failed', 'cancelled'];
  String? _filter;

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
      final list = await ApiService.instance
          .listRefunds(biz.id, status: _filter, limit: 100);
      if (mounted) setState(() { _list = list; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = humanizeError(e); _loading = false; });
    }
  }

  double _num(dynamic v) => (v is num) ? v.toDouble() : (double.tryParse('$v') ?? 0);

  Color _statusColor(String s) {
    switch (s) {
      case 'processed':
        return AppColors.success;
      case 'pending':
        return AppColors.warning;
      case 'failed':
        return AppColors.error;
      case 'cancelled':
        return AppColors.textSecondary;
      default:
        return AppColors.textSecondary;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true)
            ? const HomeDrawerButton()
            : null,
        title: const Text('Refunds'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Status filter chips: All + the four enum values.
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                _chip('All', null),
                for (final s in _statuses) ...[
                  const SizedBox(width: 8),
                  _chip(s, s),
                ],
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
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
                                  onPressed: _load,
                                  child: const Text('Retry')),
                            ],
                          ),
                        ),
                      )
                    : _list.isEmpty
                        ? Center(
                            child: Text(
                              _filter == null
                                  ? 'No refunds yet.'
                                  : 'No $_filter refunds.',
                              style: const TextStyle(
                                  color: AppColors.textSecondary),
                            ),
                          )
                        : ListView.separated(
                            itemCount: _list.length,
                            separatorBuilder: (_, __) =>
                                const Divider(height: 1),
                            itemBuilder: (_, i) {
                              final r = _list[i] as Map<String, dynamic>;
                              return _refundTile(r);
                            },
                          ),
          ),
        ],
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _chip(String label, String? value) {
    final selected = _filter == value;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) {
        if (_filter == value) return;
        setState(() => _filter = value);
        _load();
      },
    );
  }

  Widget _refundTile(Map<String, dynamic> r) {
    final status = r['status']?.toString() ?? 'pending';
    final color = _statusColor(status);
    final amount = _num(r['amount']);
    final reason = (r['reason'] as String?)?.trim();
    // serialize() exposes createdAt (ISO). AppFmt pins display to IST.
    final createdRaw = r['createdAt'] as String? ?? r['created_at'] as String?;
    final created = createdRaw != null ? DateTime.tryParse(createdRaw) : null;
    // Order reference isn't always present in the serialized row — show it
    // only when the backend included one.
    final orderNo = r['orderNo'] ?? r['order_no'] ?? r['orderId'] ?? r['order_id'];

    return ListTile(
      leading: Icon(Icons.currency_rupee, color: color),
      title: Row(
        children: [
          Text(
            AppFmt.money(amount, decimals: true),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
          ),
          const SizedBox(width: 10),
          _statusBadge(status, color),
        ],
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 2),
          Text(
            (reason == null || reason.isEmpty) ? 'No reason given' : reason,
            style: const TextStyle(color: AppColors.textSecondary),
          ),
          const SizedBox(height: 2),
          Text(
            [
              if (created != null) AppFmt.dateTime(created),
              if (orderNo != null) 'Order #$orderNo',
            ].join(' · '),
            style: const TextStyle(
                fontSize: 12, color: AppColors.textHint),
          ),
        ],
      ),
    );
  }

  Widget _statusBadge(String status, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          status,
          style: TextStyle(
              fontSize: 11, fontWeight: FontWeight.w700, color: color),
        ),
      );
}
