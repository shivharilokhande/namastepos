// NamastePOS mobile — Tax Invoices (Push 15f).
//
// GST Rule 46–compliant invoices auto-issued from collected orders.
// Owner can list, filter by date range, view detail, and print/share via
// the `printing` package which routes through the OS share sheet (so the
// invoice goes to the system AirPrint dialog, WhatsApp, email, etc.).

import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../constants/feature_keys.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/plan_gate.dart';

class TaxInvoicesScreen extends StatefulWidget {
  const TaxInvoicesScreen({super.key});

  @override
  State<TaxInvoicesScreen> createState() => _TaxInvoicesScreenState();
}

class _TaxInvoicesScreenState extends State<TaxInvoicesScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _invoices = [];
  DateTime _startDate = DateTime(DateTime.now().year, DateTime.now().month, 1);
  DateTime _endDate = DateTime.now();

  @override
  void initState() { super.initState(); _load(); }

  String _fmtDate(DateTime d) => d.toIso8601String().substring(0, 10);

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    setState(() { _loading = true; _error = null; });
    try {
      final list = await ApiService.instance.listTaxInvoices(
        biz.id,
        startDate: _fmtDate(_startDate),
        endDate: _fmtDate(_endDate),
      );
      setState(() => _invoices = list.cast<Map<String, dynamic>>());
    } catch (e) {
      setState(() => _error = e.toString());
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

  Future<void> _printInvoice(Map<String, dynamic> inv) async {
    final biz = context.read<AuthProvider>().business!;
    try {
      final bytes = await ApiService.instance.taxInvoicePdf(biz.id, inv['id'] as String);
      await Printing.layoutPdf(
        onLayout: (_) async => Uint8List.fromList(bytes),
        name: 'Invoice ${inv['invoiceNo']}',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't print the invoice — " + humanizeError(e))),
      );
    }
  }

  Future<void> _shareInvoice(Map<String, dynamic> inv) async {
    final biz = context.read<AuthProvider>().business!;
    try {
      final bytes = await ApiService.instance.taxInvoicePdf(biz.id, inv['id'] as String);
      await Printing.sharePdf(
        bytes: Uint8List.fromList(bytes),
        filename: 'tax_invoice_${(inv['invoiceNo'] as String).replaceAll(RegExp(r'[\/\\]'), '_')}.pdf',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't share the invoice — " + humanizeError(e))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    // 2026-09-05 (review #3): `tax_invoices` is a client-enforced key and the
    // drawer tile was its only gate — the Registers screen's Invoices tab and
    // its income-row sheet pushed straight in. Gate the DESTINATION, same
    // pattern as P&L / Registers, so every door has to pass it.
    if (!PlanGate.allows(context, Features.taxInvoices)) {
      return const PlanGate(
        featureKey: Features.taxInvoices,
        child: SizedBox.shrink(),
      );
    }
    final fmt = AppFmt.inr2;
    final dateFmt = DateFormat('dd MMM, hh:mm a');

    final total = _invoices.fold<double>(0, (s, i) => s + ((i['totalInr'] as num?)?.toDouble() ?? 0));

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Tax Invoices'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: Column(
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            color: AppColors.surface,
            child: Row(
              children: [
                InkWell(
                  onTap: _pickRange,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    child: Row(
                      children: [
                        const Icon(Icons.date_range, size: 18),
                        const SizedBox(width: 6),
                        Text(
                          '${DateFormat('dd MMM').format(_startDate)} – ${DateFormat('dd MMM yyyy').format(_endDate)}',
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ),
                const Spacer(),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text('TOTAL INVOICED',
                        style: TextStyle(fontSize: 10, color: AppColors.textSecondary, letterSpacing: 0.5)),
                    Text(fmt.format(total),
                        style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                    Text('${_invoices.length} invoices',
                        style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
                  ],
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                ? Center(child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_error!,
                        style: const TextStyle(color: AppColors.error)),
                  ))
                : _invoices.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(32),
                        child: Text(
                          'No invoices in this range.\n\n'
                          'Invoices are issued automatically when an order is marked collected.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textSecondary),
                        ),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        itemCount: _invoices.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final inv = _invoices[i];
                          final isCancelled = inv['status'] == 'cancelled';
                          return ListTile(
                            onTap: () => Navigator.push(context, MaterialPageRoute(
                                builder: (_) => TaxInvoiceDetailScreen(invoiceId: inv['id'] as String))),
                            title: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    (inv['invoiceNo'] as String?) ?? '—',
                                    style: TextStyle(
                                      fontFamily: 'monospace',
                                      fontWeight: FontWeight.w800,
                                      decoration: isCancelled ? TextDecoration.lineThrough : null,
                                      color: isCancelled ? AppColors.textHint : null,
                                    ),
                                  ),
                                ),
                                Text(fmt.format((inv['totalInr'] as num?)?.toDouble() ?? 0),
                                    style: const TextStyle(fontWeight: FontWeight.w800)),
                              ],
                            ),
                            subtitle: Text(
                              [
                                dateFmt.format(DateTime.parse(inv['invoiceDate'] as String).toLocal()),
                                if ((inv['recipient'] as Map?)?['name'] != null) (inv['recipient'] as Map)['name'],
                              ].join(' · '),
                              style: const TextStyle(fontSize: 12),
                            ),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                IconButton(
                                  icon: const Icon(Icons.print_outlined, size: 22),
                                  tooltip: 'Print',
                                  onPressed: () => _printInvoice(inv),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.share_outlined, size: 22),
                                  tooltip: 'Share',
                                  onPressed: () => _shareInvoice(inv),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
          ),
        ],
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
class TaxInvoiceDetailScreen extends StatefulWidget {
  final String invoiceId;
  const TaxInvoiceDetailScreen({super.key, required this.invoiceId});

  @override
  State<TaxInvoiceDetailScreen> createState() => _TaxInvoiceDetailScreenState();
}

class _TaxInvoiceDetailScreenState extends State<TaxInvoiceDetailScreen> {
  Map<String, dynamic>? _inv;
  bool _loading = true;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    setState(() { _loading = true; _error = null; });
    try {
      _inv = await ApiService.instance.getTaxInvoice(biz.id, widget.invoiceId);
    } catch (e) {
      _error = e.toString();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _print() async {
    final biz = context.read<AuthProvider>().business!;
    try {
      final bytes = await ApiService.instance.taxInvoicePdf(biz.id, widget.invoiceId);
      await Printing.layoutPdf(
        onLayout: (_) async => Uint8List.fromList(bytes),
        name: 'Invoice ${_inv?['invoiceNo']}',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e))),
      );
    }
  }

  Future<void> _share() async {
    final biz = context.read<AuthProvider>().business!;
    try {
      final bytes = await ApiService.instance.taxInvoicePdf(biz.id, widget.invoiceId);
      await Printing.sharePdf(
        bytes: Uint8List.fromList(bytes),
        filename: 'tax_invoice_${(_inv?['invoiceNo'] as String?)?.replaceAll(RegExp(r'[\/\\]'), '_') ?? 'invoice'}.pdf',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    // Review #3 (2026-09-05): destination gate — see TaxInvoicesScreen.
    if (!PlanGate.allows(context, Features.taxInvoices)) {
      return const PlanGate(
        featureKey: Features.taxInvoices,
        child: SizedBox.shrink(),
      );
    }
    final fmt = AppFmt.inr2;
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        
        title: Text(_inv?['invoiceNo'] as String? ?? 'Invoice'),
        actions: [
          IconButton(icon: const Icon(Icons.share_outlined), onPressed: _share),
          IconButton(icon: const Icon(Icons.print), onPressed: _print),
        ],
      ),
      body: _loading
        ? const Center(child: CircularProgressIndicator())
        : _error != null
          ? Center(child: Text(_error!))
          : _inv == null
            ? const Center(child: Text('Not found'))
            : SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _LetterheadCard(supplier: _inv!['supplier'] as Map),
                    const SizedBox(height: 12),
                    _MetaCard(inv: _inv!),
                    const SizedBox(height: 12),
                    _RecipientCard(recipient: _inv!['recipient'] as Map),
                    const SizedBox(height: 12),
                    _ItemsCard(items: ((_inv!['items'] as List?) ?? const []).cast<Map>()),
                    const SizedBox(height: 12),
                    _TotalsCard(inv: _inv!, fmt: fmt),
                    if (_inv!['status'] == 'cancelled')
                      Container(
                        margin: const EdgeInsets.only(top: 12),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.error.withValues(alpha: 0.08),
                          border: Border.all(color: AppColors.error),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          'CANCELLED\n${_inv!['cancellationReason'] ?? ''}',
                          style: const TextStyle(color: AppColors.error, fontWeight: FontWeight.w800),
                        ),
                      ),
                  ],
                ),
              ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

class _LetterheadCard extends StatelessWidget {
  final Map supplier;
  const _LetterheadCard({required this.supplier});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Text('TAX INVOICE',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w900,
                color: AppColors.textSecondary, letterSpacing: 1.5)),
          const SizedBox(height: 4),
          Text(supplier['name'] as String? ?? '—',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
          if (supplier['address'] != null)
            Text(supplier['address'] as String, textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          if (supplier['gstin'] != null)
            Text('GSTIN: ${supplier['gstin']}',
                style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

class _MetaCard extends StatelessWidget {
  final Map inv;
  const _MetaCard({required this.inv});
  @override
  Widget build(BuildContext context) {
    final dt = DateTime.parse(inv['invoiceDate'] as String).toLocal();
    final items = [
      ['Invoice No', inv['invoiceNo'] as String? ?? '—'],
      ['Date & time', DateFormat('dd MMM yyyy, hh:mm a').format(dt)],
      ['FY', inv['fy'] as String? ?? '—'],
      ['Place of supply', '${inv['placeOfSupply'] ?? '—'} (${(inv['isInterstate'] == true) ? 'interstate' : 'intrastate'})'],
      ['Reverse charge', (inv['reverseCharge'] == true) ? 'Yes' : 'No'],
      ['Payment', '${inv['paymentMethod'] ?? '—'} (${inv['paymentStatus'] ?? '—'})'],
    ];
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: items.map((kv) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            children: [
              SizedBox(width: 130,
                  child: Text(kv[0],
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 12))),
              Expanded(
                  child: Text(kv[1],
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13))),
            ],
          ),
        )).toList(),
      ),
    );
  }
}

