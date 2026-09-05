// NamastePOS — the same receipt, rendered as a PDF.
//
// WHY this exists (2026-09-05). The Bluetooth ESC/POS path in
// printer_service.dart is an Android path in practice. Apple does not let a
// normal app open a classic-Bluetooth (SPP) socket at all — only MFi-certified
// accessories via the External Accessory framework — and the 58mm/80mm thermal
// printers Indian restaurants actually buy are classic-BT and not certified.
// So on an iPhone `PrintBluetoothThermal.pairedBluetooths` returns an empty
// list forever, and every screen that gated on "is a printer connected?" simply
// did nothing.
//
// This file is the path that DOES work on an iPhone: the same receipt laid out
// on an 80mm roll page and handed to the OS print/share sheet through the
// `printing` package — already shipped and used by Tax invoices, QR codes,
// Register reports and the P&L export, so this is an existing, exercised
// dependency and not a new bet. From that sheet the owner can AirPrint to any
// AirPrint printer on the restaurant's Wi-Fi, save to Files, or send the bill
// to the customer on WhatsApp.
//
// Money is spelled "Rs 120.00" here and not "₹120.00" on purpose: the app
// bundles no fonts, so a locally built PDF has only the PDF built-in Helvetica,
// which carries no rupee glyph. A blank box where the amount's currency should
// be, on a document a customer keeps, is worse than the ASCII spelling.

import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../models/business.dart';
import '../models/order.dart';

class ReceiptPdf {
  ReceiptPdf._();

  /// 80mm continuous roll — the same paper the ESC/POS path targets, and a
  /// format AirPrint is happy to scale onto A4 if that is all the owner has.
  static const PdfPageFormat pageFormat = PdfPageFormat.roll80;

  static String money(num rupees) => 'Rs ${rupees.toStringAsFixed(2)}';

  static String _qty(double q) =>
      q == q.roundToDouble() ? q.toInt().toString() : q.toString();

  static String _two(int v) => v.toString().padLeft(2, '0');

  static String _stamp(DateTime t) {
    final d = t.toLocal();
    return '${d.year}-${_two(d.month)}-${_two(d.day)} '
        '${_two(d.hour)}:${_two(d.minute)}';
  }

  // ── Small layout helpers ────────────────────────────────────────────
  static pw.Widget _line(String s,
          {double size = 9, bool bold = false, bool center = true}) =>
      pw.Container(
        width: double.infinity,
        child: pw.Text(
          s,
          textAlign: center ? pw.TextAlign.center : pw.TextAlign.left,
          style: pw.TextStyle(
            fontSize: size,
            fontWeight: bold ? pw.FontWeight.bold : pw.FontWeight.normal,
          ),
        ),
      );

  static pw.Widget _hr() => pw.Container(
        margin: const pw.EdgeInsets.symmetric(vertical: 4),
        height: 0.6,
        color: PdfColors.grey700,
      );

