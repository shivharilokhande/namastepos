// NamastePOS — Captain (waiter / floor steward) tablet screen.
//
// Designed for a 10" tablet running on the floor. Big floor-plan tiles for
// each table, tap to open a quick-action sheet: see running bill, send a
// new KOT, request the cashier to settle, summon manager for discount.
//
// Backend endpoints:
//   GET /v1/businesses/:id/ops/tables        → live table grid
//   GET /v1/businesses/:id/sessions/:sid     → bill detail
//   POST /v1/businesses/:id/orders           → send next KOT (kotOnly:true)

import 'dart:async';
import 'package:dio/dio.dart' show DioException;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../services/printer_service.dart';
import '../../utils/formatters.dart';
import '../tables/bill_split_screen.dart';
import '../pos/new_order_screen.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/membership_offer_dialog.dart';
import '../../widgets/home_drawer_button.dart';

/// Captain → "Add items" pre-binds the next POS order to this session so
/// the confirm screen sends `tableSessionId` + `tableId` automatically.
/// Set on captain → cleared by NewOrderScreen.dispose() / pop.
Map<String, dynamic>? _pendingSession;
Map<String, dynamic>? get pendingCaptainSession => _pendingSession;
void clearPendingCaptainSession() => _pendingSession = null;

class CaptainScreen extends StatefulWidget {
  final String businessId;
  const CaptainScreen({super.key, required this.businessId});

  @override
  State<CaptainScreen> createState() => _CaptainScreenState();
}

class _CaptainScreenState extends State<CaptainScreen> {
  List<Map<String, dynamic>> _tables = [];
  // FF-231: floor filter. Bug — the earlier build rendered every floor's
  // tables in one absolute-coordinate canvas, producing an overlapping
  // clutter on multi-floor businesses. Now the user picks a floor from
  // the top selector; only that floor's tables are drawn. Default is
  // the first floor returned by the backend so single-floor cafes see
  // no change.
  String? _selectedFloorId;
  bool _loading = true;
  Timer? _poll;

