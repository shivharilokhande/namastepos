// NamastePOS mobile — QR codes per table (Push 16e).
//
// Owner picks a table → preview + Print / Share / Save-as-PNG.
// All three actions route through the `printing` + `pdf` packages
// already in pubspec, so no new dependencies needed. The QR itself is
// drawn by `pw.BarcodeWidget(Barcode.qrCode())` — the same QR engine the
// printing package uses for thermal-receipt QRs.
//
// Owner-only screen; gated by the `qr_codes` permission in the drawer.

import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';

import '../../config/app_config.dart';
import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class QrCodesScreen extends StatefulWidget {
  const QrCodesScreen({super.key});

  @override
  State<QrCodesScreen> createState() => _QrCodesScreenState();
}

class _QrCodesScreenState extends State<QrCodesScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _tables = [];

  /// Per-table token cache so we don't refetch on every tap.
  final Map<String, String> _tokenByTable = {};

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    setState(() { _loading = true; _error = null; });
    try {
      final r = await ApiService.instance.listTables(biz.id);
      setState(() => _tables = r.cast<Map<String, dynamic>>());
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<String?> _tokenFor(String tableId) async {
    if (_tokenByTable.containsKey(tableId)) return _tokenByTable[tableId];
    final biz = context.read<AuthProvider>().business!;
    try {
      final token = await ApiService.instance.qrTokenForTable(biz.id, tableId);
      if (token != null && token.isNotEmpty) {
        _tokenByTable[tableId] = token;
      }
      return token;
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't load table tokens — " + humanizeError(e))),
      );
      return null;
    }
  }

  /// Render a single-page PDF: business name + table label + QR + URL.
  /// Used as the source for Print, Share, and Save-as-PNG.
  Future<Uint8List> _buildPdf(Map<String, dynamic> table, String url) async {
    final bizName = context.read<AuthProvider>().business?.name ?? 'NamastePOS';
    final tableLabel = (table['label'] as String?) ?? '—';
    final floorName = (table['floorName'] as String?) ?? '';

    final doc = pw.Document();
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat.a6,           // table-tent friendly
      margin: const pw.EdgeInsets.all(16),
      build: (ctx) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.center,
        mainAxisAlignment: pw.MainAxisAlignment.center,
        children: [
          pw.Text(bizName,
              style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold)),
          pw.SizedBox(height: 4),
          pw.Text('Table $tableLabel',
              style: pw.TextStyle(fontSize: 32, fontWeight: pw.FontWeight.bold)),
          if (floorName.isNotEmpty)
            pw.Text(floorName, style: const pw.TextStyle(fontSize: 11, color: PdfColors.grey700)),
          pw.SizedBox(height: 16),
          pw.Container(
            padding: const pw.EdgeInsets.all(10),
            decoration: pw.BoxDecoration(
              border: pw.Border.all(color: PdfColors.deepOrange, width: 1.5, style: pw.BorderStyle.dashed),
              borderRadius: pw.BorderRadius.circular(8),
            ),
            child: pw.BarcodeWidget(
              data: url,
              barcode: pw.Barcode.qrCode(),
              width: 180,
              height: 180,
              drawText: false,
            ),
          ),
          pw.SizedBox(height: 14),
          pw.Text('Scan to view menu & order',
              style: const pw.TextStyle(fontSize: 11, color: PdfColors.grey700)),
          pw.SizedBox(height: 2),
          pw.Text('No app download needed',
              style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey600)),
        ],
      ),
    ));
    return doc.save();
  }

  String _guestUrl(String token) {
    // Mirror the dashboard's `${origin}/qr/<token>` shape. Hardcode-audit
    // fix (2026-08-24): host comes from AppConfig.webAppUrl (dart-define
    // WEB_APP_URL) — these URLs end up on PRINTED table tents, so a
    // staging build must be able to point elsewhere.
    return '${AppConfig.webAppUrl}/qr/$token';
  }

  Future<void> _printQr(Map<String, dynamic> t) async {
    final token = await _tokenFor(t['id'] as String);
    if (token == null) return;
    try {
      final bytes = await _buildPdf(t, _guestUrl(token));
      await Printing.layoutPdf(
        onLayout: (_) async => bytes,
        name: 'qr-table-${t['label']}',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't print — " + humanizeError(e))),
      );
    }
  }

  Future<void> _shareQr(Map<String, dynamic> t) async {
    final token = await _tokenFor(t['id'] as String);
    if (token == null) return;
    try {
      final bytes = await _buildPdf(t, _guestUrl(token));
      await Printing.sharePdf(
        bytes: bytes,
        filename: 'qr-table-${t['label']}.pdf',
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't share — " + humanizeError(e))),
      );
    }
  }

  Future<void> _rotateQr(Map<String, dynamic> t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Rotate QR?'),
        content: const Text(
            'The current printed QR for this table will stop working. '
            'You\'ll need to print + replace the table tent.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: AppColors.warning),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Rotate')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final biz = context.read<AuthProvider>().business!;
    try {
      final newTok = await ApiService.instance.rotateQrToken(biz.id, t['id'] as String);
      _tokenByTable[t['id'] as String] = newTok ?? '';
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('QR rotated. Reprint and replace.')),
      );
      setState(() {});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't rotate the token — " + humanizeError(e))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('QR codes'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      body: _loading
        ? const Center(child: CircularProgressIndicator())
        : _error != null
          ? Center(child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(_error!, style: const TextStyle(color: AppColors.error))))
          : _tables.isEmpty
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(32),
                  child: Text(
                    'No tables yet.\nAdd tables under the Tables screen first.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textSecondary)),
                ),
              )
            : RefreshIndicator(
                onRefresh: _load,
                child: ListView.separated(
                  itemCount: _tables.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final t = _tables[i];
                    final isDisabled = t['qrEnabled'] == false;
                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: AppColors.primary.withValues(alpha: 0.1),
                        child: Text(
                          (t['label'] as String?) ?? '?',
                          style: const TextStyle(
                            fontWeight: FontWeight.w900,
                            color: AppColors.primary,
                          ),
                        ),
                      ),
                      title: Text('Table ${t['label'] ?? '—'}',
                          style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text(
                        '${t['seats'] ?? '?'} seats · ${t['floorName'] ?? '—'}'
                        '${isDisabled ? " · QR disabled" : ""}',
                        style: TextStyle(
                            fontSize: 12,
                            color: isDisabled ? AppColors.error : AppColors.textSecondary),
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: const Icon(Icons.share_outlined, size: 22),
                            tooltip: 'Share',
                            onPressed: isDisabled ? null : () => _shareQr(t),
                          ),
                          IconButton(
                            icon: const Icon(Icons.print, size: 22),
                            tooltip: 'Print',
                            onPressed: isDisabled ? null : () => _printQr(t),
                          ),
                          IconButton(
                            icon: const Icon(Icons.refresh, size: 22, color: AppColors.warning),
                            tooltip: 'Rotate token',
                            onPressed: () => _rotateQr(t),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }
}