  static pw.Widget _row(String left, String right, {bool bold = false}) {
    final style = pw.TextStyle(
      fontSize: 9,
      fontWeight: bold ? pw.FontWeight.bold : pw.FontWeight.normal,
    );
    return pw.Padding(
      padding: const pw.EdgeInsets.symmetric(vertical: 1),
      child: pw.Row(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          pw.Expanded(child: pw.Text(left, style: style)),
          pw.SizedBox(width: 8),
          pw.Text(right, style: style),
        ],
      ),
    );
  }

  static List<pw.Widget> _header(Business business) => [
        _line(business.name, size: 13, bold: true),
        if ((business.address ?? '').isNotEmpty) _line(business.address!, size: 8),
        if ((business.gstin ?? '').isNotEmpty)
          _line('GSTIN: ${business.gstin}', size: 8),
        _hr(),
      ];

  /// The statutory declaration a composition dealer's bill of supply must
  /// carry. Printed verbatim — nothing here is a paraphrase.
  static const String _compositionDeclaration =
      'Composition taxable person, not eligible to collect tax on supplies';

  static pw.Document _doc(List<pw.Widget> children) {
    final doc = pw.Document();
    doc.addPage(
      pw.Page(
        pageFormat: pageFormat,
        build: (_) => pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.stretch,
          mainAxisSize: pw.MainAxisSize.min,
          children: children,
        ),
      ),
    );
    return doc;
  }

  // ── Documents ───────────────────────────────────────────────────────

  /// "· Large" / "+ extra cheese" under an item line (round 2, MOB #1).
  static List<pw.Widget> _configRows(OrderItem item) => [
        if (item.variantLabel != null && item.variantLabel!.trim().isNotEmpty)
          _line('    · ${item.variantLabel!.trim()}', size: 8, center: false),
        for (final mod in item.modifierNames)
          _line('    + $mod', size: 8, center: false),
      ];

  /// Tax lines for one order — mirrors `PrinterService._buildReceipt`.
  static List<pw.Widget> _taxRows(Order order, String Function(double) money) {
    final est = order.synced ? '' : ' (est.)';
    if (order.cgst > 0 || order.sgst > 0) {
      return [
        _row('CGST$est', money(order.cgst)),
        _row('SGST$est', money(order.sgst)),
      ];
    }
    if (order.igst > 0) return [_row('IGST$est', money(order.igst))];
    if (order.tax > 0) return [_row('Tax$est', money(order.tax))];
    return const [];
  }

  /// One order's receipt. Mirrors `PrinterService._buildReceipt`, including
  /// the composition-dealer heading and declaration (backend migration 092).
  static Future<Uint8List> orderReceipt({
    required Business business,
    required Order order,
    String? title,
    bool duplicate = false,
  }) {
    final composition = business.gstScheme == 'composition';
    return _doc([
      ..._header(business),
      _line(title ?? (composition ? 'BILL OF SUPPLY' : 'Receipt'), bold: true),
      if (duplicate) _line('** DUPLICATE **', size: 8),
      _line('Order #${order.orderNo}', size: 8),
      _line(_stamp(order.createdAt), size: 8),
      _hr(),
      for (final item in order.items) ...[
        _row('${_qty(item.qty)}x ${item.name}', money(item.lineTotal)),
        // 2026-09-06 (round 2, MOB #1): size + add-ons under the line, same
        // layout as the thermal receipt / server printerService.js.
        ..._configRows(item),
      ],
      _hr(),
      _row('Subtotal', money(order.subtotal)),
      // `tax` is 0 for a composition dealer because the SERVER refuses to put
      // GST on their orders; this renderer deliberately does not try to
      // second-guess the stored order row.
      // 2026-09-05 (review #2): CGST/SGST (or IGST) split when the server row
      // carries it; "(est.)" on an order still waiting in the offline queue.
      ..._taxRows(order, money),
      if (order.discount > 0) _row('Discount', '-${money(order.discount)}'),
      _row('TOTAL', money(order.total), bold: true),
      if (composition) ...[
        pw.SizedBox(height: 4),
        _line(_compositionDeclaration, size: 7),
      ],
      _hr(),
      _line('Thank you, visit again!', size: 8),
    ]).save();
  }

  /// One consolidated bill for a whole table session — the document the diner
  /// gets at settlement. Mirrors `PrinterService.printSessionBill`, including
  /// the grouping of identical lines across KOTs.
  static Future<Uint8List> sessionBill({
    required Map<String, dynamic> session,
    required Business business,
  }) {
    final composition = business.gstScheme == 'composition';

    final sessId = (session['id'] ?? '').toString();
    final billNo = sessId.length >= 8
        ? sessId.substring(sessId.length - 8).toUpperCase()
        : sessId.toUpperCase();

    final tableLabel = (session['tableLabel'] ?? '').toString();
    final guests = session['guestCount'];
    final closedAtRaw = session['closedAt'] ?? session['openedAt'];
    final closedAt =
        closedAtRaw == null ? null : DateTime.tryParse(closedAtRaw.toString());
    final cust = (session['customerName'] ?? '').toString();
    final phone = (session['customerPhone'] ?? '').toString();
    final who = [cust, phone].where((s) => s.isNotEmpty).join(' - ');

    final grouped = <String, Map<String, dynamic>>{};
    for (final it in (session['items'] as List?) ?? const []) {
      if (it is! Map) continue;
      final name = (it['name'] ?? '').toString();
      final price = (it['price'] as num?)?.toDouble() ?? 0;
      final qty = (it['qty'] as num?)?.toDouble() ?? 0;
      final key = '$name|$price';
      final existing = grouped[key];
      if (existing == null) {
        grouped[key] = {
          'name': name,
          'qty': qty,
          'lineTotal': price * qty,
        };
      } else {
        existing['qty'] = (existing['qty'] as double) + qty;
        existing['lineTotal'] = (existing['lineTotal'] as double) + price * qty;
      }
    }

    final subtotal = (session['subtotalInr'] as num?)?.toDouble() ?? 0;
    final tax = (session['taxInr'] as num?)?.toDouble() ?? 0;
    final discount = (session['discountInr'] as num?)?.toDouble() ?? 0;
    final total = (session['totalInr'] as num?)?.toDouble() ?? 0;

    return _doc([
      ..._header(business),
      _line(composition ? 'BILL OF SUPPLY' : 'TAX INVOICE', bold: true),
      _line('Bill #$billNo', size: 8),
      if (tableLabel.isNotEmpty) _line('Table $tableLabel', size: 8),
      if (guests != null) _line('Guests: $guests', size: 8),
      if (closedAt != null) _line(_stamp(closedAt), size: 8),
      if (who.isNotEmpty) _line(who, size: 8),
      _hr(),
      for (final g in grouped.values)
        _row('${_qty(g['qty'] as double)}x ${g['name']}',
            money(g['lineTotal'] as double)),
      _hr(),
      _row('Subtotal', money(subtotal)),
      if (discount > 0) _row('Discount', '-${money(discount)}'),
      if (tax > 0) _row('Tax', money(tax)),
      _row('TOTAL', money(total), bold: true),
      if (composition) ...[
        pw.SizedBox(height: 4),
        _line(_compositionDeclaration, size: 7),
      ],
      _hr(),
      _line('Thank you, visit again!', size: 8),
    ]).save();
  }

  /// Tiny test page, so the owner can prove the print route end to end
  /// before a real customer is standing at the counter.
  static Future<Uint8List> testPage(Business? business) => _doc([
        _line(business?.name ?? 'NamastePOS', size: 13, bold: true),
        _line('Printer test', size: 8),
        _hr(),
        _line(_stamp(DateTime.now()), size: 8),
        _line('Sent from the NamastePOS app', size: 8),
        _hr(),
        _line('If you can read this, printing works.', size: 8),
      ]).save();

  // ── Delivery ────────────────────────────────────────────────────────

  /// Open the OS print sheet (AirPrint on iOS, the Android print service on
  /// Android). Returns false if the owner cancelled the sheet.
  static Future<bool> openPrintSheet(Uint8List bytes, {required String name}) =>
      Printing.layoutPdf(onLayout: (_) async => bytes, name: name);

  /// Hand the PDF to the OS share sheet — WhatsApp, email, Files.
  static Future<bool> share(Uint8List bytes, {required String filename}) =>
      Printing.sharePdf(bytes: bytes, filename: filename);
}
