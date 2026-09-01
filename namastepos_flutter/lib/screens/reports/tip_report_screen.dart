// NamastePOS — per-server tip report (FF-903-c mobile parity).
//
// Owner picks a date range and sees per-server tip aggregation:
// [count, total ₹, avg per tip]. Backend endpoint:
//   GET /businesses/:id/tips/report?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// returns { report: [{server_user_id, tip_count, total_inr}, ...] }.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class TipReportScreen extends StatefulWidget {
  const TipReportScreen({super.key});
  @override
  State<TipReportScreen> createState() => _TipReportScreenState();
}

class _TipReportScreenState extends State<TipReportScreen> {
  late DateTime _start;
  late DateTime _end;
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    final today = DateTime.now();
    _end = today;
    _start = DateTime(today.year, today.month, 1); // month-to-date
    // Defer fetch until first frame so context.read is available.
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      final fmt = DateFormat('yyyy-MM-dd');
      final rows = await ApiService.instance.tipReport(
        biz.id,
        startDate: fmt.format(_start),
        endDate: fmt.format(_end),
      );
      if (!mounted) return; // FB-20: guard setState after await
      setState(() { _rows = rows; _loading = false; });
    } catch (e) {
      if (!mounted) return; // FB-20
      setState(() { _error = humanizeError(e); _loading = false; });
    }
  }

  Future<void> _pickRange() async {
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
      initialDateRange: DateTimeRange(start: _start, end: _end),
    );
    if (range != null) {
      setState(() {
        _start = range.start;
        _end = range.end;
      });
      await _load();
    }
  }

  double _num(dynamic v) => (v is num) ? v.toDouble() : (double.tryParse('$v') ?? 0);

  @override
  Widget build(BuildContext context) {
    final totalTips = _rows.fold<double>(0, (s, r) => s + _num(r['total_inr']));
    final totalCount = _rows.fold<int>(0,
      (s, r) => s + ((r['tip_count'] as num?)?.toInt() ?? 0));

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Tips (per server)'),
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
          Container(
            margin: const EdgeInsets.all(16),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.divider),
            ),
            child: Row(
              children: [
                const Icon(Icons.date_range, color: AppColors.primary, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${AppFmt.date(_start)}  →  ${AppFmt.date(_end)}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                TextButton(onPressed: _pickRange, child: const Text('Change')),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                _totalCard('Tips', '$totalCount'),
                const SizedBox(width: 12),
                _totalCard('Total', AppFmt.money(totalTips)),
              ],
            ),
          ),
          const SizedBox(height: 12),
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
                                child: const Text('Retry'),
                              ),
                            ],
                          ),
                        ),
                      )
                    : _rows.isEmpty
                        ? const Center(
                            child: Text(
                              'No tips recorded in this window.',
                              style: TextStyle(color: AppColors.textSecondary),
                            ),
                          )
                        : ListView.separated(
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                            itemCount: _rows.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 8),
                            itemBuilder: (_, i) {
                              final r = _rows[i];
                              final count = (r['tip_count'] as num?)?.toInt() ?? 0;
                              final total = _num(r['total_inr']);
                              final avg = count > 0 ? total / count : 0.0;
                              final sid = r['server_user_id']?.toString();
                              final label = (sid == null || sid.isEmpty)
                                  ? 'Unassigned'
                                  : 'Server ${sid.substring(0, sid.length.clamp(0, 8))}…';
                              return Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: AppColors.surface,
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(color: AppColors.divider),
                                ),
                                child: Row(
                                  children: [
                                    Container(
                                      width: 40, height: 40,
                                      decoration: BoxDecoration(
                                        color: AppColors.primary.withValues(alpha: 0.10),
                                        borderRadius: BorderRadius.circular(20),
                                      ),
                                      alignment: Alignment.center,
                                      child: const Icon(Icons.person,
                                          color: AppColors.primary),
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(label,
                                              style: const TextStyle(
                                                  fontWeight: FontWeight.w700)),
                                          Text('$count tips · avg ${AppFmt.money(avg)}',
                                              style: const TextStyle(
                                                fontSize: 12,
                                                color: AppColors.textSecondary,
                                              )),
                                        ],
                                      ),
                                    ),
                                    Text(AppFmt.money(total),
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w800,
                                          fontSize: 16,
                                        )),
                                  ],
                                ),
                              );
                            },
                          ),
          ),
        ],
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _totalCard(String label, String value) => Expanded(
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.divider),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  style: const TextStyle(
                    fontSize: 11,
                    letterSpacing: 1.1,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textSecondary,
                  )),
              const SizedBox(height: 4),
              Text(value,
                  style: const TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w900)),
            ],
          ),
        ),
      );
}
