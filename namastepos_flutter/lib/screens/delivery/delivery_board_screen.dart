// NamastePOS — Delivery board (2026-09-04)
//
// The phone-shaped twin of the dashboard's delivery board: live delivery
// orders as a single scrolling list of cards, each showing the state in
// restaurant language, the order number, how long it has been waiting, the
// diner, and exactly the buttons the BACKEND says are legal.
//
// `nextStates` from the server is the only source of truth for the action
// buttons — we never hardcode the ladder, because an aggregator order can
// arrive already accepted and the transition graph lives server-side.
//
// Polling: 10s while mounted, cancelled in dispose (this codebase has had
// timer-leak bugs), plus a tenant guard so a poll that lands after a logout
// or restaurant switch can never write another tenant's orders into state
// (same shape as OrdersProvider's `_authBusinessId` check).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';

/// Enum → what the counter calls it.
const Map<String, String> kFulfilmentStateLabel = {
  'placed': 'New',
  'accepted': 'Accepted',
  'preparing': 'Preparing',
  'food_ready': 'Food ready',
  'rider_assigned': 'With delivery partner',
  'picked_up': 'With delivery partner',
  'delivered': 'Delivered',
  'rejected': 'Rejected',
  'cancelled': 'Cancelled',
};

/// Enum → what the BUTTON does.
const Map<String, String> kFulfilmentActionLabel = {
  'placed': 'Move to New',
  'accepted': 'Accept',
  'preparing': 'Start preparing',
  'food_ready': 'Food ready',
  'rider_assigned': 'Assign partner',
  'picked_up': 'Hand over',
  'delivered': 'Mark delivered',
  'rejected': 'Reject',
  'cancelled': 'Cancel',
};

class DeliveryBoardScreen extends StatefulWidget {
  const DeliveryBoardScreen({super.key});

  @override
  State<DeliveryBoardScreen> createState() => _DeliveryBoardScreenState();
}

class _DeliveryBoardScreenState extends State<DeliveryBoardScreen> {
  List<Map<String, dynamic>> _orders = [];
  bool _loading = true;
  bool _busy = false;
  String? _error;
  Timer? _pollTimer;

  /// The tenant this screen belongs to, captured once on open. Every async
  /// result is checked against the CURRENT auth business before it touches
  /// state, so a logout / restaurant switch mid-flight can't repopulate the
  /// list with the previous tenant's orders.
  late final String _screenBizId =
      context.read<AuthProvider>().business?.id ?? '';

  String get _currentBizId =>
      context.read<AuthProvider>().business?.id ?? '';