  static const _statusColors = {
    'available': Colors.green,
    'occupied':  Colors.amber,
    'reserved':  Colors.blue,
    'cleaning':  Colors.grey,
    'blocked':   Colors.red,
  };

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${widget.businessId}/ops/tables');
      _tables = (r.data['tables'] as List).cast<Map>()
          .map((t) => t.cast<String, dynamic>()).toList();
      debugPrint('CAPTAIN load: backend returned ${_tables.length} tables for biz ${widget.businessId}');
      // Print a one-line summary of each table to help diagnose layout / sync issues.
      for (final t in _tables) {
        debugPrint('  · table id=${t['id']} label=${t['label']} floor=${t['floorName']} '
            'status=${t['status']} xPos=${t['xPos']} yPos=${t['yPos']}');
      }
    } catch (e) {
      debugPrint('CAPTAIN load failed: $e');
      /* keep last snapshot */
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _openTable(Map<String, dynamic> t) async {
    final status = t['status'];
    if (status == 'available') {
      _seat(t);
    } else if (status == 'occupied' && t['currentSessionId'] != null) {
      // Match dashboard UX: tap an occupied table → show the running bill
      // bottom sheet with Add items / Split / Settle. The earlier "skip
      // straight to POS" shortcut was confusing because it meant the user
      // couldn't see what was already on the bill before adding.
      _showSession(t);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Table ${t['label']} — $status')),
      );
    }
  }

  Future<void> _seat(Map<String, dynamic> t) async {
    // Mirror dashboard SeatingDialog — collect optional phone, name and
    // notes alongside guest count. All fields except guest count are
    // optional; the backend openSessionBody accepts these as null.
    final guestCtrl = TextEditingController(text: '${t['seats']}');
    final phoneCtrl = TextEditingController();
    final nameCtrl  = TextEditingController();
    final notesCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Seat table ${t['label']}'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: guestCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Guest count *'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Customer phone (optional)',
                hintText: '9876543210',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: nameCtrl,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                  labelText: 'Customer name (optional)'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: notesCtrl,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Notes (optional)',
                hintText: 'Birthday party, allergic to peanuts…',
              ),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Seat guests'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final guests = int.tryParse(guestCtrl.text) ?? t['seats'];
    try {
      // Backend route is /tables/:id/sessions (plural noun) — earlier we
      // were hitting /open-session which 404'd.
      await ApiService.instance.dio.post(
        '/businesses/${widget.businessId}/ops/tables/${t['id']}/sessions',
        data: {
          'guestCount': guests,
          if (phoneCtrl.text.trim().isNotEmpty) 'customerPhone': phoneCtrl.text.trim(),
          if (nameCtrl.text.trim().isNotEmpty)  'customerName':  nameCtrl.text.trim(),
          if (notesCtrl.text.trim().isNotEmpty) 'notes':         notesCtrl.text.trim(),
        },
      );
      _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e)), backgroundColor: Colors.red),
      );
    }
  }

  /// Push 22 — release a table whose customer left without ordering.
  /// Backend refuses with 400 if any orders are attached, in which case
  /// the staff member should settle the bill instead.
  Future<void> _abandonSession(Map<String, dynamic> t) async {
    final sessionId = t['currentSessionId'];
    if (sessionId == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Release table ${t['label']}?'),
        content: const Text(
          'The session will close and the table goes back to Available. '
          'No bill will be raised. Use this only when the customer left '
          'without ordering.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.error),
            child: const Text('Release'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ApiService.instance.dio.post(
        '/businesses/${widget.businessId}/ops/sessions/$sessionId/abandon',
      );
      _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Table released')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't release the table — " + humanizeError(e)),
                 backgroundColor: AppColors.error),
      );
    }
  }

  Future<void> _showSession(Map<String, dynamic> t) async {
    // Long-press from the floor plan can hit any table. Bail with a hint
    // if the table doesn't have an active session yet.
    if (t['currentSessionId'] == null || t['status'] != 'occupied') {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(
            'Table ${t['label']} has no active bill — tap to seat guests')),
      );
      return;
    }
    Map<String, dynamic>? session;
    try {
      final r = await ApiService.instance.dio.get(
        '/businesses/${widget.businessId}/ops/sessions/${t['currentSessionId']}',
      );
      session = (r.data['session'] as Map).cast<String, dynamic>();
    } catch (e) {
      // Surface the real error so we can tell whether it's a 402 (feature
      // gate not removed yet — backend not restarted), 404 (table thinks
      // it has a session that no longer exists), or something else.
      debugPrint('Session load failed for ${t['currentSessionId']}: $e');
      String hint = '$e';
      if (e is DioException) {
        hint = 'HTTP ${e.response?.statusCode} · ${e.response?.data}';
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not load running bill — $hint')),
      );
      return;
    }

    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Table ${t['label']} · Running bill',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            Text('${session!['guestCount'] ?? '?'} guests · KOTs: ${(session['orders'] as List?)?.length ?? 0}',
                style: const TextStyle(color: Colors.grey)),
            const SizedBox(height: 12),
            ...((session['items'] as List?) ?? []).take(8).map((it) {
              final m = it as Map;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Text('${m['qty']}× ', style: const TextStyle(fontWeight: FontWeight.bold)),
                    Expanded(child: Text(m['name'] as String? ?? '?')),
                    Text(AppFmt.money((m['lineTotal'] as num?)?.toDouble() ?? 0)),
                  ],
                ),
              );
            }),
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Total', style: TextStyle(fontWeight: FontWeight.bold)),
                Text(AppFmt.money((session['totalInr'] as num?)?.toDouble() ?? 0),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.add, size: 16),
                    label: const FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text('Add items',
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                    onPressed: () {
                      Navigator.pop(context);
                      // Tie POS to this session via a global stash so the
                      // confirm screen can pick it up and pre-bind dineIn
                      // + tableId. Lightweight alternative to passing args
                      // through bottom-nav reparenting.
                      _pendingSession = {
                        'sessionId': t['currentSessionId'],
                        'tableId': t['id'],
                        'tableLabel': t['label'],
                      };
                      Navigator.push(context, MaterialPageRoute(
                        builder: (_) => const NewOrderScreen(),
                      )).then((_) { _pendingSession = null; _load(); });
                    },
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.call_split),
                    label: const Text('Split'),
                    onPressed: () {
                      Navigator.pop(context);
                      Navigator.push(context, MaterialPageRoute(
                        builder: (_) => BillSplitScreen(
                          businessId: widget.businessId,
                          sessionId: t['currentSessionId'] as String,
                          totalInr: ((session!['totalInr'] as num?) ?? 0).toDouble(),
                        ),
                      )).then((_) => _load());
                    },
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.point_of_sale),
                    label: const Text('Settle'),
                    onPressed: () {
                      Navigator.pop(context); // close bottom sheet first
                      _settleSession(
                        sessionId: t['currentSessionId'] as String,
                        tableLabel: t['label']?.toString() ?? '?',
                        totalInr:
                            ((session!['totalInr'] as num?) ?? 0).toDouble(),
                        items: (session['items'] as List?) ?? const [],
                        customerPhone: session['customerPhone']?.toString(),
                        customerName: session['customerName']?.toString(),
                      );
                    },
                  ),
                ),
              ],
            ),
            // Push 22 — Release table option, only when no orders attached.
            // Customer was seated but left without ordering — frees the
            // table without raising a bill.
            //
            // Styled as a proper outlined button (red border + tint) so
            // it reads as an action, not a text link. Earlier it was a
            // plain TextButton which cashiers mistook for a caption.
            if (((session['orders'] as List?) ?? []).isEmpty) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.event_seat_outlined, size: 18),
                  label: const Text(
                    'Release table',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.error,
                    backgroundColor: AppColors.error.withValues(alpha: 0.06),
                    side: const BorderSide(color: AppColors.error, width: 1.4),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  onPressed: () {
                    Navigator.pop(context); // close bottom sheet first
                    _abandonSession(t);
                  },
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Use only when the customer left without ordering.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  color: AppColors.textHint,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// Closes the table session: asks the captain for the payment method,
  /// posts to /sessions/:id/close, refreshes the floor so the table
  /// flips back to 'available'. Once a session is closed the customer
  /// has paid and the table can be seated again.
  Future<void> _settleSession({
    required String sessionId,
    required String tableLabel,
    required double totalInr,
    List<dynamic> items = const [],
    String? customerPhone,
    String? customerName,
  }) async {
    // Membership offer at settle (2026-08-23, founder): KOT-saved bills
    // get the buy/renew popup here — the moment payment happens. A
    // purchase adds the plan fee to the payable amount below.
    double membershipFee = 0;
    if (customerPhone != null && customerPhone.isNotEmpty) {
      try {
        final data = await ApiService.instance
            .lookupCustomer(widget.businessId, customerPhone);
        final mem = data?['membership'];
        final expired =
            (data?['expiredMembership'] as Map?)?.cast<String, dynamic>();
        final custId = ((data?['customer'] as Map?)?['id'])?.toString();
        if (mem == null && custId != null && mounted) {
          final fee = await showMembershipOfferDialog(
            context,
            customerId: custId,
            customerLabel: customerName ?? customerPhone,
            expired: expired,
          );
          if (fee != null) membershipFee = fee;
        }
      } catch (_) { /* offer is best-effort — never block settling */ }
    }
    if (!mounted) return;

    // Settle sheet redesign (2026-08-22, founder request): show the FULL
    // bill — every ordered item — plus a discount box, then the payment
    // method. Mirrors the order-taking screen so the cashier confirms
    // exactly what the customer is paying for.
    final discountCtl = TextEditingController(text: '0');
    final settleResult = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (sheetCtx) => StatefulBuilder(
        builder: (sheetCtx, setSheetState) {
          final discount =
              (double.tryParse(discountCtl.text.trim()) ?? 0).clamp(0, totalInr);
          final payable = totalInr - discount + membershipFee;
          return SafeArea(
            child: Padding(
              padding: EdgeInsets.only(
                left: 16, right: 16, top: 16,
                bottom: MediaQuery.of(sheetCtx).viewInsets.bottom + 16,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Settle table $tableLabel',
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w900)),
                  const SizedBox(height: 12),
                  // Full item list (scrolls if long)
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: MediaQuery.of(sheetCtx).size.height * 0.32,
                    ),
                    child: SingleChildScrollView(
                      child: Column(
                        children: [
                          for (final it in items)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 3),
                              child: Row(
                                children: [
                                  Text('${(it as Map)['qty']}× ',
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800)),
                                  Expanded(
                                      child: Text(it['name'] as String? ?? '?',
                                          overflow: TextOverflow.ellipsis)),
                                  Text(AppFmt.money(
                                      (it['lineTotal'] as num?)?.toDouble() ?? 0)),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  const Divider(),
                  TextField(
                    controller: discountCtl,
                    keyboardType: const TextInputType.numberWithOptions(
                        decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Discount (₹)',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setSheetState(() {}),
                  ),
                  const SizedBox(height: 8),
                  if (membershipFee > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(children: [
                        const Text('Membership (added now)',
                            style: TextStyle(
                                color: AppColors.success,
                                fontWeight: FontWeight.w700)),
                        const Spacer(),
                        Text('+${AppFmt.money(membershipFee)}',
                            style: const TextStyle(
                                color: AppColors.success,
                                fontWeight: FontWeight.w800)),
                      ]),
                    ),
                  Row(
                    children: [
                      const Text('To pay',
                          style: TextStyle(fontWeight: FontWeight.w800)),
                      const Spacer(),
                      Text(AppFmt.money(payable, decimals: true),
                          style: const TextStyle(
                              fontSize: 18, fontWeight: FontWeight.w900)),
                    ],
                  ),
                  const Divider(),
                  const Text('Payment method',
                      style: TextStyle(
                          fontSize: 12, color: Colors.grey,
                          fontWeight: FontWeight.w700)),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.currency_rupee, color: Colors.green),
                    title: const Text('Cash'),
                    onTap: () => Navigator.pop(sheetCtx,
                        {'pm': 'cash', 'discount': discount}),
                  ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.qr_code_2, color: Colors.blue),
                    title: const Text('UPI'),
                    onTap: () => Navigator.pop(sheetCtx,
                        {'pm': 'upi', 'discount': discount}),
                  ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.credit_card, color: Colors.purple),
                    title: const Text('Card'),
                    onTap: () => Navigator.pop(sheetCtx,
                        {'pm': 'card', 'discount': discount}),
                  ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.account_balance_wallet,
                        color: Colors.orange),
                    title: const Text('Other / Online'),
                    onTap: () => Navigator.pop(sheetCtx,
                        {'pm': 'online', 'discount': discount}),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
    if (settleResult == null) return;
    if (!mounted) return;
    final paymentMethod = settleResult['pm'] as String;
    final settleDiscount = (settleResult['discount'] as num?)?.toDouble() ?? 0;

    try {
      // Fetch the full session BEFORE closing so we still have the
      // running totals + flattened item list for the printed bill.
      // (sessionDetail post-close still works but this is one round-trip
      // we'd be paying anyway.)
      Map<String, dynamic>? sessionForPrint;
      try {
        final r = await ApiService.instance.dio.get(
          '/businesses/${widget.businessId}/ops/sessions/$sessionId',
        );
        sessionForPrint = (r.data['session'] as Map).cast<String, dynamic>();
      } catch (_) { /* non-fatal — settle still proceeds, just no auto-print */ }

      await ApiService.instance.dio.post(
        '/businesses/${widget.businessId}/ops/sessions/$sessionId/close',
        data: {
          'paymentMethod': paymentMethod,
          if (settleDiscount > 0) 'discountInr': settleDiscount,
        },
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Table $tableLabel settled · '
            '${AppFmt.money(totalInr - settleDiscount + membershipFee)} via $paymentMethod'
            '${settleDiscount > 0 ? ' (${AppFmt.money(settleDiscount)} off)' : ''}'
            '${membershipFee > 0 ? ' (incl. ${AppFmt.money(membershipFee)} membership)' : ''}'),
        backgroundColor: Colors.green,
      ));

      // Print the consolidated session bill (ONE invoice, all KOTs merged).
      // Silent if no printer is connected — staff can still settle without
      // a printer present.
      final biz = context.read<AuthProvider>().business;
      if (sessionForPrint != null && biz != null && PrinterService.instance.hasSelectedPrinter) {
        final printed = await PrinterService.instance.printSessionBill(
          session: sessionForPrint, business: biz,
        );
        if (!printed && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Bill printed: failed. Use Re-print from Orders if needed.'),
          ));
        }
      }

      await _load(); // refresh — table will flip to 'available'
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(humanizeError(e)),
        backgroundColor: Colors.red,
      ));
    }
  }

  /// FF-231: unique floor list derived from the table payload. Backend
  /// serialises floorId + floorName on each table row, so we don't
  /// need a separate /ops/floors round-trip.
  List<Map<String, String>> get _floors {
    final seen = <String, String>{};  // id → name
    for (final t in _tables) {
      final id = (t['floorId'] as String?) ?? '__none__';
      final name = (t['floorName'] as String?) ?? 'Ground floor';
      seen.putIfAbsent(id, () => name);
    }
    return seen.entries
        .map((e) => {'id': e.key, 'name': e.value})
        .toList();
  }

  /// Tables shown right now — filtered to the picked floor.
  List<Map<String, dynamic>> get _visibleTables {
    if (_selectedFloorId == null) return _tables;
    return _tables.where((t) =>
      ((t['floorId'] as String?) ?? '__none__') == _selectedFloorId
    ).toList();
  }

  @override
  Widget build(BuildContext context) {
    // Prime the floor selector once tables are loaded.
    if (!_loading && _selectedFloorId == null && _floors.isNotEmpty) {
      _selectedFloorId = _floors.first['id'];
    }
    final floors = _floors;
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Floor — Captain view'),
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _tables.isEmpty
              ? const Center(child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'No tables yet. Add some from the customer dashboard '
                    'and drag them to the layout you want.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey),
                  ),
                ))
              : Column(
                  children: [
                    // Floor selector — only rendered when there's more
                    // than one floor. Single-floor cafes get their
                    // layout immediately.
                    if (floors.length > 1)
                      SizedBox(
                        height: 48,
                        child: ListView.separated(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 8),
                          scrollDirection: Axis.horizontal,
                          itemBuilder: (_, i) {
                            final f = floors[i];
                            final selected = f['id'] == _selectedFloorId;
                            return ChoiceChip(
                              label: Text(f['name']!),
                              selected: selected,
                              onSelected: (_) => setState(
                                  () => _selectedFloorId = f['id']),
                              selectedColor: AppColors.primary,
                              labelStyle: TextStyle(
                                color: selected
                                    ? Colors.white
                                    : AppColors.textPrimary,
                                fontWeight: FontWeight.w700,
                              ),
                            );
                          },
                          separatorBuilder: (_, __) => const SizedBox(width: 6),
                          itemCount: floors.length,
                        ),
                      ),
                    Expanded(
                      child: _visibleTables.isEmpty
                          ? const Center(
                              child: Text(
                                'No tables on this floor.',
                                style: TextStyle(color: Colors.grey),
                              ),
                            )
                          : _FloorPlan(
                              tables: _visibleTables,
                              onTap: _openTable,
                              onLongPress: _showSession,
                              statusColors: _statusColors,
                            ),
                    ),
                  ],
                ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

}

