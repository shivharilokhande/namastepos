// NamastePOS mobile — Income / Expense / Invoice registers (Push 15h).
//
// Three audit-ready transaction registers in one screen, switched by
// tab. Each tab has a date range picker and PDF / Excel / CSV exports
// that go through the OS share sheet (so the file can be sent to
// WhatsApp, Mail, Drive, AirPrint).

import 'dart:io';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:typed_data';

import '../../constants/colors.dart';
import '../../constants/feature_keys.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../invoices/tax_invoices_screen.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/plan_gate.dart';

enum _Kind { income, expense, invoice }

class RegisterReportsScreen extends StatefulWidget {
  final _Kind initial;
  const RegisterReportsScreen._({required this.initial});

  static const incomeRoute = 'income';
  static const expenseRoute = 'expense';
  static const invoiceRoute = 'invoice';

  factory RegisterReportsScreen.income()   => const RegisterReportsScreen._(initial: _Kind.income);
  factory RegisterReportsScreen.expense()  => const RegisterReportsScreen._(initial: _Kind.expense);
  factory RegisterReportsScreen.invoices() => const RegisterReportsScreen._(initial: _Kind.invoice);

  @override
  State<RegisterReportsScreen> createState() => _RegisterReportsScreenState();
}

class _RegisterReportsScreenState extends State<RegisterReportsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;
  DateTime _startDate = DateTime(DateTime.now().year, DateTime.now().month, 1);
  DateTime _endDate = DateTime.now();
  String? _exporting;

  Map<String, dynamic>? _income;
  Map<String, dynamic>? _expense;
  Map<String, dynamic>? _invoice;
  bool _loadingIncome = false, _loadingExpense = false, _loadingInvoice = false;
  String? _errIncome, _errExpense, _errInvoice;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 3, vsync: this, initialIndex: widget.initial.index);
    _tabs.addListener(() { if (!_tabs.indexIsChanging) _loadForCurrentTab(); });
    _loadForCurrentTab();
  }

  @override
  void dispose() { _tabs.dispose(); super.dispose(); }

  String _fmt(DateTime d) => d.toIso8601String().substring(0, 10);

  Future<void> _loadForCurrentTab() async {
    switch (_tabs.index) {
      case 0: await _loadIncome(); break;
      case 1: await _loadExpense(); break;
      case 2: await _loadInvoice(); break;
    }
  }

  Future<void> _loadIncome() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loadingIncome = true; _errIncome = null; });
    try {
      _income = await ApiService.instance.incomeRegister(
        biz.id, startDate: _fmt(_startDate), endDate: _fmt(_endDate));
    } catch (e) { _errIncome = e.toString(); }
    finally { if (mounted) setState(() => _loadingIncome = false); }
  }
  Future<void> _loadExpense() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loadingExpense = true; _errExpense = null; });
    try {
      _expense = await ApiService.instance.expenseRegister(
        biz.id, startDate: _fmt(_startDate), endDate: _fmt(_endDate));
    } catch (e) { _errExpense = e.toString(); }
    finally { if (mounted) setState(() => _loadingExpense = false); }
  }
  /// Review #3 (2026-09-05): the Invoices tab is a second door into tax
  /// invoices and must honour `tax_invoices`, not just this screen's
  /// `registers` gate — on a custom plan or addon grant the two can differ.
  /// `read`, not `watch`: called from initState / tab listener / export
  /// callbacks. The build method uses [PlanGate.allows] so it re-renders when
  /// the plan changes.
  bool get _invoicesUnlocked =>
      context.read<AuthProvider>().has(Features.taxInvoices);

  Future<void> _loadInvoice() async {
    if (!_invoicesUnlocked) return; // locked tab renders the upgrade page
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loadingInvoice = true; _errInvoice = null; });
    try {
      _invoice = await ApiService.instance.invoiceRegister(
        biz.id, startDate: _fmt(_startDate), endDate: _fmt(_endDate));
    } catch (e) { _errInvoice = e.toString(); }
    finally { if (mounted) setState(() => _loadingInvoice = false); }
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
      _loadForCurrentTab();
    }
  }

  String get _kindStr {
    switch (_tabs.index) {
      case 0: return 'income';
      case 1: return 'expense';
      default: return 'invoice';
    }
  }

  Future<void> _export(String format) async {
    if (_tabs.index == 2 && !_invoicesUnlocked) return; // review #3
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _exporting = format);
    try {
      final bytes = await ApiService.instance.registerExport(
        biz.id,
        kind: _kindStr, format: format,
        startDate: _fmt(_startDate), endDate: _fmt(_endDate),
      );
      final filename = '${_kindStr}_register_${_fmt(_startDate)}_${_fmt(_endDate)}.$format';
      if (format == 'pdf') {
        await Printing.layoutPdf(
          onLayout: (_) async => Uint8List.fromList(bytes),
          name: filename,
        );
      } else {
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/$filename');
        await file.writeAsBytes(bytes);
        await SharePlus.instance.share(ShareParams(
            files: [XFile(file.path)],
            text: 'NamastePOS ${_kindStr} register ${_fmt(_startDate)} → ${_fmt(_endDate)}'));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't export the report — " + humanizeError(e))));
    } finally {
      if (mounted) setState(() => _exporting = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    // 2026-09-05 entitlement audit — same story as the P&L screen: the drawer
    // tile checked `registers`, the Reports / Monthly KPI cards pushed
    // straight past it. Gate the destination so every route in is covered.
    if (!PlanGate.allows(context, Features.registers)) {
      return const PlanGate(
        featureKey: Features.registers,
        child: SizedBox.shrink(),
      );
    }
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Reports'),
        bottom: TabBar(
          controller: _tabs,
          tabs: const [
            Tab(icon: Icon(Icons.attach_money, size: 18), text: 'Income'),
            Tab(icon: Icon(Icons.money_off, size: 18), text: 'Expense'),
            Tab(icon: Icon(Icons.receipt_long, size: 18), text: 'Invoices'),
          ],
        ),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _loadForCurrentTab),
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
                          const Icon(Icons.date_range, size: 18),
                          const SizedBox(width: 8),
                          Expanded(child: Text(
                            '${DateFormat('dd MMM').format(_startDate)} – ${DateFormat('dd MMM yyyy').format(_endDate)}',
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          )),
                          const Icon(Icons.expand_more, size: 16),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            color: AppColors.background,
            child: Row(
              children: [
                _exportChip('PDF', Icons.picture_as_pdf, 'pdf'),
                const SizedBox(width: 8),
                _exportChip('Excel', Icons.table_chart_outlined, 'xlsx'),
                const SizedBox(width: 8),
                _exportChip('CSV', Icons.download_outlined, 'csv'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [
                _IncomeTab(loading: _loadingIncome, error: _errIncome, data: _income, onRetry: _loadIncome),
                _ExpenseTab(loading: _loadingExpense, error: _errExpense, data: _expense, onRetry: _loadExpense),
                // Review #3: locked → PlanGate's upgrade page in place of
                // the register. The tab itself stays so the TabController's
                // fixed length and the `.invoices()` deep-link keep working.
                PlanGate.allows(context, Features.taxInvoices)
                    ? _InvoiceTab(loading: _loadingInvoice, error: _errInvoice, data: _invoice, onRetry: _loadInvoice)
                    : const PlanGate(
                        featureKey: Features.taxInvoices,
                        child: SizedBox.shrink(),
                      ),
              ],
            ),
          ),
        ],
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _exportChip(String label, IconData icon, String format) {
    final busy = _exporting == format;
    return Expanded(
      child: OutlinedButton.icon(
        onPressed: busy ? null : () => _export(format),
        icon: busy
          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(icon, size: 16),
        label: Text(label, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 12)),
        style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 10)),
      ),
    );
  }
}

