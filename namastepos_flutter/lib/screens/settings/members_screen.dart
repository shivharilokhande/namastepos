// NamastePOS — Members roster (2026-08-26).
// Lists customers who hold a membership: name, phone, plan, amount paid,
// status and expiry. Backed by GET /businesses/:id/memberships/subscribers.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';

class MembersScreen extends StatefulWidget {
  const MembersScreen({super.key});
  @override
  State<MembersScreen> createState() => _MembersScreenState();
}

class _MembersScreenState extends State<MembersScreen> {
  List<dynamic> _list = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    setState(() { _loading = true; _error = null; });
    try {
      _list = await ApiService.instance.membershipSubscribers(biz.id);
    } catch (e) {
      _error = humanizeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  String _money(num? inr) => '₹${((inr ?? 0)).toStringAsFixed(0)}';
  String _date(String? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso);
    if (d == null) return '—';
    return '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Members')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(_error!, textAlign: TextAlign.center)))
              : _list.isEmpty
                  ? const Center(child: Text('No members yet.\nSell a plan from a customer profile.',
                      textAlign: TextAlign.center))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        itemCount: _list.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final m = _list[i] as Map<String, dynamic>;
                          final active = (m['status'] ?? '') == 'active';
                          return ListTile(
                            leading: CircleAvatar(
                              backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                              child: Text(
                                ((m['customerName'] ?? '?').toString().trim().isEmpty
                                    ? '?'
                                    : (m['customerName']).toString().trim()[0].toUpperCase()),
                                style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800),
                              ),
                            ),
                            title: Text(
                              (m['customerName'] ?? 'Customer').toString(),
                              style: const TextStyle(fontWeight: FontWeight.w700),
                            ),
                            subtitle: Text(
                              '${m['customerPhone'] ?? '—'} · ${m['planName'] ?? ''}'
                              '\nPaid ${_money(m['amountPaidInr'] as num?)} · expires ${_date(m['expiresAt'] as String?)}',
                            ),
                            isThreeLine: true,
                            trailing: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(
                                color: active ? Colors.green.shade100 : Colors.grey.shade200,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                (m['status'] ?? '').toString().toUpperCase(),
                                style: TextStyle(
                                  fontSize: 10, fontWeight: FontWeight.w800,
                                  color: active ? Colors.green.shade800 : Colors.grey.shade700,
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
