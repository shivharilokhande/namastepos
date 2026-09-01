// NamastePOS mobile — Schedule III income statement (Push 15f).
//
// Owner picks a date range, sees the P&L laid out as a government-style
// statement, and exports/shares as PDF / XLSX / CSV using the system
// share sheet (so it routes to WhatsApp, Mail, Drive, AirPrint, etc.).

import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'dart:io';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class IncomeStatementScreen extends StatefulWidget {
  // 2026-08-26 (founder): when opened from a home KPI card we want the
  // P&L scoped to TODAY (start == end == today), with the date filter
  // still at the top so it can be widened. The Reports tab keeps the
  // month-to-date default.
  final bool todayDefault;
  const IncomeStatementScreen({super.key, this.todayDefault = false});

  @override
  State<IncomeStatementScreen> createState() => _IncomeStatementScreenState();
}

class _IncomeStatementScreenState extends State<IncomeStatementScreen> {
  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _report;
  late DateTime _startDate = widget.todayDefault
      ? DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day)
      : DateTime(DateTime.now().year, DateTime.now().month, 1);
  DateTime _endDate = DateTime.now();
  String? _exporting;

  String _fmtDate(DateTime d) => d.toIso8601String().substring(0, 10);

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      _report = await ApiService.instance.incomeStatement(
        biz.id,
        startDate: _fmtDate(_startDate),
        endDate: _fmtDate(_endDate),
      );
    } catch (e) {
      _error = e.toString();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickRange() async {
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
      initialDateRange: DateTimeRange(start: _startDate, end: _endDate),
    );
    if (picked != null) {
      setState(() { _startDate = picked.start; _endDate = picked.end; });
      _load();
    }
  }

  Future<void> _export(String format) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _exporting = format);
    try {
      final bytes = await ApiService.instance.incomeStatementExport(
        biz.id,
        format: format,
        startDate: _fmtDate(_startDate),
        endDate: _fmtDate(_endDate),
      );
      final filename = 'pnl_${_fmtDate(_startDate)}_${_fmtDate(_endDate)}.$format';
      if (format == 'pdf') {
        // PDF → use the printing package: opens iOS / Android system print
        // dialog with options to print, save to Files, or share.
        await Printing.layoutPdf(
          onLayout: (_) async => Uint8List.fromList(bytes),
          name: filename,
        );
      } else {
        // XLSX / CSV → write to a temp file and share via the share sheet.
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/$filename');
        await file.writeAsBytes(bytes);
        await SharePlus.instance.share(ShareParams(
            files: [XFile(file.path)],
            text: 'NamastePOS P&L ${_fmtDate(_startDate)} → ${_fmtDate(_endDate)}'));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't export the report — " + humanizeError(e))),
      );
    } finally {
      if (mounted) setState(() => _exporting = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fmt = AppFmt.inr2;

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('P&L statement'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: Column(
        children: [
          Container(
            color: AppColors.surface,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Row(
              children: [
                Expanded(
                  child: InkWell(
                    onTap: _pickRange,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          const Icon(Icons.date_range, size: 20),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '${DateFormat('dd MMM yyyy').format(_startDate)} – ${DateFormat('dd MMM yyyy').format(_endDate)}',
                              style: const TextStyle(fontWeight: FontWeight.w800),
                            ),
                          ),
                          const Icon(Icons.expand_more, size: 18),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (_report != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              color: AppColors.background,
              child: Row(
                children: [
                  _ExportChip(
                    label: 'PDF',
                    icon: Icons.picture_as_pdf,
                    busy: _exporting == 'pdf',
                    onTap: () => _export('pdf'),
                  ),
                  const SizedBox(width: 8),
                  _ExportChip(
                    label: 'Excel',
                    icon: Icons.table_chart_outlined,
                    busy: _exporting == 'xlsx',
                    onTap: () => _export('xlsx'),
                  ),
                  const SizedBox(width: 8),
                  _ExportChip(
                    label: 'CSV',
                    icon: Icons.download_outlined,
                    busy: _exporting == 'csv',
                    onTap: () => _export('csv'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                ? Center(child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_error!, style: const TextStyle(color: AppColors.error)),
                  ))
                : _report == null
                  ? const SizedBox()
                  : SingleChildScrollView(
                      padding: const EdgeInsets.all(16),
                      child: _PnlBody(report: _report!, fmt: fmt),
                    ),
          ),
        ],
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

class _ExportChip extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool busy;
  final VoidCallback onTap;
  const _ExportChip({required this.label, required this.icon, required this.busy, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: OutlinedButton.icon(
        onPressed: busy ? null : onTap,
        icon: busy
          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(icon, size: 18),
        label: Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(vertical: 12),
        ),
      ),
    );
  }
}

class _PnlBody extends StatelessWidget {
  final Map<String, dynamic> report;
  final NumberFormat fmt;
  const _PnlBody({required this.report, required this.fmt});

  @override
  Widget build(BuildContext context) {
    final meta = (report['meta'] as Map?) ?? const {};
    final biz = (meta['business'] as Map?) ?? const {};
    final revenue = (report['revenue'] as Map?) ?? const {};
    final taxes = (report['indirectTaxesCollected'] as Map?) ?? const {};
    final cogs = (report['cogs'] as Map?) ?? const {};
    final opex = ((report['operatingExpenses'] as List?) ?? const []).cast<Map>();
    final fromOps = ((revenue['fromOperations'] as List?) ?? const []).cast<Map>();
    final otherIncome = ((revenue['otherIncome'] as List?) ?? const []).cast<Map>();
    final period = (meta['period'] as Map?) ?? const {};

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Letterhead
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            border: Border.all(color: AppColors.divider),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            children: [
              Text(biz['name'] as String? ?? '',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
              if (biz['address'] != null)
                Text(biz['address'] as String,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
              if (biz['gstin'] != null)
                Text('GSTIN: ${biz['gstin']}',
                    style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: AppColors.textSecondary)),
              const SizedBox(height: 6),
              const Text('Statement of Profit & Loss',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              Text('For the period ${period['startDate']} to ${period['endDate']}',
                  style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        _Section(title: 'I. Revenue from operations'),
        for (final r in fromOps)
          // FB-01 (2026-09-01): null-safe label — a line item missing `label`
          // used to throw a cast error and blank the whole P&L body.
          _Row(label: (r['label'] as String?) ?? '', amount: (r['grossValue'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'Gross revenue', amount: (revenue['grossRevenue'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true),
        _Row(label: 'Less: GST collected (pass-through)', amount: (taxes['total'] as num?)?.toDouble() ?? 0, fmt: fmt),
        // Other income — membership sales/refunds (2026-08-26, founder:
        // membership plan purchases must be visible as their own P&L line).
        if (otherIncome.isNotEmpty) ...[
          _Section(title: 'I(b). Other income'),
          for (final r in otherIncome)
            _Row(label: (r['label'] as String?) ?? '', amount: (r['amount'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        ],
        _Row(label: 'II. Net revenue', amount: (revenue['netRevenue'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true, highlight: true),
        const SizedBox(height: 8),
        _Section(title: 'III. Cost of goods sold'),
        _Row(label: 'Ingredients', amount: (cogs['ingredients'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'Wastage', amount: (cogs['wastage'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'Total COGS', amount: (cogs['total'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true),
        const SizedBox(height: 8),
        _Row(label: 'IV. Gross profit (II - III)', amount: (report['grossProfit'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true, highlight: true),
        const SizedBox(height: 8),
        _Section(title: 'V. Operating expenses'),
        for (final e in opex)
          _Row(label: (e['label'] as String?) ?? '', amount: (e['amount'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'Total operating expenses', amount: (report['totalOperatingExpenses'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true),
        const SizedBox(height: 8),
        _Row(label: 'VI. EBITDA (IV - V)', amount: (report['ebitda'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true, highlight: true),
        _Row(label: 'VII. Depreciation', amount: (report['depreciation'] as num?)?.toDouble() ?? 0, fmt: fmt),
        _Row(label: 'VIII. Finance costs', amount: (report['financeCosts'] as num?)?.toDouble() ?? 0, fmt: fmt),
        _Row(label: 'IX. Tax expense', amount: (report['taxExpense'] as num?)?.toDouble() ?? 0, fmt: fmt),
        const Divider(thickness: 2),
        _Row(label: 'X. NET PROFIT / (LOSS)', amount: (report['netProfit'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true, big: true, highlight: true),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              const Text('Net margin %', style: TextStyle(fontStyle: FontStyle.italic, color: AppColors.textSecondary)),
              const Spacer(),
              // FB-23 (2026-09-01): guard + round — a missing field rendered
              // "null%" and a raw double printed full precision.
              Text('${(report['netMargin'] as num?)?.toStringAsFixed(1) ?? '0.0'}%', style: const TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Section(title: 'GST collected — memorandum'),
        _Row(label: 'CGST', amount: (taxes['cgst'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'SGST', amount: (taxes['sgst'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'IGST', amount: (taxes['igst'] as num?)?.toDouble() ?? 0, fmt: fmt, indent: true),
        _Row(label: 'Total GST collected', amount: (taxes['total'] as num?)?.toDouble() ?? 0, fmt: fmt, bold: true),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  const _Section({required this.title});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      color: AppColors.divider.withValues(alpha: 0.4),
      child: Text(title.toUpperCase(),
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w900, letterSpacing: 1.2)),
    );
  }
}

class _Row extends StatelessWidget {
  final String label;
  final double amount;
  final NumberFormat fmt;
  final bool bold;
  final bool big;
  final bool indent;
  final bool highlight;
  const _Row({
    required this.label, required this.amount, required this.fmt,
    this.bold = false, this.big = false, this.indent = false, this.highlight = false,
  });
  @override
  Widget build(BuildContext context) {
    return Container(
      color: highlight ? Colors.amber.withValues(alpha: 0.07) : null,
      padding: EdgeInsets.symmetric(horizontal: indent ? 24 : 8, vertical: big ? 10 : 4),
      child: Row(
        children: [
          Expanded(child: Text(label,
              style: TextStyle(
                fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
                fontSize: big ? 16 : 13,
              ))),
          Text(fmt.format(amount),
              style: TextStyle(
                fontWeight: bold ? FontWeight.w900 : FontWeight.w600,
                fontSize: big ? 16 : 13,
                fontFeatures: const [FontFeature.tabularFigures()],
              )),
        ],
      ),
    );
  }
}
