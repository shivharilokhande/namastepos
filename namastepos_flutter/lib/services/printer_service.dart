// NamastePOS — Thermal printer service.
//
// Direct Bluetooth ESC/POS printing from the mobile app.
//
//   1. The user pairs their thermal printer via the OS Bluetooth Settings
//      (one-time, done outside the app).
//   2. Settings → Thermal printer in our app lists *already-paired*
//      devices via `PrintBluetoothThermal.pairedBluetooths`.
//   3. The user taps to connect, and the chosen MAC address is persisted.
//   4. From then on, every "Print" button in the app calls
//      `printBill(...)` / `printKot(...)` — we generate ESC/POS bytes
//      with esc_pos_utils_plus and send them via the BT plugin.
//
// Why "paired" rather than "scan"?
//   - Classic Bluetooth pairing is an OS-mediated flow with a PIN
//     prompt; doing it inside the app would mean shipping our own
//     pairing UX and re-asking on every reinstall. Reading the OS
//     paired list is a much better UX for thermal printers, which the
//     restaurant pairs once and never touches again.
//   - On iOS, scanning classic-BT devices is not permitted to apps at
//     all, only MFi-certified ones via the External Accessory framework.
//
// Persistence: selected printer is stored under SharedPreferences key
// `ff_printer_address`. On launch we restore it and lazily reconnect.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Re-export PaperSize so screens can write `PaperSize.mm80` without
// having to add `esc_pos_utils_plus` to their own imports.
export 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart' show PaperSize;

import '../models/business.dart';
import '../models/order.dart';
import '../utils/formatters.dart';

/// Legacy alias kept for callers that referenced `PrinterPaperSize`.
typedef PrinterPaperSize = PaperSize;

/// Local descriptor wrapping the plugin's BluetoothInfo so screens don't
/// have to depend on the package directly.
class PrinterDevice {
  final String name;
  final String address;
  const PrinterDevice({required this.name, required this.address});

  factory PrinterDevice.fromBluetoothInfo(BluetoothInfo i) =>
      PrinterDevice(name: i.name, address: i.macAdress);
}

class PrinterService {
  PrinterService._();
  static final PrinterService instance = PrinterService._();

  /// Can THIS device drive a cheap classic-Bluetooth thermal printer directly?
  ///
  /// Only Android can. iOS refuses classic-Bluetooth (SPP) to normal apps —
  /// an app may only talk to MFi-certified accessories through the External
  /// Accessory framework, and effectively no 58mm/80mm thermal printer sold in
  /// India is certified. `print_bluetooth_thermal` therefore returns an empty
  /// paired list on iPhone no matter what the owner does, so every surface
  /// that would show a pair/scan flow must ask this first and offer the PDF /
  /// AirPrint route instead (see `receipt_pdf.dart`).
  ///
  /// Read from `defaultTargetPlatform` rather than `dart:io`'s `Platform` so
  /// this stays compilable on a web/desktop analyze target, and never from a
  /// user setting — the owner cannot opt out of Apple's rule.
  static bool get supportsBluetoothPrinting =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static const _kAddressKey = 'ff_printer_address';
  static const _kNameKey    = 'ff_printer_name';
  static const _kPaperKey   = 'ff_printer_paper';

  PrinterDevice? _selected;
  PaperSize _paperSize = PaperSize.mm80;

  PrinterDevice? get selected => _selected;
  bool get hasSelectedPrinter => _selected != null;
  PaperSize get paperSize => _paperSize;
  /// Legacy sync setter — kept for callers that already wrote
  /// `PrinterService.instance.paperSize = …`. Persists in background.
  set paperSize(PaperSize size) {
    _paperSize = size;
    // fire-and-forget — caller doesn't want to await
    unawaited(setPaperSize(size));
  }

  /// Restore the user's saved printer + paper size on app launch. Safe to
  /// call repeatedly — second call is a no-op.
  Future<void> restore() async {
    if (_selected != null) return;
    final prefs = await SharedPreferences.getInstance();
    final addr  = prefs.getString(_kAddressKey);
    final name  = prefs.getString(_kNameKey);
    final paper = prefs.getString(_kPaperKey);
    if (addr != null && name != null) {
      _selected = PrinterDevice(name: name, address: addr);
    }
    if (paper == 'mm58') _paperSize = PaperSize.mm58;
  }

