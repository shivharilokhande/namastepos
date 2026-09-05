// NamastePOS - Printer setup.
//
// ANDROID: the user pairs their thermal printer in OS Bluetooth Settings;
// this screen lists the paired printers, lets the user pick one, tests it,
// and remembers the choice across launches. Unchanged — it is the main path.
//
// iOS (2026-09-05): this screen used to show that exact same UI on an iPhone,
// where it cannot work. Apple does not permit classic Bluetooth to normal
// apps, so `pairedBluetooths` always came back empty and the owner was told
// "no paired printers found — go pair one in Bluetooth settings", forever.
// The honest read of that screen is "this app is broken". So on iOS we do not
// offer the pairing flow at all: we say plainly why, and offer the print route
// that does work on an iPhone (the OS print sheet — AirPrint, Files, WhatsApp)
// with a test button so the owner can prove it before a customer is waiting.

import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/printer_service.dart';
import '../../services/receipt_pdf.dart';

class PrinterSetupScreen extends StatefulWidget {
  const PrinterSetupScreen({super.key});

  @override
  State<PrinterSetupScreen> createState() => _PrinterSetupScreenState();
}

class _PrinterSetupScreenState extends State<PrinterSetupScreen> {
  bool _loading = true;
  bool _bluetoothOn = true;
  List<PrinterDevice> _paired = const [];
  PrinterDevice? _selected;
  PaperSize _paper = PaperSize.mm80;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await PrinterService.instance.restore();
    _selected = PrinterService.instance.selected;
    _paper    = PrinterService.instance.paperSize;
    if (!PrinterService.supportsBluetoothPrinting) {
      // No permission prompt and no scan on a platform that cannot connect —
      // asking for Bluetooth access we will never use is its own small lie.
      if (mounted) setState(() => _loading = false);
      return;
    }
    await _refresh();
  }

  Future<void> _ensurePermissions() async {
    if (!Platform.isAndroid) return;
    await [
      Permission.bluetooth,
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
      Permission.locationWhenInUse,
    ].request();
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() => _loading = true);
    await _ensurePermissions();
    final on = await PrinterService.instance.isBluetoothOn();
    final list = await PrinterService.instance.pairedDevices();
    if (!mounted) return;
    setState(() {
      _bluetoothOn = on;
      _paired = list;
      _loading = false;
    });
  }

  Future<void> _connect(PrinterDevice d) async {
    setState(() => _loading = true);
    final ok = await PrinterService.instance.connect(d);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (ok) _selected = d;
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok ? 'Connected to ${d.name}' : 'Could not connect to ${d.name}'),
      backgroundColor: ok ? null : AppColors.error,
    ));
  }

  Future<void> _disconnect() async {
    await PrinterService.instance.disconnect();
    if (!mounted) return;
    setState(() => _selected = null);
  }

  Future<void> _testPrint() async {
    final biz = context.read<AuthProvider>().business;
    final ok = await PrinterService.instance.printTest(biz);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok
          ? 'Test page sent — check the printer'
          : 'Print failed. Make sure the printer is on and connected.'),
      backgroundColor: ok ? null : AppColors.error,
    ));
  }

  Future<void> _setPaper(PaperSize size) async {
    await PrinterService.instance.setPaperSize(size);
    if (!mounted) return;
    setState(() => _paper = size);
  }

  // ── iOS: the routes that actually work here ─────────────────────────

  Future<Uint8List> _testPdf() =>
      ReceiptPdf.testPage(context.read<AuthProvider>().business);

  Future<void> _systemPrint() async {
    final messenger = ScaffoldMessenger.of(context)..hideCurrentSnackBar();
    try {
      await ReceiptPdf.openPrintSheet(await _testPdf(), name: 'NamastePOS test');
    } catch (e) {
      messenger.showSnackBar(SnackBar(
        content: Text("Couldn't open the print sheet - $e"),
        backgroundColor: AppColors.error,
      ));
    }
  }

  Future<void> _sharePdf() async {
    final messenger = ScaffoldMessenger.of(context)..hideCurrentSnackBar();
    try {
      await ReceiptPdf.share(await _testPdf(),
          filename: 'namastepos_test_receipt.pdf');
    } catch (e) {
      messenger.showSnackBar(SnackBar(
        content: Text("Couldn't share the receipt - $e"),
        backgroundColor: AppColors.error,
      ));
    }
  }

  Widget _iosBody() => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.warning.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.warning.withValues(alpha: 0.5)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: const [
                  Icon(Icons.info_outline_rounded, color: AppColors.warning),
                  SizedBox(width: 8),
                  Expanded(child: Text(
                    'Bluetooth printers do not work on iPhone',
                    style: TextStyle(fontWeight: FontWeight.w800),
                  )),
                ]),
                const SizedBox(height: 8),
                Text(
                  PrinterService.instance.platformNote,
                  style: const TextStyle(fontSize: 13, height: 1.35),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Nothing you change on the phone will make one appear, so '
                  'there is no printer list on this screen.',
                  style: TextStyle(fontSize: 13, height: 1.35),
                ),
              ],
            ),
          ),

          const SizedBox(height: 20),
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 4, 4, 8),
            child: Text('Print from this iPhone',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13,
                                 color: AppColors.textSecondary)),
          ),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.background,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Bills open in the iPhone print sheet. From there you can '
                  'print on any AirPrint printer on your restaurant Wi-Fi, '
                  'save the bill to Files, or send it to the customer on '
                  'WhatsApp.',
                  style: TextStyle(fontSize: 13, height: 1.35),
                ),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      icon: const Icon(Icons.print_rounded, size: 16),
                      label: const Text('Print test'),
                      onPressed: _systemPrint,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.ios_share_rounded, size: 16),
                      label: const Text('Share PDF'),
                      onPressed: _sharePdf,
                    ),
                  ),
                ]),
              ],
            ),
          ),

          const SizedBox(height: 20),
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 4, 4, 8),
            child: Text('Keeping your thermal printer',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13,
                                 color: AppColors.textSecondary)),
          ),
          // Deliberately NOT a button. The print agent is real and running
          // (namastepos_print_agent polls /print-jobs and prints kitchen
          // tickets for orders placed on ANY device, iPhone included), but
          // nothing in the app or the dashboard issues the long-lived token it
          // needs, so there is no self-serve setup to link to. Describing it
          // and pointing at support is the truth; a button here would not be.
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.background,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: const Text(
              'Two options that keep your existing printer:\n\n'
              '1. Use an Android phone or tablet for billing. It can drive '
              'the Bluetooth printer directly.\n\n'
              '2. Ask us to set up the NamastePOS print agent. It is a small '
              'program on a computer in your restaurant with the printer '
              'attached; kitchen tickets for orders you take on this iPhone '
              'then print there automatically. Setup is not self-serve yet - '
              'contact support and we will do it with you.',
              style: TextStyle(fontSize: 13, height: 1.4),
            ),
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    if (!PrinterService.supportsBluetoothPrinting) {
      return Scaffold(
        appBar: AppBar(title: const Text('Printing')),
        body: _iosBody(),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Thermal printer'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            // Currently connected
            if (_selected != null)
              _connectedCard(_selected!)
            else
              _hintCard(),

            const SizedBox(height: 16),

            // Bluetooth-off warning
            if (!_bluetoothOn) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.warning.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.warning),
                ),
                child: const Text(
                  'Bluetooth is off. Turn it on in your phone settings '
                  'so the printer can connect.',
                  style: TextStyle(fontSize: 13),
                ),
              ),
              const SizedBox(height: 12),
            ],

            // Paired devices
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 4, 4, 8),
              child: Text('Paired Bluetooth devices',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13,
                                   color: AppColors.textSecondary)),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_paired.isEmpty)
              _emptyPaired()
            else
              ..._paired.map(_pairedTile),

            const SizedBox(height: 20),

            // Paper size
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 4, 4, 8),
              child: Text('Paper size',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13,
                                   color: AppColors.textSecondary)),
            ),
            SegmentedButton<PaperSize>(
              segments: const [
                ButtonSegment(value: PaperSize.mm58, label: Text('58mm')),
                ButtonSegment(value: PaperSize.mm80, label: Text('80mm')),
              ],
              selected: {_paper},
              onSelectionChanged: (s) => _setPaper(s.first),
            ),

            const SizedBox(height: 20),
            Text(
              PrinterService.instance.platformNote,
              style: const TextStyle(fontSize: 12, color: AppColors.textHint),
            ),
          ],
        ),
      ),
    );
  }

  Widget _connectedCard(PrinterDevice d) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.success.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.success.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            const Icon(Icons.print_rounded, color: AppColors.success),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(d.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text(d.address,
                      style: const TextStyle(fontSize: 11,
                                             color: AppColors.textSecondary)),
                ],
              ),
            ),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                icon: const Icon(Icons.print_rounded, size: 16),
                label: const Text('Print test'),
                onPressed: _testPrint,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton.icon(
                icon: const Icon(Icons.link_off_rounded, size: 16),
                label: const Text('Disconnect'),
                style: OutlinedButton.styleFrom(foregroundColor: AppColors.error),
                onPressed: _disconnect,
              ),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _hintCard() => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.background,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(children: const [
          Icon(Icons.bluetooth_searching_rounded, color: AppColors.primary),
          SizedBox(width: 10),
          Expanded(child: Text(
            'No printer connected. Pair one in your phone\'s Bluetooth '
            'settings, then pick it below.',
            style: TextStyle(fontSize: 13),
          )),
        ]),
      );

  Widget _emptyPaired() => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.background,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(children: const [
          Icon(Icons.bluetooth_disabled_rounded, color: AppColors.textHint, size: 36),
          SizedBox(height: 8),
          Text('No paired printers found.',
              style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 4),
          Text(
            "Open your phone's Bluetooth settings, pair the printer "
            "(its PIN is usually 0000 or 1234), then come back and tap "
            "Refresh.",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
        ]),
      );

  Widget _pairedTile(PrinterDevice d) {
    final isSelected = _selected?.address == d.address;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: Icon(
          isSelected ? Icons.check_circle_rounded : Icons.print_outlined,
          color: isSelected ? AppColors.success : AppColors.textSecondary,
        ),
        title: Text(d.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(d.address,
            style: const TextStyle(fontSize: 11)),
        trailing: isSelected
            ? const Text('Connected',
                style: TextStyle(color: AppColors.success,
                                 fontSize: 12, fontWeight: FontWeight.w700))
            : const Icon(Icons.chevron_right_rounded),
        onTap: isSelected ? null : () => _connect(d),
      ),
    );
  }
}