// ──────────────────────────────────────────────────────────────────────────
//                          FLOOR PLAN
// ──────────────────────────────────────────────────────────────────────────
//
// Renders tables at their saved (xPos, yPos) grid positions — the same
// layout the customer dashboard's drag-editor produces. If every table has
// xPos = yPos = 0 (i.e. the dashboard layout hasn't been set up yet), we
// fall back to a simple auto-grid so the user still sees their tables.
//
// Each tile responds to:
//   - tap         → onTap callback (seat / add items / show status)
//   - long-press  → onLongPress callback (view running bill, settle, split)

class _FloorPlan extends StatelessWidget {
  final List<Map<String, dynamic>> tables;
  final void Function(Map<String, dynamic>) onTap;
  final Future<void> Function(Map<String, dynamic>) onLongPress;
  final Map<String, Color> statusColors;

  const _FloorPlan({
    required this.tables,
    required this.onTap,
    required this.onLongPress,
    required this.statusColors,
  });

  @override
  Widget build(BuildContext context) {
    // x_pos/y_pos in the DB are ABSOLUTE PIXEL COORDINATES from the
    // dashboard's drag-canvas (typically 0..600 in width). They're NOT
    // grid cell indices. So we treat the table positions as a bounding
    // box and scale to fit the mobile viewport.

    // If the dashboard layout editor hasn't been touched, every table
    // sits at (0, 0) — fall back to an auto grid so user still sees
    // them spread out.
    final xs = tables.map((t) => (t['xPos'] as num? ?? 0).toDouble()).toList();
    final ys = tables.map((t) => (t['yPos'] as num? ?? 0).toDouble()).toList();
    final maxX = xs.fold<double>(0, (m, v) => v > m ? v : m);
    final maxY = ys.fold<double>(0, (m, v) => v > m ? v : m);
    if (maxX == 0 && maxY == 0) {
      return _autoGrid(context);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const pad = 12.0;
        const tileSize = 76.0; // pixel size on mobile

        // Canvas size in dashboard logical units. We pad the bounding box
        // a bit on the right/bottom so tiles aren't flush against the edge.
        final canvasW = maxX + tileSize + 20;
        final canvasH = maxY + tileSize + 20;

        // Scale the whole canvas to fit the available width. If it would
        // still overflow vertically we let the outer ScrollView handle it.
        final availableW = constraints.maxWidth - 2 * pad;
        final scale = availableW < canvasW ? availableW / canvasW : 1.0;
        final scaledH = canvasH * scale;

        return SingleChildScrollView(
          scrollDirection: Axis.vertical,
          padding: const EdgeInsets.all(pad),
          child: SizedBox(
            width: canvasW * scale,
            height: scaledH,
            child: Stack(
              children: tables.map((t) {
                final x = (t['xPos'] as num? ?? 0).toDouble();
                final y = (t['yPos'] as num? ?? 0).toDouble();
                return Positioned(
                  left: x * scale,
                  top: y * scale,
                  width: tileSize * scale,
                  height: tileSize * scale,
                  child: _Tile(
                    table: t,
                    statusColors: statusColors,
                    onTap: () => onTap(t),
                    onLongPress: () => onLongPress(t),
                  ),
                );
              }).toList(),
            ),
          ),
        );
      },
    );
  }

  /// Fallback grid for businesses that haven't set up the dashboard layout
  /// yet. Same visual style as the positioned tiles.
  Widget _autoGrid(BuildContext context) {
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        // 0.85 ratio (taller than wide) gives room for the 3-line content
        // even on narrow phones where the cell ends up ~90px wide.
        maxCrossAxisExtent: 130,
        childAspectRatio: 0.85,
        crossAxisSpacing: 12,
        mainAxisSpacing: 12,
      ),
      itemCount: tables.length,
      itemBuilder: (_, i) => _Tile(
        table: tables[i],
        statusColors: statusColors,
        onTap: () => onTap(tables[i]),
        onLongPress: () => onLongPress(tables[i]),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  final Map<String, dynamic> table;
  final Map<String, Color> statusColors;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  const _Tile({
    required this.table,
    required this.statusColors,
    required this.onTap,
    required this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final color = statusColors[table['status']] ?? Colors.grey;
    final shape = (table['shape'] as String?) ?? 'square';
    final borderRadius = shape == 'round'
        ? BorderRadius.circular(999) // pill / circle
        : BorderRadius.circular(8);

    return Material(
      color: color.withValues(alpha: 0.15),
      borderRadius: borderRadius,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: borderRadius,
        child: Container(
          decoration: BoxDecoration(
            border: Border.all(color: color, width: 2),
            borderRadius: borderRadius,
          ),
          padding: const EdgeInsets.all(6),
          // FittedBox + Flexible rows + maxLines:1 + ellipsis means the
          // tile NEVER overflows no matter how small the cell ends up. The
          // earlier version raw-stacked fixed-size Texts in a Column, so
          // tight cells got the "BOTTOM OVERFLOWED BY 37 PIXELS" stripe.
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    table['label'] as String? ?? '?',
                    style: const TextStyle(
                        fontSize: 22, fontWeight: FontWeight.bold),
                    maxLines: 1,
                  ),
                ),
              ),
              const SizedBox(height: 2),
              Text(
                '${table['seats'] ?? 0} seats',
                style: const TextStyle(fontSize: 10, color: Colors.grey),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 3),
              Text(
                (table['status'] as String? ?? '').toUpperCase(),
                style: TextStyle(
                    fontSize: 9, fontWeight: FontWeight.w700, color: color),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