  Future<void> setPaperSize(PaperSize size) async {
    _paperSize = size;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kPaperKey, size == PaperSize.mm58 ? 'mm58' : 'mm80');
  }

  /// Has the user enabled Bluetooth on their device?
  Future<bool> isBluetoothOn() async {
    // On a platform that can't use classic BT at all, the Bluetooth toggle is
    // not the owner's problem — never nag them to turn something on that
    // would change nothing.
    if (!supportsBluetoothPrinting) return true;
    try {
      return await PrintBluetoothThermal.bluetoothEnabled;
    } catch (_) {
      return true;
    }
  }

  /// Devices the user has already paired in OS Bluetooth Settings.
  ///
  /// Returns empty WITHOUT asking the plugin on a platform that cannot use
  /// classic BT: an empty list that came back from a real query looks to the
  /// caller exactly like "you have no printers, go pair one", which is the
  /// dead end this guard exists to stop. Callers must branch on
  /// [supportsBluetoothPrinting], not on this being empty.
  Future<List<PrinterDevice>> pairedDevices() async {
    if (!supportsBluetoothPrinting) return const <PrinterDevice>[];
    try {
      final list = await PrintBluetoothThermal.pairedBluetooths;
      return list.map(PrinterDevice.fromBluetoothInfo).toList();
    } catch (_) {
      return const <PrinterDevice>[];
    }
  }

  /// Connect to a printer. Persists the choice so we restore it on next
  /// launch. Returns true on success.
  Future<bool> connect(PrinterDevice device) async {
    if (!supportsBluetoothPrinting) return false;
    final ok = await PrintBluetoothThermal.connect(macPrinterAddress: device.address);
    if (!ok) return false;
    _selected = device;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kAddressKey, device.address);
    await prefs.setString(_kNameKey,    device.name);
    return true;
  }

  Future<void> disconnect() async {
    try { await PrintBluetoothThermal.disconnect; } catch (_) {}
    _selected = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kAddressKey);
    await prefs.remove(_kNameKey);
  }

  /// True if we have an active BT socket to the selected printer.
  Future<bool> get isConnected async {
    try {
      return await PrintBluetoothThermal.connectionStatus;
    } catch (_) {
      return false;
    }
  }

  // ── Receipt rendering ──────────────────────────────────────────────

  Future<Uint8List> _buildReceipt({
    required Business business,
    required Order order,
    String? title,
    bool duplicate = false,
  }) async {
    final profile   = await CapabilityProfile.load();
    final generator = Generator(_paperSize, profile);
    final bytes     = <int>[];

    // Header
    bytes.addAll(generator.text(
      business.name,
      styles: const PosStyles(
        align: PosAlign.center, bold: true,
        height: PosTextSize.size2, width: PosTextSize.size2,
      ),
    ));
    if (business.address != null && business.address!.isNotEmpty) {
      bytes.addAll(generator.text(business.address!,
          styles: const PosStyles(align: PosAlign.center)));
    }
    if (business.gstin != null && business.gstin!.isNotEmpty) {
      bytes.addAll(generator.text('GSTIN: ${business.gstin}',
          styles: const PosStyles(align: PosAlign.center)));
    }
    bytes.addAll(generator.hr());

    // 2026-09-05 (backend migration 092) — a composition dealer charges the
    // diner no GST and must issue a BILL OF SUPPLY, not a tax invoice. The
    // numbers are already right by then (orderService refuses to put GST on
    // their orders at all, so `tax` is 0 and the Tax line below never prints),
    // but a document titled "Receipt" carrying no tax and no declaration is
    // not the document they are required to hand over. An explicit `title`
    // from the caller still wins — this only replaces the default.
    final composition = business.gstScheme == 'composition';
    bytes.addAll(generator.text(
      title ?? (composition ? 'BILL OF SUPPLY' : 'Receipt'),
      styles: const PosStyles(align: PosAlign.center, bold: true),
    ));
    if (duplicate) {
      bytes.addAll(generator.text('** DUPLICATE **',
          styles: const PosStyles(align: PosAlign.center)));
    }
    bytes.addAll(generator.text('Order #${order.orderNo}'));
    final ts = order.createdAt.toLocal();
    bytes.addAll(generator.text(
      '${ts.year}-${ts.month.toString().padLeft(2,'0')}-${ts.day.toString().padLeft(2,'0')} '
      '${ts.hour.toString().padLeft(2,'0')}:${ts.minute.toString().padLeft(2,'0')}',
    ));
    bytes.addAll(generator.hr());

    for (final item in order.items) {
      bytes.addAll(generator.row([
        PosColumn(text: '${item.qty}× ${item.name}', width: 8),
        PosColumn(
          text: AppFmt.moneyPlain(item.lineTotal),
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
      // 2026-09-06 (round 2, MOB #1): the picked size + add-ons, on their own
      // indented lines exactly like the server's thermal renderer
      // (printerService.js `· variant` / `+ modifier`) — so the kitchen sees
      // "Large" and the customer sees what the extra rupees were for. Rows
      // from before this change embed the summary in `name` and have none.
      if (item.variantLabel != null && item.variantLabel!.trim().isNotEmpty) {
        bytes.addAll(generator.text('   · ${item.variantLabel!.trim()}'));
      }
      for (final mod in item.modifierNames) {
        bytes.addAll(generator.text('   + $mod'));
      }
    }
    bytes.addAll(generator.hr());

    final subtotal = order.subtotal;
    // `tax` is 0 for a composition dealer because the SERVER refuses to put
    // GST on their orders (orderService, migration 092) — this printer does
    // not have to zero anything, and deliberately does not try: a bill that
    // disagrees with the order row stored against it is worse than either.
    final tax      = order.tax;
    final total    = order.total;
    bytes.addAll(generator.row([
      PosColumn(text: 'Subtotal', width: 8),
      PosColumn(
        text: AppFmt.moneyPlain(subtotal),
        width: 4,
        styles: const PosStyles(align: PosAlign.right),
      ),
    ]));
    // 2026-09-05 (review #2): print the CGST/SGST (or IGST) split when the
    // server row carries it; a plain "Tax" line otherwise. An order that has
    // not reached the server yet (offline queue) only has the app's estimate,
    // so it is labelled as such — the server may settle on a different figure
    // when the outbox drains.
    final est = order.synced ? '' : ' (est.)';
    void taxLine(String label, double amt) {
      bytes.addAll(generator.row([
        PosColumn(text: '$label$est', width: 8),
        PosColumn(
          text: AppFmt.moneyPlain(amt),
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
    }
    if (order.cgst > 0 || order.sgst > 0) {
      taxLine('CGST', order.cgst);
      taxLine('SGST', order.sgst);
    } else if (order.igst > 0) {
      taxLine('IGST', order.igst);
    } else if (tax > 0) {
      taxLine('Tax', tax);
    }
    if (order.discount > 0) {
      bytes.addAll(generator.row([
        PosColumn(text: 'Discount', width: 8),
        PosColumn(
          text: '-${AppFmt.moneyPlain(order.discount)}',
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
    }
    bytes.addAll(generator.row([
      PosColumn(text: 'TOTAL', width: 8, styles: const PosStyles(bold: true)),
      PosColumn(
        text: AppFmt.moneyPlain(total),
        width: 4,
        styles: const PosStyles(align: PosAlign.right, bold: true),
      ),
    ]));
    // The statutory declaration that has to appear on a composition dealer's
    // bill of supply. Printed verbatim; nothing here is a paraphrase.
    if (composition) {
      bytes.addAll(generator.text(
        'Composition taxable person, not eligible to collect tax on supplies',
        styles: const PosStyles(align: PosAlign.center),
      ));
    }
    bytes.addAll(generator.hr());

    bytes.addAll(generator.text(
      'Thank you, visit again!',
      styles: const PosStyles(align: PosAlign.center),
    ));
    bytes.addAll(generator.feed(2));
    bytes.addAll(generator.cut());

    return Uint8List.fromList(bytes);
  }

  Future<bool> printBill({required Order order, required Business business}) async {
    if (!await _ensureConnected()) return false;
    final bytes = await _buildReceipt(
      business: business, order: order, title: 'TAX INVOICE',
    );
    return PrintBluetoothThermal.writeBytes(bytes.toList());
  }

  Future<bool> printKot({required Order order, required Business business}) async {
    if (!await _ensureConnected()) return false;
    final bytes = await _buildReceipt(
      business: business, order: order, title: 'KITCHEN ORDER',
    );
    return PrintBluetoothThermal.writeBytes(bytes.toList());
  }

  /// Print ONE consolidated bill for an entire table session. This is
  /// what the customer gets at settlement — not the per-KOT receipts.
  ///
  /// Pass the session map returned by GET /v1/businesses/:bid/ops/sessions/:id
  /// (we read fields off it directly to avoid a new dedicated model).
  Future<bool> printSessionBill({
    required Map<String, dynamic> session,
    required Business business,
  }) async {
    if (!await _ensureConnected()) return false;
    final profile   = await CapabilityProfile.load();
    final generator = Generator(_paperSize, profile);
    final bytes     = <int>[];

    // Header
    bytes.addAll(generator.text(
      business.name,
      styles: const PosStyles(
        align: PosAlign.center, bold: true,
        height: PosTextSize.size2, width: PosTextSize.size2,
      ),
    ));
    if (business.address != null && business.address!.isNotEmpty) {
      bytes.addAll(generator.text(business.address!,
          styles: const PosStyles(align: PosAlign.center)));
    }
    if (business.gstin != null && business.gstin!.isNotEmpty) {
      bytes.addAll(generator.text('GSTIN: ${business.gstin}',
          styles: const PosStyles(align: PosAlign.center)));
    }
    bytes.addAll(generator.hr());

    // Bill ID — last 8 chars of the session id is short + collision-safe
    // enough for a single table-night. KOT numbers stay internal to the
    // kitchen; the customer only sees this one.
    final sessId = (session['id'] ?? '').toString();
    final billNo = sessId.length >= 8
        ? sessId.substring(sessId.length - 8).toUpperCase()
        : sessId.toUpperCase();
    // 2026-09-05 (backend migration 092) — this heading was an unconditional
    // 'TAX INVOICE', which is exactly the wrong document for a composition
    // dealer: they charge the diner no GST and are required to issue a BILL
    // OF SUPPLY. The totals are already right (orderService puts no GST on
    // their orders), so this is the last thing on the printed bill that
    // still said otherwise.
    final composition = business.gstScheme == 'composition';
    bytes.addAll(generator.text(
      composition ? 'BILL OF SUPPLY' : 'TAX INVOICE',
      styles: const PosStyles(align: PosAlign.center, bold: true),
    ));
    bytes.addAll(generator.text(
      'Bill #$billNo',
      styles: const PosStyles(align: PosAlign.center),
    ));
    final tableLabel = session['tableLabel']?.toString();
    if (tableLabel != null && tableLabel.isNotEmpty) {
      bytes.addAll(generator.text('Table $tableLabel',
          styles: const PosStyles(align: PosAlign.center)));
    }
    final guests = session['guestCount'];
    if (guests != null) {
      bytes.addAll(generator.text('Guests: $guests',
          styles: const PosStyles(align: PosAlign.center)));
    }
    final closedAt = session['closedAt'] ?? session['openedAt'];
    if (closedAt != null) {
      final dt = DateTime.tryParse(closedAt.toString())?.toLocal();
      if (dt != null) {
        bytes.addAll(generator.text(
          '${dt.year}-${dt.month.toString().padLeft(2,'0')}-${dt.day.toString().padLeft(2,'0')} '
          '${dt.hour.toString().padLeft(2,'0')}:${dt.minute.toString().padLeft(2,'0')}',
          styles: const PosStyles(align: PosAlign.center),
        ));
      }
    }
    final cust = (session['customerName'] ?? '').toString();
    final phone = (session['customerPhone'] ?? '').toString();
    if (cust.isNotEmpty || phone.isNotEmpty) {
      bytes.addAll(generator.text(
        [cust, phone].where((s) => s.isNotEmpty).join(' · '),
        styles: const PosStyles(align: PosAlign.center),
      ));
    }
    bytes.addAll(generator.hr());

    // Items — flattened across every KOT. Group identical (name, price)
    // lines so "2× Chai from KOT 1 + 1× Chai from KOT 2" prints as
    // "3× Chai", which is what customers expect to see on a final bill.
    final rawItems = (session['items'] as List?) ?? const [];
    final grouped = <String, Map<String, dynamic>>{};
    for (final it in rawItems) {
      if (it is! Map) continue;
      final name = (it['name'] ?? '').toString();
      final price = (it['price'] as num?)?.toDouble() ?? 0;
      final qty = (it['qty'] as num?)?.toDouble() ?? 0;
      final key = '$name|$price';
      final existing = grouped[key];
      if (existing == null) {
        grouped[key] = {
          'name': name, 'price': price, 'qty': qty,
          'lineTotal': price * qty,
        };
      } else {
        existing['qty'] = (existing['qty'] as double) + qty;
        existing['lineTotal'] = (existing['lineTotal'] as double) + price * qty;
      }
    }
    for (final g in grouped.values) {
      final qty = g['qty'] as double;
      final qtyText = qty == qty.toInt() ? qty.toInt().toString() : qty.toString();
      bytes.addAll(generator.row([
        PosColumn(text: '$qtyText× ${g['name']}', width: 8),
        PosColumn(
          text: AppFmt.moneyPlain(g['lineTotal'] as double),
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
    }
    bytes.addAll(generator.hr());

    // Totals from the backend (already summed across non-cancelled orders)
    double subtotal = (session['subtotalInr'] as num?)?.toDouble() ?? 0;
    double tax      = (session['taxInr']      as num?)?.toDouble() ?? 0;
    double discount = (session['discountInr'] as num?)?.toDouble() ?? 0;
    double total    = (session['totalInr']    as num?)?.toDouble() ?? 0;
    bytes.addAll(generator.row([
      PosColumn(text: 'Subtotal', width: 8),
      PosColumn(
        text: AppFmt.moneyPlain(subtotal),
        width: 4,
        styles: const PosStyles(align: PosAlign.right),
      ),
    ]));
    if (discount > 0) {
      bytes.addAll(generator.row([
        PosColumn(text: 'Discount', width: 8),
        PosColumn(
          text: '-${AppFmt.moneyPlain(discount)}',
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
    }
    if (tax > 0) {
      bytes.addAll(generator.row([
        PosColumn(text: 'Tax', width: 8),
        PosColumn(
          text: AppFmt.moneyPlain(tax),
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]));
    }
    bytes.addAll(generator.row([
      PosColumn(text: 'TOTAL', width: 8, styles: const PosStyles(bold: true)),
      PosColumn(
        text: AppFmt.moneyPlain(total),
        width: 4,
        styles: const PosStyles(align: PosAlign.right, bold: true),
      ),
    ]));
    // The statutory declaration that has to appear on a composition dealer's
    // bill of supply. Printed verbatim; nothing here is a paraphrase.
    if (composition) {
      bytes.addAll(generator.text(
        'Composition taxable person, not eligible to collect tax on supplies',
        styles: const PosStyles(align: PosAlign.center),
      ));
    }
    bytes.addAll(generator.hr());

    bytes.addAll(generator.text(
      'Thank you, visit again!',
      styles: const PosStyles(align: PosAlign.center),
    ));
    bytes.addAll(generator.feed(2));
    bytes.addAll(generator.cut());

    return PrintBluetoothThermal.writeBytes(bytes);
  }

  /// Tiny test page — banner + timestamp + paper size.
  Future<bool> printTest(Business? business) async {
    if (!await _ensureConnected()) return false;
    final profile   = await CapabilityProfile.load();
    final generator = Generator(_paperSize, profile);
    final bytes     = <int>[];
    bytes.addAll(generator.text(
      business?.name ?? 'NamastePOS',
      styles: const PosStyles(
        align: PosAlign.center, bold: true,
        height: PosTextSize.size2, width: PosTextSize.size2,
      ),
    ));
    bytes.addAll(generator.text('Printer test',
        styles: const PosStyles(align: PosAlign.center)));
    bytes.addAll(generator.hr());
    final ts = DateTime.now();
    bytes.addAll(generator.text(
      '${ts.year}-${ts.month.toString().padLeft(2,'0')}-${ts.day.toString().padLeft(2,'0')} '
      '${ts.hour.toString().padLeft(2,'0')}:${ts.minute.toString().padLeft(2,'0')}',
      styles: const PosStyles(align: PosAlign.center),
    ));
    bytes.addAll(generator.text(
      'Paper: ${_paperSize == PaperSize.mm58 ? '58mm' : '80mm'}',
      styles: const PosStyles(align: PosAlign.center),
    ));
    bytes.addAll(generator.feed(2));
    bytes.addAll(generator.cut());
    return PrintBluetoothThermal.writeBytes(bytes);
  }

  /// Legacy alias kept for backward compatibility with screens that
  /// already imported `printToken(order, business)`.
  Future<bool> printToken(Order order, Business business) =>
      printBill(order: order, business: business);

  Future<bool> _ensureConnected() async {
    if (!supportsBluetoothPrinting) return false;
    // Lazy-restore the saved printer the first time a print is attempted.
    // Means callers don't have to remember to call restore() in main.dart.
    if (_selected == null) await restore();
    if (_selected == null) return false;
    if (await isConnected) return true;
    return PrintBluetoothThermal.connect(macPrinterAddress: _selected!.address);
  }

  /// Hint surfaced on the setup screen.
  ///
  /// The old iOS text said "MFi-certified", which tells an owner nothing and
  /// still ended with "pair it and come back" — a loop that can never finish.
  String get platformNote {
    if (!supportsBluetoothPrinting) {
      return 'iPhone does not allow these cheap Bluetooth printers - Apple '
             'only permits certified ones, and the thermal printers sold in '
             'India are not certified.';
    }
    return "Pair your printer in your phone's Bluetooth Settings first, "
           'then return here and tap Refresh.';
  }
}
