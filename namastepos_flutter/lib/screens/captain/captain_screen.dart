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
import 'package:flutter/services.dart'
    show FilteringTextInputFormatter, LengthLimitingTextInputFormatter;
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
            // Guest count 1-50 (2026-08-25): backend openSessionBody now
            // validates the range, so we clamp client-side and add +/-
            // steppers — faster than typing on the floor tablet.
            TextField(
              controller: guestCtrl,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                labelText: 'Guest count * (1–50)',
                prefixIcon: IconButton(
                  icon: const Icon(Icons.remove),
                  onPressed: () {
                    final n = int.tryParse(guestCtrl.text) ?? 1;
                    guestCtrl.text = '${(n - 1).clamp(1, 50)}';
                  },
                ),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.add),
                  onPressed: () {
                    final n = int.tryParse(guestCtrl.text) ?? 1;
                    guestCtrl.text = '${(n + 1).clamp(1, 50)}';
                  },
                ),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: phoneCtrl,
              keyboardType: TextInputType.number,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(10),
              ],
              decoration: const InputDecoration(
                labelText: 'Customer phone (optional)',
                hintText: '9876543210',
                counterText: '',
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
    // Clamp to the backend's accepted 1-50 range (2026-08-25) — a typo'd
    // "0" or "500" would otherwise 400 the whole seat action.
    final guests =
        (int.tryParse(guestCtrl.text) ?? (t['seats'] as num?)?.toInt() ?? 2)
            .clamp(1, 50);
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

  /// Joined-table tap resolution (2026-08-25, F2): every SECONDARY table of
  /// a joined group carries the group's shared currentSessionId, so tapping
  /// ANY member must open the ONE shared bill. We swap the tapped row for
  /// the PRIMARY (the member that is not isJoinedSecondary) so the sheet
  /// header and the "Add items" tableId always bind to the head table —
  /// same net effect as the dashboard resolving the group by session id.
  Map<String, dynamic> _resolveSessionTable(Map<String, dynamic> t) {
    if (t['isJoinedSecondary'] != true) return t;
    final sid = t['currentSessionId'];
    if (sid == null) return t;
    return _tables.firstWhere(
      (x) => x['currentSessionId'] == sid && x['isJoinedSecondary'] != true,
      orElse: () => t,
    );
  }

  /// Join a free table onto this running session (2026-08-25, F2) — one
  /// bill for the whole group, mirroring dashboard TablesPage. Picker only
  /// offers 'available' tables; joins are per-table calls so one stolen
  /// table can't roll back the group. Sheet reopens refreshed afterwards.
  Future<void> _joinAnotherTable(
      Map<String, dynamic> t, String sessionId) async {
    final free = _tables.where((x) => x['status'] == 'available').toList();
    if (free.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No free tables right now.')),
      );
      return;
    }
    // Wrap-of-chips picker (NOT a ListView — dialogs + ListView misbehave
    // on small screens; chips also match the dashboard join picker UX).
    final picked = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Join a table with ${t['label']}'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'The selected table shares ONE bill with this session. '
                'Tapping it later opens this same bill.',
                style: TextStyle(fontSize: 12, color: Colors.grey),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final ft in free)
                    ActionChip(
                      label: Text('${ft['label']}'),
                      onPressed: () => Navigator.pop(ctx, ft),
                    ),
                ],
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel')),
        ],
      ),
    );
    if (picked == null || !mounted) return;
    try {
      await ApiService.instance
          .joinTable(widget.businessId, sessionId, picked['id'] as String);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
            'Table ${picked['label']} joined — one bill for the whole group'),
        backgroundColor: Colors.green,
      ));
      await _load(); // joined table flips to occupied on the floor
      if (mounted) _showSession(t); // reopen the refreshed bill sheet
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(humanizeError(e)), backgroundColor: Colors.red));
    }
  }

  /// Detach ONE joined table and free it — the rest of the group stays on
  /// the shared bill (2026-08-25, F2). Settle/Release frees all at once.
  Future<void> _unjoinTable(Map<String, dynamic> t, String sessionId,
      String tableId, String label) async {
    try {
      await ApiService.instance
          .unjoinTable(widget.businessId, sessionId, tableId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Table $label unjoined and freed')),
      );
      await _load();
      if (mounted) _showSession(t);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(humanizeError(e)), backgroundColor: Colors.red));
    }
  }

  /// Paid-early release (2026-08-25, F2): every live KOT was already paid
  /// at order time ("Pay & place") yet the table stays occupied because
  /// nobody hits Settle — there is nothing left to collect. Close via the
  /// SAME settle endpoint carrying the HEAD order's payment method so
  /// reporting stays truthful; NO new paymentBreakdown, so nothing is
  /// re-charged (close only flips orders still marked 'unpaid' — none here).
  Future<void> _releasePaidSession(
      Map<String, dynamic> t, List<Map> activeOrders,
      {int joinedCount = 0}) async {
    final sessionId = t['currentSessionId'] as String?;
    if (sessionId == null) return;
    final headPm = (activeOrders.isNotEmpty
            ? activeOrders.first['paymentMethod']?.toString()
            : null) ??
        'cash';
    // The close contract accepts only the 4 real tender kinds as headline.
    final pm = const ['cash', 'upi', 'card', 'online'].contains(headPm)
        ? headPm
        : 'cash';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Release table ${t['label']}?'),
        content: Text(
          'All orders in this session are already paid, so nothing more '
          'will be charged — the session closes and '
          '${joinedCount > 0 ? 'the tables (including joined ones) go' : 'the table goes'} '
          'back to Available.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Keep')),
          ElevatedButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Release')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await ApiService.instance.closeSessionV2(
        widget.businessId,
        sessionId,
        paymentMethod: pm,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Table released — bill was already paid'),
        backgroundColor: Colors.green,
      ));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(humanizeError(e)), backgroundColor: Colors.red));
    }
  }

  Future<void> _showSession(Map<String, dynamic> t) async {
    // Joined-table tap resolution (2026-08-25, F2): tapping ANY member of a
    // joined group must open the group's ONE shared session — resolve the
    // tapped row to the primary before doing anything else. Covers both the
    // tap path (_openTable) and the long-press path.
    t = _resolveSessionTable(t);
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
    // Round-2 F2 (2026-08-25): precompute joined-group + paid state once —
    // any join/unjoin/release closes and reopens the sheet, so no
    // StatefulBuilder is needed inside it.
    final sessionId = t['currentSessionId'] as String;
    final joinedTables =
        ((session['joinedTables'] as List?) ?? const []).cast<Map>();
    final orders = ((session['orders'] as List?) ?? const []).cast<Map>();
    final activeOrders =
        orders.where((o) => o['status'] != 'cancelled').toList();
    // Paid upfront = at least one live KOT and EVERY one already carrying a
    // real payment method (the "Pay & place" flow) — only then does the
    // "Release table (already paid)" shortcut make sense.
    final allPaidUpfront = activeOrders.isNotEmpty &&
        activeOrders.every((o) {
          final pm = (o['paymentMethod'] as String?) ?? '';
          return pm.isNotEmpty && pm != 'unpaid';
        });
    // Pending-balance fix (2026-08-25, founder): a session can be PART paid
    // (customer paid at "Pay & place", then ordered more) or FULLY paid.
    // Settle must collect only the UNPAID portion, and be disabled when
    // nothing is pending. Sum per-KOT totals split by payment state.
    double paidTotal = 0, pendingTotal = 0;
    for (final o in activeOrders) {
      final pm = (o['paymentMethod'] as String?) ?? '';
      final t = (o['total'] as num?)?.toDouble() ?? 0;
      if (pm.isNotEmpty && pm != 'unpaid') {
        paidTotal += t;
      } else {
        pendingTotal += t;
      }
    }
    final hasPending = pendingTotal > 0.005;
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
            // Joined tables (2026-08-25, F2) — the whole group shares this
            // ONE bill. Unjoin frees just that table; Settle/Release frees
            // all. Any action closes the sheet and reopens it refreshed.
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(
                spacing: 6,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Icon(Icons.link, size: 16, color: Colors.grey),
                  if (joinedTables.isEmpty)
                    const Text('Big group? Join a free table onto this bill.',
                        style: TextStyle(fontSize: 12, color: Colors.grey)),
                  for (final jt in joinedTables)
                    InputChip(
                      label: Text('${jt['label']}'),
                      visualDensity: VisualDensity.compact,
                      deleteIcon: const Icon(Icons.link_off, size: 16),
                      deleteButtonTooltipMessage:
                          'Unjoin table ${jt['label']}',
                      onDeleted: () {
                        Navigator.pop(context); // sheet reopens refreshed
                        _unjoinTable(
                            t, sessionId, '${jt['id']}', '${jt['label']}');
                      },
                    ),
                  ActionChip(
                    avatar: const Icon(Icons.add_link, size: 16),
                    label: const Text('Join another table'),
                    visualDensity: VisualDensity.compact,
                    onPressed: () {
                      Navigator.pop(context); // sheet reopens refreshed
                      _joinAnotherTable(t, sessionId);
                    },
                  ),
                ],
              ),
            ),
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
            // Paid-early (2026-08-25, F2): a PAID/UNPAID chip per KOT so the
            // cashier sees money already taken via "Pay & place" and never
            // re-charges a paid table.
            if (activeOrders.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    for (final o in activeOrders) _KotPaidChip(order: o),
                  ],
                ),
              ),
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Total', style: TextStyle(fontWeight: FontWeight.bold)),
                Text(AppFmt.money((session['totalInr'] as num?)?.toDouble() ?? 0),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
              ],
            ),
            // Paid / Pending breakdown (2026-08-25) — shown only when some
            // money was already collected, so the cashier sees exactly how
            // much is still due.
            if (paidTotal > 0.005) ...[
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Already paid', style: TextStyle(color: Colors.grey)),
                  Text('− ${AppFmt.money(paidTotal)}',
                      style: const TextStyle(color: AppColors.success)),
                ],
              ),
              const SizedBox(height: 2),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Pending', style: TextStyle(fontWeight: FontWeight.w700)),
                  Text(AppFmt.money(pendingTotal),
                      style: TextStyle(
                          fontWeight: FontWeight.w800,
                          color: hasPending ? AppColors.error : AppColors.success)),
                ],
              ),
            ],
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
                    // Disabled when nothing is due (fully paid upfront); label
                    // shows the pending amount so it's obvious what will be
                    // collected. Settle passes PENDING, not the whole total,
                    // so already-paid KOTs are never re-charged.
                    label: Text(hasPending
                        ? 'Settle ${AppFmt.money(pendingTotal)}'
                        : 'Paid'),
                    onPressed: !hasPending
                        ? null
                        : () {
                            Navigator.pop(context); // close bottom sheet first
                            _settleSession(
                              sessionId: t['currentSessionId'] as String,
                              tableLabel: t['label']?.toString() ?? '?',
                              totalInr: pendingTotal,
                              items: (session!['items'] as List?) ?? const [],
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
            // Paid-early release (2026-08-25, F2) — every live KOT already
            // paid at order time, so nothing is left to collect. Closes the
            // session with the head KOT's payment method, no re-collection.
            if (allPaidUpfront) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.verified_outlined, size: 18),
                  label: const Text(
                    'Release table (already paid)',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.success,
                    backgroundColor:
                        AppColors.success.withValues(alpha: 0.06),
                    side: const BorderSide(
                        color: AppColors.success, width: 1.4),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  onPressed: () {
                    Navigator.pop(context); // close bottom sheet first
                    _releasePaidSession(t, activeOrders,
                        joinedCount: joinedTables.length);
                  },
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
    // Round-2 (2026-08-25): the identified customer also unlocks the
    // wallet tender (split legs) and the shortfall option — both need a
    // customer id, so we capture it during the same lookup round-trip.
    String? customerId;
    double walletBalance = 0;
    bool walletAvailable = false;
    if (customerPhone != null && customerPhone.isNotEmpty) {
      try {
        final data = await ApiService.instance
            .lookupCustomer(widget.businessId, customerPhone);
        final mem = data?['membership'];
        final expired =
            (data?['expiredMembership'] as Map?)?.cast<String, dynamic>();
        final custId = ((data?['customer'] as Map?)?['id'])?.toString();
        customerId = custId;
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
      // Wallet balance for the 'wallet' split-leg option. Any error (402 =
      // loyalty addon missing) just hides wallet — same as the dashboard.
      if (customerId != null) {
        try {
          final w = await ApiService.instance
              .walletFor(widget.businessId, customerId);
          if (w != null) {
            walletBalance = (w['balanceInr'] as num?)?.toDouble() ?? 0;
            walletAvailable = true;
          }
        } catch (_) { /* wallet hidden */ }
      }
    }
    if (!mounted) return;

    // Settle sheet redesign (2026-08-22, founder request): show the FULL
    // bill — every ordered item — plus a discount box, then the payment
    // method. Mirrors the order-taking screen so the cashier confirms
    // exactly what the customer is paying for.
    // Round-2 (2026-08-25): + split payment (2-3 legs incl. wallet) and
    // shortfall ("pay later" gap booked as due on the customer wallet) —
    // same rules the dashboard TablesPage settle enforces.
    final discountCtl = TextEditingController(text: '0');
    final shortfallCtl = TextEditingController(text: '0');
    // Split legs live OUTSIDE the StatefulBuilder so rebuilds don't reset
    // what the cashier typed. Default: cash + upi, amounts blank.
    bool splitOn = false;
    final legs = <_SettleLeg>[
      _SettleLeg('cash', TextEditingController()),
      _SettleLeg('upi', TextEditingController()),
    ];
    // Wallet auto-apply on the SINGLE-method path (2026-08-31, founder):
    // when the customer has a balance, one toggle tells the server to use
    // wallet for the residual and collect the rest via the picked method —
    // same "auto-fill, cashier can adjust" behaviour as pay & place. Off by
    // default; hidden unless a customer with a positive balance is present.
    // For finer control the cashier can still use Split payment. An optional
    // cap limits how much wallet is drawn (blank = up to the whole balance).
    bool useWallet = false;
    final walletCapCtl = TextEditingController();
    final settleResult = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (sheetCtx) => StatefulBuilder(
        builder: (sheetCtx, setSheetState) {
          final discount =
              (double.tryParse(discountCtl.text.trim()) ?? 0).clamp(0, totalInr);
          // Shortfall needs an identified customer (server books it as
          // negative wallet balance) — field is hidden otherwise, so the
          // parse below can only be non-zero when customerId != null.
          final shortfall = customerId == null
              ? 0.0
              : (double.tryParse(shortfallCtl.text.trim()) ?? 0)
                  .clamp(0, totalInr - discount)
                  .toDouble();
          // Contract: split legs must sum to (session total − discount −
          // shortfall) ±₹0.01. Membership fee is charged separately by the
          // subscribe flow, so it's shown but NOT part of the leg target.
          final legsTarget = (totalInr - discount - shortfall)
              .clamp(0, double.infinity)
              .toDouble();
          final payable = legsTarget + membershipFee;
          final legSum = legs.fold<double>(
              0, (s, l) => s + (double.tryParse(l.ctl.text.trim()) ?? 0));
          final walletSum = legs
              .where((l) => l.method == 'wallet')
              .fold<double>(
                  0, (s, l) => s + (double.tryParse(l.ctl.text.trim()) ?? 0));
          final walletOver = walletAvailable && walletSum > walletBalance + 0.001;
          final splitBalance = legsTarget - legSum;
          final splitValid = splitBalance.abs() <= 0.01 &&
              !walletOver &&
              legs.length >= 2 &&
              legs.every(
                  (l) => (double.tryParse(l.ctl.text.trim()) ?? 0) > 0);
          return SafeArea(
            child: Padding(
              padding: EdgeInsets.only(
                left: 16, right: 16, top: 16,
                bottom: MediaQuery.of(sheetCtx).viewInsets.bottom + 16,
              ),
              child: SingleChildScrollView(
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
                  // Shortfall (2026-08-25): customer pays less than the
                  // bill; the gap books as DUE on their wallet. Only
                  // possible with an identified customer.
                  if (customerId != null) ...[
                    TextField(
                      controller: shortfallCtl,
                      keyboardType: const TextInputType.numberWithOptions(
                          decimal: true),
                      decoration: const InputDecoration(
                        labelText: 'Short paid — pay later (₹)',
                        helperText:
                            'Amount is added as due on the customer wallet',
                        isDense: true,
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (_) => setSheetState(() {}),
                    ),
                    const SizedBox(height: 8),
                  ],
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
                  if (shortfall > 0)
                    Text(
                      '${AppFmt.money(shortfall)} added as due on customer wallet',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.warning,
                          fontWeight: FontWeight.w700),
                    ),
                  const Divider(),
                  // Split payment toggle (2026-08-25): off = the familiar
                  // single-method tiles below stay exactly as before.
                  SwitchListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Split payment',
                        style: TextStyle(fontWeight: FontWeight.w700)),
                    value: splitOn,
                    onChanged: (v) => setSheetState(() => splitOn = v),
                  ),
                  if (!splitOn) ...[
                    // Wallet auto-apply toggle — only when an identified
                    // customer has a positive balance. On = server draws
                    // wallet first (up to the optional cap), remainder via
                    // the method tapped below.
                    if (walletAvailable && walletBalance > 0) ...[
                      SwitchListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                            'Use wallet balance (${AppFmt.money(walletBalance)})',
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: const Text(
                            'Pays part of the bill from wallet; collect the rest below',
                            style: TextStyle(fontSize: 11)),
                        value: useWallet,
                        onChanged: (v) => setSheetState(() => useWallet = v),
                      ),
                      if (useWallet)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: TextField(
                            controller: walletCapCtl,
                            keyboardType:
                                const TextInputType.numberWithOptions(
                                    decimal: true),
                            decoration: const InputDecoration(
                              labelText: 'Max wallet to use (₹) — optional',
                              helperText:
                                  'Blank = use up to the full balance',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                            onChanged: (_) => setSheetState(() {}),
                          ),
                        ),
                    ],
                    const Text('Payment method',
                        style: TextStyle(
                            fontSize: 12, color: Colors.grey,
                            fontWeight: FontWeight.w700)),
                    if (useWallet)
                      Padding(
                        padding: const EdgeInsets.only(top: 2, bottom: 4),
                        child: Text(
                          'Wallet covers the bill first — pick how the '
                          'remaining amount (if any) is collected.',
                          style: TextStyle(
                              fontSize: 11,
                              color: AppColors.warning,
                              fontWeight: FontWeight.w600),
                        ),
                      ),
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.currency_rupee, color: Colors.green),
                      title: const Text('Cash'),
                      onTap: () => Navigator.pop(sheetCtx, {
                        'pm': 'cash', 'discount': discount,
                        'shortfall': shortfall,
                        'autoWallet': useWallet,
                        if (useWallet) 'walletCapInr': _walletCapOrNull(walletCapCtl),
                      }),
                    ),
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.qr_code_2, color: Colors.blue),
                      title: const Text('UPI'),
                      onTap: () => Navigator.pop(sheetCtx, {
                        'pm': 'upi', 'discount': discount,
                        'shortfall': shortfall,
                        'autoWallet': useWallet,
                        if (useWallet) 'walletCapInr': _walletCapOrNull(walletCapCtl),
                      }),
                    ),
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.credit_card, color: Colors.purple),
                      title: const Text('Card'),
                      onTap: () => Navigator.pop(sheetCtx, {
                        'pm': 'card', 'discount': discount,
                        'shortfall': shortfall,
                        'autoWallet': useWallet,
                        if (useWallet) 'walletCapInr': _walletCapOrNull(walletCapCtl),
                      }),
                    ),
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.account_balance_wallet,
                          color: Colors.orange),
                      title: const Text('Other / Online'),
                      onTap: () => Navigator.pop(sheetCtx, {
                        'pm': 'online', 'discount': discount,
                        'shortfall': shortfall,
                        'autoWallet': useWallet,
                        if (useWallet) 'walletCapInr': _walletCapOrNull(walletCapCtl),
                      }),
                    ),
                  ] else ...[
                    // 2-3 legs, each (method, ₹). Wallet appears only for
                    // an identified customer, with the live balance on the
                    // label — mirrors dashboard TablesPage settle.
                    for (var i = 0; i < legs.length; i++)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          children: [
                            Expanded(
                              flex: 3,
                              child: DropdownButtonFormField<String>(
                                value: legs[i].method,
                                decoration:
                                    const InputDecoration(labelText: 'Method'),
                                items: [
                                  const DropdownMenuItem(
                                      value: 'cash', child: Text('Cash')),
                                  const DropdownMenuItem(
                                      value: 'upi', child: Text('UPI')),
                                  const DropdownMenuItem(
                                      value: 'card', child: Text('Card')),
                                  const DropdownMenuItem(
                                      value: 'online', child: Text('Online')),
                                  if (walletAvailable)
                                    DropdownMenuItem(
                                      value: 'wallet',
                                      child: Text(
                                          'Wallet — ${AppFmt.money(walletBalance)}',
                                          overflow: TextOverflow.ellipsis),
                                    ),
                                ],
                                onChanged: (v) => setSheetState(
                                    () => legs[i].method = v ?? 'cash'),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              flex: 4,
                              child: TextField(
                                controller: legs[i].ctl,
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                        decimal: true),
                                decoration: const InputDecoration(
                                    labelText: 'Amount (₹)'),
                                onChanged: (_) => setSheetState(() {}),
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.remove_circle_outline,
                                  color: AppColors.error),
                              onPressed: legs.length <= 2
                                  ? null
                                  : () => setSheetState(() {
                                        legs[i].ctl.dispose();
                                        legs.removeAt(i);
                                      }),
                            ),
                          ],
                        ),
                      ),
                    // paymentBreakdown contract caps at 3 legs.
                    if (legs.length < 3)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: () => setSheetState(() => legs.add(
                              _SettleLeg('cash', TextEditingController()))),
                          icon: const Icon(Icons.add, size: 18),
                          label: const Text('Add leg'),
                        ),
                      ),
                    Row(
                      children: [
                        const Text('Balance',
                            style: TextStyle(fontWeight: FontWeight.w700)),
                        const Spacer(),
                        Text(
                          AppFmt.money(splitBalance),
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: splitValid
                                ? AppColors.success
                                : AppColors.error,
                          ),
                        ),
                      ],
                    ),
                    if (walletOver)
                      Text(
                        'Wallet has only ${AppFmt.money(walletBalance)} — '
                        'reduce the wallet amount.',
                        style: const TextStyle(
                            color: AppColors.error, fontSize: 12,
                            fontWeight: FontWeight.w600),
                      ),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: !splitValid
                          ? null
                          : () {
                              // paymentMethod can't be 'wallet' (Joi) — use
                              // the largest non-wallet leg as the headline
                              // method; the server records every leg anyway.
                              String pm = 'cash';
                              double best = -1;
                              for (final l in legs) {
                                final amt =
                                    double.tryParse(l.ctl.text.trim()) ?? 0;
                                if (l.method != 'wallet' && amt > best) {
                                  best = amt;
                                  pm = l.method;
                                }
                              }
                              Navigator.pop(sheetCtx, {
                                'pm': pm,
                                'discount': discount,
                                'shortfall': shortfall,
                                'legs': legs
                                    .map((l) => {
                                          'method': l.method,
                                          'amountInr': double.parse(
                                              (double.tryParse(
                                                          l.ctl.text.trim()) ??
                                                      0)
                                                  .toStringAsFixed(2)),
                                        })
                                    .toList(),
                              });
                            },
                      child: const Text('Settle (split)'),
                    ),
                  ],
                ],
              ),
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
    final shortfallInr = (settleResult['shortfall'] as num?)?.toDouble() ?? 0;
    final breakdown = (settleResult['legs'] as List?)
        ?.cast<Map>()
        .map((m) => m.cast<String, dynamic>())
        .toList();
    final autoWallet = settleResult['autoWallet'] == true;
    final walletCapInr = (settleResult['walletCapInr'] as num?)?.toDouble();

    // Shortfall books real debt — confirm before committing (2026-08-25).
    if (shortfallInr > 0) {
      final sure = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Confirm shortfall'),
          content: Text(
              '${AppFmt.money(shortfallInr)} added as due on customer wallet. '
              'Collect it on their next visit.'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Back')),
            ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Confirm')),
          ],
        ),
      );
      if (sure != true || !mounted) return;
    }

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

      // Round-2 (2026-08-25): typed v2 close — carries the split legs and
      // shortfall alongside the legacy paymentMethod + discountInr.
      await ApiService.instance.closeSessionV2(
        widget.businessId,
        sessionId,
        paymentMethod: paymentMethod,
        discountInr: settleDiscount,
        paymentBreakdown: breakdown,
        shortfallInr: shortfallInr,
        autoWallet: autoWallet,
        walletCapInr: walletCapInr,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Table $tableLabel settled · '
            '${AppFmt.money(totalInr - settleDiscount - shortfallInr + membershipFee)} '
            'via ${breakdown != null ? 'split (${breakdown.length} legs)' : paymentMethod}'
            '${settleDiscount > 0 ? ' (${AppFmt.money(settleDiscount)} off)' : ''}'
            '${shortfallInr > 0 ? ' · ${AppFmt.money(shortfallInr)} added as due on customer wallet' : ''}'
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

/// One split-payment leg in the settle sheet (2026-08-25) — mutable method
/// + its amount controller. Mirrors _SplitLeg in confirm_order_screen.
class _SettleLeg {
  String method;
  final TextEditingController ctl;
  _SettleLeg(this.method, this.ctl);
}

/// Parse the optional "max wallet to use" field on the settle sheet. Blank
/// or non-positive → null (server uses up to the whole balance).
double? _walletCapOrNull(TextEditingController ctl) {
  final v = double.tryParse(ctl.text.trim());
  if (v == null || v <= 0) return null;
  return double.parse(v.toStringAsFixed(2));
}

/// PAID/UNPAID pill per KOT in the running-bill sheet (2026-08-25, F2) —
/// the "Pay & place" flow collects money at order time, so the cashier
/// must see which KOTs are already covered before settling.
class _KotPaidChip extends StatelessWidget {
  final Map order;
  const _KotPaidChip({required this.order});

  @override
  Widget build(BuildContext context) {
    final pm = (order['paymentMethod'] as String?) ?? '';
    final paid = pm.isNotEmpty && pm != 'unpaid';
    final color = paid ? AppColors.success : AppColors.warning;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(
        'KOT #${order['orderNo'] ?? '?'} · '
        '${paid ? 'PAID ${pm.toUpperCase()}' : 'UNPAID'}',
        style: TextStyle(
            fontSize: 10, fontWeight: FontWeight.w800, color: color),
      ),
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
    // Joined-group marker (2026-08-25, F2): a table is part of a joined
    // group either as the primary (carries sessionJoinedTableIds) or a
    // secondary (isJoinedSecondary). Tapping ANY of them opens the group's
    // one shared bill, so the badge tells staff "this is one party".
    final joined = table['isJoinedSecondary'] == true ||
        ((table['sessionJoinedTableIds'] as List?)?.isNotEmpty ?? false);

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
          // Stack (2026-08-25, F2): overlays the joined-group link badge in
          // the corner without disturbing the centered content.
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (joined)
                const Positioned(
                  top: 0,
                  right: 0,
                  child:
                      Icon(Icons.link, size: 13, color: Colors.blueGrey),
                ),
              Column(
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
            ],
          ),
        ),
      ),
    );
  }
}