// ── Tab bodies ──────────────────────────────────────────────────────────
class _IncomeTab extends StatelessWidget {
  final bool loading;
  final String? error;
  final Map<String, dynamic>? data;
  final VoidCallback onRetry;
  const _IncomeTab({required this.loading, required this.error, required this.data, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) return _ErrorView(error: error!, onRetry: onRetry);
    if (data == null) return const SizedBox();
    final rows = (data!['rows'] as List?) ?? const [];
    final t = (data!['totals'] as Map?) ?? const {};
    final fmt = AppFmt.inr2;

    if (rows.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text('No sales in this range.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.textSecondary)),
        ),
      );
    }
    return Column(
      children: [
        _TotalsBar(label: '${t['orderCount'] ?? 0} orders', items: [
          ['Taxable', fmt.format((t['taxableValue'] as num?)?.toDouble() ?? 0)],
          ['GST',     fmt.format((((t['cgst'] as num?)?.toDouble() ?? 0) + ((t['sgst'] as num?)?.toDouble() ?? 0) + ((t['igst'] as num?)?.toDouble() ?? 0)))],
          ['Total',   fmt.format((t['total'] as num?)?.toDouble() ?? 0)],
        ]),
        Expanded(
          child: ListView.separated(
            itemCount: rows.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (_, i) {
              final r = (rows[i] as Map).cast<String, dynamic>();
              // FB-01 (2026-09-01): null-safe — a missing/blank createdAt used to
              // throw (as String / DateTime.parse) and red-screen the whole tab.
              final rawDate = r['createdAt'] as String?;
              final d = rawDate == null ? null : DateTime.tryParse(rawDate)?.toLocal();
              return ListTile(
                dense: true,
                // Push 17e — tap any income row to see the tax invoice
                // generated from that order. Falls back to a quick summary
                // sheet when no invoice exists yet (pending/ready orders).
                onTap: () => _openIncomeDetail(context, r, fmt),
                title: Row(
                  children: [
                    Expanded(child: Text('#${r['orderNo'] ?? '—'}',
                        style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w800))),
                    Text(fmt.format((r['total'] as num?)?.toDouble() ?? 0),
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                  ],
                ),
                subtitle: Text(
                  '${d != null ? DateFormat('dd MMM, hh:mm a').format(d) : '—'} · ${(r['source'] ?? 'unknown').toString().replaceAll('_', ' ')}'
                  '${r['customerName'] != null ? " · ${r['customerName']}" : ""}',
                  style: const TextStyle(fontSize: 11),
                ),
                trailing: const Icon(Icons.chevron_right, size: 18, color: AppColors.textSecondary),
              );
            },
          ),
        ),
      ],
    );
  }
}