class _RecipientCard extends StatelessWidget {
  final Map recipient;
  const _RecipientCard({required this.recipient});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('RECIPIENT',
              style: TextStyle(fontSize: 10, color: AppColors.textSecondary, letterSpacing: 1.2, fontWeight: FontWeight.w900)),
          const SizedBox(height: 4),
          Text(recipient['name'] as String? ?? '—',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
          if (recipient['phone'] != null) Text('Phone: ${recipient['phone']}', style: const TextStyle(fontSize: 12)),
          if (recipient['gstin'] != null) Text('GSTIN: ${recipient['gstin']}',
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
          if (recipient['address'] != null) Text(recipient['address'] as String, style: const TextStyle(fontSize: 12)),
        ],
      ),
    );
  }
}

class _ItemsCard extends StatelessWidget {
  final List<Map> items;
  const _ItemsCard({required this.items});
  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
        color: AppColors.surface,
      ),
      child: Column(
        children: items.map((it) {
          final qty = (it['qty'] as num?)?.toDouble() ?? 0;
          final unit = (it['unitPricePaise'] as num?)?.toDouble() ?? 0;
          final gst = (it['gstAmountPaise'] as num?)?.toDouble() ?? 0;
          final total = (it['lineTotalPaise'] as num?)?.toDouble() ?? 0;
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(it['name'] as String,
                        style: const TextStyle(fontWeight: FontWeight.w700))),
                    Text('${(total / 100).toStringAsFixed(2)}',
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                  ],
                ),
                Text(
                  'HSN ${it['hsn'] ?? '—'} · $qty × ${AppFmt.moneyPaise(unit, decimals: true)} · GST ${it['gstPct'] ?? 0}% (${AppFmt.moneyPaise(gst, decimals: true)})',
                  style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
                ),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _TotalsCard extends StatelessWidget {
  final Map inv;
  final NumberFormat fmt;
  const _TotalsCard({required this.inv, required this.fmt});
  @override
  Widget build(BuildContext context) {
    Widget row(String label, double value, {bool bold = false, bool big = false}) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: [
            Expanded(child: Text(label,
                style: TextStyle(
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
                  fontSize: big ? 16 : 13,
                ))),
            Text(fmt.format(value),
                style: TextStyle(
                  fontWeight: bold ? FontWeight.w900 : FontWeight.w600,
                  fontSize: big ? 16 : 13,
                )),
          ],
        ),
      );
    }
    final subtotal = (inv['subtotalInr'] as num?)?.toDouble() ?? 0;
    final discount = (inv['discountInr'] as num?)?.toDouble() ?? 0;
    final cgst = (inv['cgstInr'] as num?)?.toDouble() ?? 0;
    final sgst = (inv['sgstInr'] as num?)?.toDouble() ?? 0;
    final igst = (inv['igstInr'] as num?)?.toDouble() ?? 0;
    final svc = (inv['serviceChargeInr'] as num?)?.toDouble() ?? 0;
    final roundOff = (inv['roundOffInr'] as num?)?.toDouble() ?? 0;
    final total = (inv['totalInr'] as num?)?.toDouble() ?? 0;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          row('Subtotal (taxable)', subtotal),
          if (discount != 0) row('Discount', -discount),
          if (inv['isInterstate'] == true) row('IGST', igst)
          else ...[ row('CGST', cgst), row('SGST', sgst) ],
          if (svc != 0) row('Service charge', svc),
          row('Round-off', roundOff),
          const Divider(),
          row('Total', total, bold: true, big: true),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(inv['amountInWords'] as String? ?? '',
                style: const TextStyle(fontStyle: FontStyle.italic, fontSize: 11, color: AppColors.textSecondary)),
          ),
        ],
      ),
    );
  }
}