  @override
  void initState() {
    super.initState();
    _load();
    // `context.read` is safe inside the callback because the timer is
    // cancelled in dispose.
    _pollTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (!mounted) return;
      _load(silent: true);
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (_screenBizId.isEmpty) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    // A tenant switch happened while this screen stayed on the stack — stop
    // polling someone else's board rather than showing mixed data.
    if (_screenBizId != _currentBizId) return;
    if (!silent && mounted) setState(() { _loading = true; _error = null; });
    try {
      final list = await ApiService.instance.fulfilmentBoard(_screenBizId);
      if (!mounted || _screenBizId != _currentBizId) return;
      setState(() { _orders = list; _loading = false; _error = null; });
    } catch (e) {
      if (!mounted || _screenBizId != _currentBizId) return;
      // A failed background poll must not blank a board the staff is using —
      // only a foreground load surfaces the error.
      setState(() {
        _loading = false;
        if (!silent) _error = humanizeError(e);
      });
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? AppColors.error : AppColors.success,
    ));
  }

  /// Single funnel for every transition. Not optimistic: we reload the board
  /// from the server on success rather than guess, because a POS that shows
  /// "Food ready" before the server agrees is worse than half a second of
  /// latency.
  Future<void> _transition(
    Map<String, dynamic> order,
    String state, {
    int? prepMinutes,
    String? reason,
    Map<String, dynamic>? rider,
    String? otp,
  }) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final updated = await ApiService.instance.fulfilmentTransition(
        _screenBizId,
        order['id'] as String,
        state: state,
        prepMinutes: prepMinutes,
        reason: reason,
        rider: rider,
        otp: otp,
      );
      if (!mounted || _screenBizId != _currentBizId) return;
      final label = kFulfilmentStateLabel[updated['state']] ?? '${updated['state']}';
      _toast('#${updated['orderNo']} · $label');
      await _load(silent: true);
    } catch (e) {
      if (!mounted) return;
      // 409 = the move was illegal by the time it landed, i.e. another
      // device (dashboard, KDS, aggregator webhook) already moved this
      // order. Pull the truth back immediately and say so.
      if (e is ApiException && e.statusCode == 409) {
        _toast('Someone else already moved this order — refreshed the board.',
            error: true);
        await _load(silent: true);
      } else {
        // Wrong handover code comes back as a 400 whose message already
        // reads "Incorrect OTP — check with the delivery partner".
        _toast(humanizeError(e), error: true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// A tapped `nextState` either fires straight away or opens the sheet that
  /// collects what the backend requires for that state.
  Future<void> _onAction(Map<String, dynamic> order, String state) async {
    switch (state) {
      case 'accepted':
        final mins = await _askPrepMinutes(order);
        if (mins != null) await _transition(order, 'accepted', prepMinutes: mins);
        return;
      case 'rejected':
        final reason = await _askReason(order, cancel: false);
        if (reason != null && reason.isNotEmpty) {
          await _transition(order, 'rejected', reason: reason);
        }
        return;
      case 'cancelled':
        final reason = await _askReason(order, cancel: true);
        if (reason != null) {
          await _transition(order, 'cancelled',
              reason: reason.isEmpty ? null : reason);
        }
        return;
      case 'rider_assigned':
        final rider = await _askRider(order);
        if (rider != null) await _transition(order, 'rider_assigned', rider: rider);
        return;
      case 'picked_up':
        final otp = await _askHandover(order);
        if (otp == null) return; // dismissed
        await _transition(order, 'picked_up', otp: otp.isEmpty ? null : otp);
        return;
      default:
        await _transition(order, state);
    }
  }

  // ── Sheets ───────────────────────────────────────────────────────────────

  /// The most-used control on the board: the quick chips ARE the control —
  /// one tap picks the prep time and closes the sheet. The field below is
  /// the escape hatch for a 45-minute biryani.
  Future<int?> _askPrepMinutes(Map<String, dynamic> order) {
    final controller = TextEditingController();
    return showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 16, right: 16, top: 16,
          bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Accept #${order['orderNo']} — how long?',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 16),
            Row(
              children: [10, 15, 20, 30].map((m) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: SizedBox(
                    height: 64,
                    child: ElevatedButton(
                      onPressed: () => Navigator.pop(ctx, m),
                      child: Text('$m\nmin', textAlign: TextAlign.center),
                    ),
                  ),
                ),
              )).toList(),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: controller,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(
                labelText: 'Or type minutes (1-240)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton(
                onPressed: () {
                  final n = int.tryParse(controller.text.trim());
                  if (n == null || n < 1 || n > 240) return;
                  Navigator.pop(ctx, n);
                },
                child: const Text('Accept'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Reject REQUIRES a reason (the backend 400s without one). Cancel does
  /// not, but we still offer the field — "why did this order vanish" is the
  /// first question the owner asks next morning.
  Future<String?> _askReason(Map<String, dynamic> order, {required bool cancel}) {
    final controller = TextEditingController();
    final quick = cancel
        ? const ['Diner cancelled', 'No delivery partner', 'Item unavailable', 'Duplicate order']
        : const ['Out of stock', 'Kitchen too busy', 'Outside delivery area', 'Shop closing'];
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.only(
            left: 16, right: 16, top: 16,
            bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${cancel ? 'Cancel' : 'Reject'} #${order['orderNo']}',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8, runSpacing: 8,
                children: quick.map((q) => OutlinedButton(
                  onPressed: () => setSheet(() => controller.text = q),
                  child: Text(q),
                )).toList(),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: controller,
                decoration: InputDecoration(
                  labelText: cancel ? 'Reason (optional)' : 'Reason (required)',
                  border: const OutlineInputBorder(),
                ),
                onChanged: (_) => setSheet(() {}),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
                  onPressed: (!cancel && controller.text.trim().isEmpty)
                      ? null
                      : () => Navigator.pop(ctx, controller.text.trim()),
                  child: Text(cancel ? 'Cancel order' : 'Reject order'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<Map<String, dynamic>?> _askRider(Map<String, dynamic> order) {
    final rider = order['rider'] as Map?;
    final name = TextEditingController(text: (rider?['name'] ?? '') as String);
    final phone = TextEditingController(text: (rider?['phone'] ?? '') as String);
    final otp = TextEditingController();
    return showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 16, right: 16, top: 16,
          bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Delivery partner for #${order['orderNo']}',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            const Text('All optional — leave blank if the partner hasn\'t said.',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
            const SizedBox(height: 12),
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Name', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Phone', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: otp,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              autofillHints: const [AutofillHints.oneTimeCode],
              decoration: const InputDecoration(
                labelText: 'Handover code (if they gave one)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(ctx, <String, dynamic>{
                  if (name.text.trim().isNotEmpty) 'name': name.text.trim(),
                  if (phone.text.trim().isNotEmpty) 'phone': phone.text.trim(),
                  if (otp.text.trim().isNotEmpty) 'otp': otp.text.trim(),
                }),
                child: const Text('Assign partner'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The handover code is READ OUT by the delivery partner and TYPED here —
  /// we never receive the expected value, so there is nothing to display and
  /// no way to "show" it. Returns '' for a plain confirm (no code needed),
  /// the typed digits when one is required, and null when dismissed.
  Future<String?> _askHandover(Map<String, dynamic> order) {
    final needsOtp = (order['otpRequired'] == true) && (order['otpVerified'] != true);
    final otp = TextEditingController();
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.only(
            left: 16, right: 16, top: 16,
            bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Hand over #${order['orderNo']}',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              if (needsOtp) ...[
                const Text('Ask the delivery partner for the code',
                    style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
                const SizedBox(height: 8),
                TextField(
                  controller: otp,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  autofillHints: const [AutofillHints.oneTimeCode],
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 26, letterSpacing: 8, fontWeight: FontWeight.bold),
                  decoration: const InputDecoration(
                    hintText: '••••',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => setSheet(() {}),
                ),
              ] else
                const Text('Confirm the food has gone out with the delivery partner.',
                    style: TextStyle(fontSize: 14)),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton(
                  onPressed: (needsOtp && otp.text.trim().isEmpty)
                      ? null
                      : () => Navigator.pop(ctx, needsOtp ? otp.text.trim() : ''),
                  child: const Text('Hand over', style: TextStyle(fontSize: 16)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Build ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Delivery board'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _busy ? null : () => _load(),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => _load(),
              child: _error != null
                  ? ListView(children: [
                      Padding(
                        padding: const EdgeInsets.all(32),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    ])
                  : _orders.isEmpty
                      ? ListView(children: const [
                          Padding(
                            padding: EdgeInsets.all(48),
                            child: Text('No live delivery orders.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: AppColors.textSecondary)),
                          ),
                        ])
                      : ListView.builder(
                          padding: const EdgeInsets.all(12),
                          itemCount: _orders.length,
                          itemBuilder: (_, i) => _card(_orders[i]),
                        ),
            ),
    );
  }

  Color _stateColor(String s) {
    switch (s) {
      case 'placed': return AppColors.warning;
      case 'accepted':
      case 'preparing': return AppColors.info;
      case 'food_ready': return AppColors.success;
      case 'rejected':
      case 'cancelled': return AppColors.error;
      default: return AppColors.textSecondary;
    }
  }

  int _minutesSince(Object? iso) {
    final t = DateTime.tryParse('${iso ?? ''}');
    if (t == null) return 0;
    final m = DateTime.now().difference(t).inMinutes;
    return m < 0 ? 0 : m;
  }

  Widget _card(Map<String, dynamic> o) {
    final state = '${o['state']}';
    final mins = _minutesSince(o['createdAt']);
    // Anything unaccepted past 5 minutes is the thing that loses a rating.
    final isLate = state == 'placed' && mins >= 5;
    final next = ((o['nextStates'] as List?) ?? const [])
        .map((e) => '$e').toList();
    final primary = next.where((s) => s != 'rejected' && s != 'cancelled').toList();
    final rider = o['rider'] as Map?;
    final needsOtp = (o['otpRequired'] == true) && (o['otpVerified'] != true);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: isLate
            ? const BorderSide(color: AppColors.error, width: 1.5)
            : BorderSide.none,
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('#${o['orderNo']}',
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _stateColor(state).withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(kFulfilmentStateLabel[state] ?? state,
                      style: TextStyle(
                          color: _stateColor(state),
                          fontWeight: FontWeight.w600,
                          fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Icon(Icons.schedule, size: 14,
                    color: isLate ? AppColors.error : AppColors.textHint),
                const SizedBox(width: 4),
                Text(
                  mins == 0 ? 'just now' : '$mins min ago',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: isLate ? FontWeight.bold : FontWeight.normal,
                      color: isLate ? AppColors.error : AppColors.textSecondary),
                ),
                if (o['prepMinutes'] != null)
                  Text(' · ${o['prepMinutes']} min prep',
                      style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                const Spacer(),
                Text(AppFmt.money(num.tryParse('${o['total']}') ?? 0),
                    style: const TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 8),
            Text('${o['customerName'] ?? 'Walk-in'}',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            if ((o['customerPhone'] ?? '').toString().isNotEmpty)
              Text('${o['customerPhone']}',
                  style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
            Text('${o['source'] ?? o['channel'] ?? 'delivery'}',
                style: const TextStyle(fontSize: 11, color: AppColors.textHint)),
            if (rider != null) ...[
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: AppColors.background,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '${rider['name'] ?? 'Partner'}'
                  '${(rider['phone'] ?? '').toString().isNotEmpty ? ' · ${rider['phone']}' : ''}',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            if (needsOtp) ...[
              const SizedBox(height: 6),
              Row(children: const [
                Icon(Icons.info_outline, size: 14, color: AppColors.warning),
                SizedBox(width: 4),
                Text('Handover code needed',
                    style: TextStyle(fontSize: 12, color: AppColors.warning)),
              ]),
            ],
            const SizedBox(height: 10),
            // Big targets — the point is one confident thumb tap.
            for (final s in primary)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: _busy ? null : () => _onAction(o, s),
                    child: Text(kFulfilmentActionLabel[s] ?? s,
                        style: const TextStyle(fontSize: 16)),
                  ),
                ),
              ),
            Row(
              children: [
                if (next.contains('rejected'))
                  Expanded(
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(foregroundColor: AppColors.error),
                      onPressed: _busy ? null : () => _onAction(o, 'rejected'),
                      child: const Text('Reject'),
                    ),
                  ),
                if (next.contains('rejected') && next.contains('cancelled'))
                  const SizedBox(width: 8),
                if (next.contains('cancelled'))
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : () => _onAction(o, 'cancelled'),
                      child: const Text('Cancel'),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