// Push 17e — find the tax invoice issued for this order and open the
// existing detail screen if one exists; otherwise show a quick summary
// sheet so the row still gives the owner more context than the list.
Future<void> _openIncomeDetail(
    BuildContext context, Map<String, dynamic> row,
    NumberFormat fmt) async {
  final biz = context.read<AuthProvider>().business;
  if (biz == null) return;
  final orderId = row['id'] as String?;
  if (orderId == null) return;
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => _IncomeDetailSheet(orderRow: row, businessId: biz.id),
  );
}

class _IncomeDetailSheet extends StatefulWidget {
  final Map<String, dynamic> orderRow;
  final String businessId;
  const _IncomeDetailSheet({required this.orderRow, required this.businessId});
  @override
  State<_IncomeDetailSheet> createState() => _IncomeDetailSheetState();
}

class _IncomeDetailSheetState extends State<_IncomeDetailSheet> {
  String? _invoiceId;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _findInvoice();
  }

  Future<void> _findInvoice() async {
    // Review #3 (2026-09-05): no tax-invoice lookup (and no "Open tax
    // invoice" button) without the key; the detail screen is gated too.
    if (!context.read<AuthProvider>().has(Features.taxInvoices)) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    try {
      // List endpoint by order date range — narrow to today by default,
      // since most owners look up recent orders. If not found we just
      // show the summary block.
      final d = DateTime.parse(widget.orderRow['createdAt'] as String).toLocal();
      final dateStr = d.toIso8601String().substring(0, 10);
      final invs = await ApiService.instance.listTaxInvoices(
        widget.businessId, startDate: dateStr, endDate: dateStr,
      );
      final orderId = widget.orderRow['id'] as String?;
      final match = invs.cast<Map<String, dynamic>>().firstWhere(
        (i) => i['orderId'] == orderId,
        orElse: () => <String, dynamic>{},
      );
      if (match['id'] != null) {
        _invoiceId = match['id'] as String;
      }
    } catch (_) { /* swallow */ }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final fmt = AppFmt.inr2;
    final r = widget.orderRow;
    final d = DateTime.parse(r['createdAt'] as String).toLocal();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              width: 36, height: 4,
              decoration: BoxDecoration(
                color: AppColors.divider,
                borderRadius: BorderRadius.circular(2),
              ),
              margin: const EdgeInsets.symmetric(vertical: 6),
            ),
            Text('Order #${r['orderNo'] ?? '—'}',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
            Text(
              DateFormat('dd MMM yyyy, hh:mm a').format(d),
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
            ),
            const Divider(height: 24),
            _kv('Customer', r['customerName'] ?? '—'),
            _kv('Phone', r['customerPhone'] ?? '—'),
            _kv('Source', (r['source'] ?? '—').toString().replaceAll('_', ' ')),
            _kv('Status', (r['status'] ?? '—').toString()),
            _kv('Payment', (r['paymentMethod'] ?? '—').toString()),
            const Divider(height: 24),
            _kv('Taxable', fmt.format((r['taxableValue'] as num?)?.toDouble() ?? 0)),
            _kv('CGST',    fmt.format((r['cgst'] as num?)?.toDouble() ?? 0)),
            _kv('SGST',    fmt.format((r['sgst'] as num?)?.toDouble() ?? 0)),
            _kv('IGST',    fmt.format((r['igst'] as num?)?.toDouble() ?? 0)),
            _kv('Service', fmt.format((r['serviceCharge'] as num?)?.toDouble() ?? 0)),
            _kv('Discount', fmt.format((r['discount'] as num?)?.toDouble() ?? 0)),
            const Divider(height: 24),
            _kv('TOTAL', fmt.format((r['total'] as num?)?.toDouble() ?? 0), bold: true, big: true),
            const SizedBox(height: 12),
            if (_loading)
              const Center(child: Padding(
                padding: EdgeInsets.all(8),
                child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              ))
            else if (_invoiceId != null)
              ElevatedButton.icon(
                icon: const Icon(Icons.receipt_long),
                label: const Text('Open tax invoice'),
                onPressed: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(
                    builder: (_) => TaxInvoiceDetailScreen(invoiceId: _invoiceId!),
                  ));
                },
              )
            else
              const Text(
                'No tax invoice generated yet (order not collected).',
                style: TextStyle(fontSize: 11, color: AppColors.textSecondary),
                textAlign: TextAlign.center,
              ),
          ],
        ),
      ),
    );
  }

  Widget _kv(String k, String v, {bool bold = false, bool big = false}) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: [
            Expanded(
              child: Text(k, style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: big ? 14 : 12,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
              )),
            ),
            Text(v, style: TextStyle(
              fontSize: big ? 18 : 13,
              fontWeight: bold ? FontWeight.w900 : FontWeight.w700,
            )),
          ],
        ),
      );
}

class _ExpenseTab extends StatelessWidget {
  final bool loading;
  final String? error;
  final Map<String, dynamic>? data;
  final VoidCallback onRetry;
  const _ExpenseTab({required this.loading, required this.error, required this.data, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) return _ErrorView(error: error!, onRetry: onRetry);
    if (data == null) return const SizedBox();
    final rows = (data!['rows'] as List?) ?? const [];
    final t = (data!['totals'] as Map?) ?? const {};
    final summary = (data!['summary'] as List?) ?? const [];
    final fmt = AppFmt.inr2;

    if (rows.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text('No expenses in this range.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.textSecondary)),
        ),
      );
    }
    return Column(
      children: [
        _TotalsBar(label: '${t['entryCount'] ?? 0} entries', items: [
          ['Total', fmt.format((t['total'] as num?)?.toDouble() ?? 0)],
        ]),
        Expanded(
          child: ListView(
            children: [
              for (final raw in rows) ...[
                Builder(builder: (ctx) {
                  final r = (raw as Map).cast<String, dynamic>();
                  final d = r['date'] != null ? DateTime.tryParse(r['date'] as String)?.toLocal() : null;
                  return ListTile(
                    dense: true,
                    // Push 17e — tap to see full expense detail
                    onTap: () => _openExpenseDetail(ctx, r, fmt),
                    title: Row(
                      children: [
                        Expanded(child: Text((r['category'] ?? '—').toString().replaceAll('_', ' '),
                            style: const TextStyle(fontWeight: FontWeight.w800))),
                        Text(fmt.format((r['amount'] as num?)?.toDouble() ?? 0),
                            style: const TextStyle(fontWeight: FontWeight.w800)),
                      ],
                    ),
                    subtitle: Text(
                      '${d != null ? DateFormat('dd MMM yyyy').format(d) : "—"}'
                      '${r['description'] != null && (r['description'] as String).isNotEmpty ? " · ${r['description']}" : ""}',
                      style: const TextStyle(fontSize: 11),
                    ),
                    trailing: const Icon(Icons.chevron_right, size: 18, color: AppColors.textSecondary),
                  );
                }),
                const Divider(height: 1),
              ],
              if (summary.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 16),
                  child: Text('BY CATEGORY',
                      style: TextStyle(fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w900, color: AppColors.textSecondary)),
                ),
                const SizedBox(height: 4),
                for (final raw in summary)
                  Builder(builder: (_) {
                    final s = (raw as Map).cast<String, dynamic>();
                    return ListTile(
                      dense: true,
                      title: Text((s['category'] ?? '—').toString().replaceAll('_', ' ')),
                      trailing: Text(fmt.format((s['amount'] as num?)?.toDouble() ?? 0),
                          style: const TextStyle(fontWeight: FontWeight.w800)),
                    );
                  }),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

// Push 17e — expense detail sheet
void _openExpenseDetail(
    BuildContext context, Map<String, dynamic> row, NumberFormat fmt) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) {
      final d = row['date'] != null
          ? DateTime.tryParse(row['date'] as String)?.toLocal()
          : null;
      Widget kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            SizedBox(width: 110,
                child: Text(k, style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 12))),
            Expanded(child: Text(v,
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14))),
          ],
        ),
      );
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: 36, height: 4,
                decoration: BoxDecoration(
                  color: AppColors.divider,
                  borderRadius: BorderRadius.circular(2),
                ),
                margin: const EdgeInsets.symmetric(vertical: 6),
              ),
              Text((row['category'] ?? '—').toString().replaceAll('_', ' ').toUpperCase(),
                  style: const TextStyle(fontSize: 11, letterSpacing: 1.2,
                      fontWeight: FontWeight.w900, color: AppColors.textSecondary)),
              Text(fmt.format((row['amount'] as num?)?.toDouble() ?? 0),
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
              const Divider(height: 24),
              kv('Date',     d != null ? DateFormat('dd MMM yyyy').format(d) : '—'),
              kv('Category', (row['category'] ?? '—').toString().replaceAll('_', ' ')),
              kv('Note',     (row['description'] as String?)?.isNotEmpty == true ? row['description'] as String : '—'),
              if (row['receiptUrl'] != null) ...[
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  icon: const Icon(Icons.receipt_outlined),
                  label: const Text('View receipt'),
                  // FF-402 code-review — was `() { /* TODO */ }` — a
                  // dead button. Now opens the receipt in the browser /
                  // external viewer. Failure surfaces as a snackbar so
                  // owners don't tap into silence.
                  onPressed: () async {
                    final raw = row['receiptUrl']?.toString();
                    if (raw == null || raw.isEmpty) return;
                    final uri = Uri.tryParse(raw);
                    final messenger = ScaffoldMessenger.of(context);
                    if (uri == null) {
                      messenger.showSnackBar(const SnackBar(
                        content: Text('Receipt link is invalid'),
                      ));
                      return;
                    }
                    try {
                      final ok = await launchUrl(
                        uri, mode: LaunchMode.externalApplication);
                      if (!ok) {
                        messenger.showSnackBar(const SnackBar(
                          content: Text('Could not open receipt'),
                        ));
                      }
                    } catch (e) {
                      messenger.showSnackBar(SnackBar(
                        content: Text('Could not open receipt: $e'),
                      ));
                    }
                  },
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}

class _InvoiceTab extends StatelessWidget {
  final bool loading;
  final String? error;
  final Map<String, dynamic>? data;
  final VoidCallback onRetry;
  const _InvoiceTab({required this.loading, required this.error, required this.data, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) return _ErrorView(error: error!, onRetry: onRetry);
    if (data == null) return const SizedBox();
    final rows = (data!['rows'] as List?) ?? const [];
    final t = (data!['totals'] as Map?) ?? const {};
    final fmt = AppFmt.inr2;

    if (rows.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text(
            'No tax invoices in this range.\n\nInvoices are auto-issued when an order is collected.',
            textAlign: TextAlign.center, style: TextStyle(color: AppColors.textSecondary)),
        ),
      );
    }
    return Column(
      children: [
        _TotalsBar(label: '${t['invoiceCount'] ?? 0} issued${(t['cancelledCount'] ?? 0) > 0 ? " · ${t['cancelledCount']} cancelled" : ""}', items: [
          ['Taxable', fmt.format((t['taxableValue'] as num?)?.toDouble() ?? 0)],
          ['Total',   fmt.format((t['total'] as num?)?.toDouble() ?? 0)],
        ]),
        Expanded(
          child: ListView.separated(
            itemCount: rows.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (_, i) {
              final r = (rows[i] as Map).cast<String, dynamic>();
              // FB-01 (2026-09-01): null-safe — a missing invoiceDate/invoiceNo/id
              // used to throw (as String / DateTime.parse) and red-screen the tab.
              final rawDate = r['invoiceDate'] as String?;
              final d = rawDate == null ? null : DateTime.tryParse(rawDate)?.toLocal();
              final invoiceId = r['id'] as String?;
              final cancelled = r['status'] == 'cancelled';
              return ListTile(
                dense: true,
                // Push 17e — tap row to open the full tax invoice detail
                onTap: invoiceId == null ? null : () {
                  Navigator.push(context, MaterialPageRoute(
                    builder: (_) => TaxInvoiceDetailScreen(invoiceId: invoiceId),
                  ));
                },
                title: Row(
                  children: [
                    Expanded(child: Text(
                      (r['invoiceNo'] as String?) ?? '—',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w800,
                        decoration: cancelled ? TextDecoration.lineThrough : null,
                        color: cancelled ? AppColors.textHint : null,
                      ),
                    )),
                    Text(fmt.format((r['total'] as num?)?.toDouble() ?? 0),
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                  ],
                ),
                subtitle: Text(
                  '${d != null ? DateFormat('dd MMM, hh:mm a').format(d) : '—'}'
                  '${r['recipientName'] != null ? " · ${r['recipientName']}" : ""}'
                  '${r['recipientGstin'] != null ? " · GSTIN ${r['recipientGstin']}" : ""}',
                  style: const TextStyle(fontSize: 11),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _TotalsBar extends StatelessWidget {
  final String label;
  final List<List<String>> items;
  const _TotalsBar({required this.label, required this.items});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.08),
        border: Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      child: Row(
        children: [
          Text(label.toUpperCase(),
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w900, letterSpacing: 0.8)),
          const Spacer(),
          for (final kv in items) Padding(
            padding: const EdgeInsets.only(left: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(kv[0],
                    style: const TextStyle(fontSize: 9, color: AppColors.textSecondary, letterSpacing: 0.6)),
                Text(kv[1], style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: AppColors.error, size: 36),
            const SizedBox(height: 8),
            Text(error, style: const TextStyle(color: AppColors.error), textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
