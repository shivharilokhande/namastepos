// NamastePOS — Customer detail (2026-08-22, founder request).
//
// Tapping a customer in the CRM list opens this screen: profile stats,
// points, order history, favourite items, and membership — with an
// "Add membership" flow (pick a plan → payment method → subscribed).
// Data comes from GET /businesses/:id/customer-history/:phone.
//
// 2026-08-25 (Round-2 mobile parity with CustomerDetailDrawer.tsx):
//   • Wallet card — balance + last 10 ledger rows, hidden entirely when
//     the loyalty addon is off (walletFor returns null on 402).
//   • Membership sell now asks for a real tender (cash/upi/card/wallet;
//     wallet only when the balance covers the plan price).
//   • Cancel membership — % charge + payout mode, refund computed
//     server-side and echoed back in a snackbar.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/customer.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../orders/order_detail_screen.dart';
import '../../widgets/membership_plan_dialog.dart';

// Humanized wallet-ledger labels (2026-08-25, parity with the dashboard's
// WALLET_REASON_LABELS). Keys are the raw `kind` values giftCardService
// writes; anything unknown falls back to the raw key so a future ledger
// reason is never rendered blank.
const Map<String, String> _walletReasonLabels = {
  'order_payment': 'Order payment',
  'shortfall': 'Shortfall due',
  'membership_refund': 'Membership refund',
  'topup': 'Top-up',
  'redeem': 'Redeemed',
  'manual_adjust': 'Manual adjustment',
  'gift_card_load': 'Gift card load',
};

class CustomerDetailScreen extends StatefulWidget {
  final Customer customer;
  const CustomerDetailScreen({super.key, required this.customer});

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> {
  Map<String, dynamic>? _profile;
  bool _loading = true;

  // Wallet (2026-08-25). Three states: hidden (402 → addon off — the
  // whole card disappears, same as the dashboard), error (network/5xx —
  // show "couldn't load"), loaded (balance + ledger).
  Map<String, dynamic>? _wallet;
  bool _walletHidden = false;
  bool _walletLoading = true;
  bool _walletError = false;

  // Guards double-taps on the cancel-membership button while the
  // subscription-id lookup / cancel POST is in flight.
  bool _cancelBusy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() {
        _loading = false;
        _walletLoading = false;
      });
      return;
    }
    // Profile and wallet refresh together — a membership sale/cancel
    // changes both (ledger row + activeMembership), same as the
    // dashboard's refreshAll().
    await Future.wait([_loadProfile(biz.id), _loadWallet(biz.id)]);
  }

  Future<void> _loadProfile(String businessId) async {
    try {
      final r = await ApiService.instance.dio.get(
        '/businesses/$businessId/customer-history/${widget.customer.phone}',
      );
      if (!mounted) return;
      setState(() {
        _profile = (r.data as Map).cast<String, dynamic>();
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadWallet(String businessId) async {
    try {
      final w = await ApiService.instance
          .walletFor(businessId, widget.customer.id);
      if (!mounted) return;
      setState(() {
        _wallet = w;
        // null = 402 (loyalty addon off) → hide the card entirely rather
        // than showing an empty/broken wallet, matching the dashboard.
        _walletHidden = w == null;
        _walletLoading = false;
        _walletError = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _walletLoading = false;
          _walletError = true;
        });
      }
    }
  }

  double? get _walletBalanceInr =>
      (_wallet?['balanceInr'] as num?)?.toDouble();

  Future<void> _addMembership() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final messenger = ScaffoldMessenger.of(context);
    List<dynamic> plans = [];
    try {
      plans = await ApiService.instance.listMemberships(biz.id);
    } catch (e) {
      messenger.showSnackBar(
          SnackBar(content: Text(humanizeError(e))));
      return;
    }
    if (!mounted) return;
    if (plans.isEmpty) {
      messenger.showSnackBar(const SnackBar(
        content: Text('No membership plans yet — create one below.'),
      ));
      await _createMembershipPlan();
      return;
    }
    final picked = await showModalBottomSheet<Map<String, dynamic>?>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Pick a membership plan',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            ),
            for (final p in plans)
              ListTile(
                leading: const Icon(Icons.card_membership,
                    color: AppColors.primary),
                title: Text((p as Map)['name']?.toString() ?? 'Plan'),
                subtitle: Text(
                    '${AppFmt.moneyPaise((p['price_paise'] ?? 0) as num)} · '
                    '${p['validity_days'] ?? 30} days'),
                onTap: () => Navigator.pop(
                    sheetCtx, p.cast<String, dynamic>()),
              ),
            // 2026-08-23: creating a bundled plan was only reachable
            // when NO plans existed — now always available here.
            ListTile(
              leading: const Icon(Icons.add_circle_outline,
                  color: AppColors.textSecondary),
              title: const Text('Create new plan…'),
              onTap: () =>
                  Navigator.pop(sheetCtx, {'__create__': true}),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    if (picked['__create__'] == true) {
      final created = await showCreateMembershipPlanDialog(context);
      if (created && mounted) await _addMembership(); // reopen picker
      return;
    }

    // Payment step (2026-08-25, parity with AddMembershipDialog): a
    // membership sale is a real tender so it lands in revenue reporting —
    // no more silent hardcoded 'cash'.
    final priceInr = ((picked['price_paise'] ?? 0) as num) / 100;
    final method = await _pickPaymentMethod(priceInr);
    if (method == null || !mounted) return;

    try {
      await ApiService.instance.subscribeMembership(
        biz.id,
        customerId: widget.customer.id,
        membershipId: picked['id'].toString(),
        paymentMethod: method,
      );
      messenger.showSnackBar(SnackBar(
        content: Text('${picked['name']} sold — '
            '${AppFmt.money(priceInr, decimals: true)} by '
            '${method == 'upi' ? 'UPI' : method} ✓'),
        backgroundColor: AppColors.success,
      ));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    }
  }

  /// Bottom sheet: cash / UPI / card / wallet. Wallet is only enabled
  /// when the balance covers the full plan price — the backend debits
  /// atomically and would 400 on insufficient funds, so don't present a
  /// tender we know will fail (same rule as the dashboard's walletOk).
  Future<String?> _pickPaymentMethod(double priceInr) {
    final bal = _walletHidden ? null : _walletBalanceInr;
    final walletOk = bal != null && bal >= priceInr;
    return showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                  'Charge ${AppFmt.money(priceInr, decimals: true)} by',
                  style: const TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w800)),
            ),
            for (final m in const [
              ('cash', 'Cash', Icons.payments_outlined),
              ('upi', 'UPI', Icons.qr_code_2),
              ('card', 'Card', Icons.credit_card),
            ])
              ListTile(
                leading: Icon(m.$3, color: AppColors.primary),
                title: Text(m.$2),
                onTap: () => Navigator.pop(sheetCtx, m.$1),
              ),
            // Wallet tender only shows at all when the wallet card is
            // visible (addon on) — a hidden wallet can't pay.
            if (bal != null)
              ListTile(
                enabled: walletOk,
                leading: Icon(Icons.account_balance_wallet_outlined,
                    color: walletOk
                        ? AppColors.primary
                        : AppColors.textSecondary),
                title: const Text('Wallet'),
                subtitle: Text(walletOk
                    ? '${AppFmt.money(bal, decimals: true)} available'
                    : '${AppFmt.money(bal, decimals: true)} — not enough '
                        'for this plan\'s price'),
                onTap: walletOk
                    ? () => Navigator.pop(sheetCtx, 'wallet')
                    : null,
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  /// Cancel the active subscription with a refund of the unused share.
  /// The refund maths (bundle- vs time-based) lives server-side; we only
  /// collect inputs and show the returned summary.
  Future<void> _cancelMembership() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null || _cancelBusy) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _cancelBusy = true);

    // WHY lookup here (2026-08-25): the customer-history payload's
    // activeMembership has NO subscription id (backend selects only
    // name/expires_at/benefits/remaining and is frozen for this change).
    // GET /customers/lookup?phone= DOES return it via
    // membershipService.activeForCustomer → membership.subscription_id —
    // the exact same source the dashboard's CancelMembershipDialog uses.
    Map<String, dynamic>? sub;
    try {
      final r = await ApiService.instance
          .lookupCustomer(biz.id, widget.customer.phone);
      sub = (r?['membership'] as Map?)?.cast<String, dynamic>();
    } catch (e) {
      if (mounted) setState(() => _cancelBusy = false);
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
      return;
    }
    if (!mounted) return;
    if (sub == null || sub['subscription_id'] == null) {
      // Race: it expired / was cancelled elsewhere between screen load
      // and this tap.
      setState(() => _cancelBusy = false);
      messenger.showSnackBar(const SnackBar(
        content: Text("Couldn't find an active subscription — it may have "
            'just expired or been cancelled. Pull to refresh.'),
      ));
      return;
    }

    final planName = sub['name']?.toString() ??
        ((_profile?['activeMembership'] as Map?)?['name']?.toString() ??
            'membership');
    final input = await _showCancelDialog(planName);
    if (!mounted || input == null) {
      if (mounted) setState(() => _cancelBusy = false);
      return;
    }

    try {
      final res = await ApiService.instance.cancelCustomerMembership(
        biz.id,
        sub['subscription_id'].toString(),
        mode: input.$1,
        cancellationPct: input.$2,
      );
      // Backend echoes the computed refund: {mode, refundInr,
      // cancellationFeeInr, …} — show the real numbers, never a client
      // guess (parity with the dashboard's success toast).
      final refund = (res['refund'] as Map?)?.cast<String, dynamic>();
      final amt = AppFmt.money(
          (refund?['refundInr'] as num?)?.toDouble() ?? 0,
          decimals: true);
      final fee = AppFmt.money(
          (refund?['cancellationFeeInr'] as num?)?.toDouble() ?? 0,
          decimals: true);
      final mode = refund?['mode']?.toString() ?? input.$1;
      messenger.showSnackBar(SnackBar(
        content: Text(mode == 'wallet'
            ? '$amt credited to wallet after $fee fee'
            : '$amt to pay out by ${mode == 'upi' ? 'UPI' : 'cash'} '
                'after $fee fee'),
        backgroundColor: AppColors.success,
      ));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    } finally {
      if (mounted) setState(() => _cancelBusy = false);
    }
  }

  /// Collects (payout mode, cancellation %) or null on dismiss.
  Future<(String, double)?> _showCancelDialog(String planName) {
    final pctCtrl = TextEditingController(text: '10'); // backend default
    String mode = 'wallet';
    return showDialog<(String, double)?>(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (dialogCtx, setDialogState) {
          final pct = double.tryParse(pctCtrl.text.trim());
          final pctValid = pct != null && pct >= 0 && pct <= 100;
          return AlertDialog(
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16)),
            title: const Text('Cancel membership'),
            // Column in SingleChildScrollView — NOT a ListView (shrinkwrap
            // jank + team convention: no ListView in AlertDialog).
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(TextSpan(children: [
                    const TextSpan(text: 'Cancelling '),
                    TextSpan(
                        text: planName,
                        style:
                            const TextStyle(fontWeight: FontWeight.w800)),
                    const TextSpan(text: '.'),
                  ])),
                  const SizedBox(height: 12),
                  TextField(
                    controller: pctCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                        decimal: true),
                    decoration: InputDecoration(
                      labelText: 'Cancellation charge (%)',
                      border: const OutlineInputBorder(),
                      errorText: pctValid
                          ? null
                          : 'Enter a value between 0 and 100.',
                    ),
                    onChanged: (_) => setDialogState(() {}),
                  ),
                  const SizedBox(height: 12),
                  const Text('Refund payout',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  for (final m in const [
                    ('wallet', 'Wallet credit (recommended)'),
                    ('cash', 'Cash'),
                    ('upi', 'UPI'),
                  ])
                    RadioListTile<String>(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      value: m.$1,
                      groupValue: mode,
                      title: Text(m.$2),
                      onChanged: (v) =>
                          setDialogState(() => mode = v ?? 'wallet'),
                    ),
                  const SizedBox(height: 4),
                  // The exact ₹ figures depend on the unused bundle/time
                  // share which only the backend knows — state the rule,
                  // show the real summary in the success snackbar.
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.warning_amber_rounded,
                            size: 18, color: AppColors.warning),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Remaining value minus '
                            '${pctValid ? AppFmt.quantity(pct) : '—'}% '
                            'cancellation charge will be refunded. The '
                            'final amount is computed on confirm from the '
                            'unused part of the plan.',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogCtx),
                child: const Text('Keep membership'),
              ),
              FilledButton(
                style: FilledButton.styleFrom(
                    backgroundColor: AppColors.error),
                onPressed: pctValid
                    ? () => Navigator.pop(dialogCtx, (mode, pct))
                    : null,
                child: const Text('Cancel & refund'),
              ),
            ],
          );
        },
      ),
    );
  }

  /// Owner-only quick create — shared dialog (bundle items + price +
  /// validity). See widgets/membership_plan_dialog.dart.
  Future<void> _createMembershipPlan() async {
    await showCreateMembershipPlanDialog(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.customer;
    final prof =
        (_profile?['customer'] as Map?)?.cast<String, dynamic>();
    final recent = (_profile?['recentOrders'] as List?) ?? [];
    final favourites = (_profile?['favourites'] as List?) ?? [];
    final activeMembership =
        (_profile?['activeMembership'] as Map?)?.cast<String, dynamic>();

    return Scaffold(
      appBar: AppBar(
          title: Text(c.name?.isNotEmpty == true ? c.name! : c.phone)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Stats card
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceAround,
                      children: [
                        _stat('${prof?['pointsBalance'] ?? c.pointsBalance}',
                            'Points'),
                        _stat('${prof?['totalOrders'] ?? c.visitCount}',
                            'Orders'),
                        _stat(
                            AppFmt.money((prof?['totalSpent'] as num?)
                                    ?.toDouble() ??
                                c.totalSpent),
                            'Spent'),
                        _stat((prof?['tier'] ?? c.tier).toString(), 'Tier'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  // Wallet (2026-08-25) — hidden entirely on 402 (loyalty
                  // addon off), same as the dashboard drawer.
                  if (!_walletHidden) ...[
                    _sectionTitle('Wallet'),
                    if (_walletLoading)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Center(
                            child: SizedBox(
                                height: 20,
                                width: 20,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2))),
                      )
                    else if (_walletError)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Text("Couldn't load wallet.",
                            style:
                                TextStyle(color: AppColors.textSecondary)),
                      )
                    else if (_wallet != null)
                      _walletCard(),
                    const SizedBox(height: 16),
                  ],
                  // Membership
                  _sectionTitle('Membership'),
                  if (activeMembership != null) ...[
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.card_membership,
                          color: AppColors.success),
                      title: Text(
                          activeMembership['name']?.toString() ?? 'Member'),
                      subtitle: Text(
                          'Valid till ${(activeMembership['expires_at'] ?? '').toString().split('T').first}'),
                    ),
                    // Remaining bundle balance (2026-08-23): "12× Cold
                    // Coffee left" chips, counted down on every order.
                    if (activeMembership['remaining'] is List &&
                        (activeMembership['remaining'] as List).isNotEmpty)
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: [
                          for (final e
                              in (activeMembership['remaining'] as List))
                            Chip(
                              visualDensity: VisualDensity.compact,
                              label: Text(
                                '${(e as Map)['qty']}× ${_menuName(e['menuItemId']?.toString())} left',
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                        ],
                      ),
                    const SizedBox(height: 8),
                    // Cancel with refund (2026-08-25 parity).
                    OutlinedButton.icon(
                      icon: _cancelBusy
                          ? const SizedBox(
                              height: 16,
                              width: 16,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2))
                          : const Icon(Icons.block,
                              size: 18, color: AppColors.error),
                      label: const Text('Cancel membership',
                          style: TextStyle(color: AppColors.error)),
                      onPressed: _cancelBusy ? null : _cancelMembership,
                    ),
                  ] else
                    OutlinedButton.icon(
                      icon: const Icon(Icons.card_membership, size: 18),
                      label: const Text('Add membership'),
                      onPressed: _addMembership,
                    ),
                  const SizedBox(height: 16),
                  // Order history
                  _sectionTitle('Order history'),
                  if (recent.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('No orders yet.',
                          style:
                              TextStyle(color: AppColors.textSecondary)),
                    )
                  else
                    ...recent.map((o) {
                      final m = (o as Map).cast<String, dynamic>();
                      final when = DateTime.tryParse(
                          (m['created_at'] ?? '').toString());
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        // Tap → full order invoice (2026-08-23)
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) =>
                                OrderDetailScreen(orderId: m['id'] as String),
                          ),
                        ),
                        leading: const Icon(Icons.receipt_long_outlined),
                        title: Text('Order #${m['order_no']}',
                            style: const TextStyle(
                                fontWeight: FontWeight.w700)),
                        subtitle: Text(when != null
                            ? '${AppFmt.date(when)} · ${m['status']}'
                            : '${m['status']}'),
                        trailing: Text(
                            AppFmt.money(double.tryParse(
                                    m['total'].toString()) ??
                                0),
                            style: const TextStyle(
                                fontWeight: FontWeight.w800)),
                      );
                    }),
                  const SizedBox(height: 16),
                  // Favourites
                  if (favourites.isNotEmpty) ...[
                    _sectionTitle('Usually orders'),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        for (final f in favourites)
                          Chip(
                            label: Text(
                                '${(f as Map)['name']} ×${f['qty_total']}'),
                            labelStyle: const TextStyle(fontSize: 12),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  /// Balance + last 10 ledger rows. Negative balance = recorded shortfall
  /// debt ("customer underpaid, owes us") → red + explicit label so a
  /// cashier never mistakes a due for a credit.
  Widget _walletCard() {
    final bal = _walletBalanceInr ?? 0;
    final txns = ((_wallet?['transactions'] as List?) ?? [])
        .take(10)
        .toList();
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Balance',
                    style: TextStyle(color: AppColors.textSecondary)),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      AppFmt.money(bal, decimals: true),
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                        color: bal < 0 ? AppColors.error : null,
                      ),
                    ),
                    if (bal < 0)
                      const Text('Customer owes this amount',
                          style: TextStyle(
                              fontSize: 11, color: AppColors.error)),
                  ],
                ),
              ],
            ),
          ),
          if (txns.isNotEmpty) const Divider(height: 1),
          for (final t in txns) _walletTxnRow((t as Map).cast<String, dynamic>()),
        ],
      ),
    );
  }

  Widget _walletTxnRow(Map<String, dynamic> t) {
    final amt = (t['amountInr'] as num?)?.toDouble() ?? 0;
    final when =
        DateTime.tryParse((t['createdAt'] ?? '').toString());
    final note = t['note']?.toString();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.divider)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _walletReasonLabels[t['reason']] ??
                      t['reason']?.toString() ??
                      '—',
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w700),
                ),
                if (note != null && note.isNotEmpty)
                  Text(note,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.textSecondary)),
                if (when != null)
                  Text(AppFmt.dateTime(when),
                      style: const TextStyle(
                          fontSize: 11,
                          color: AppColors.textSecondary)),
              ],
            ),
          ),
          // Credit green / debit red with an explicit sign — same visual
          // contract as the dashboard's ledger list.
          Text(
            '${amt < 0 ? '−' : '+'}${AppFmt.money(amt.abs(), decimals: true)}',
            style: TextStyle(
              fontWeight: FontWeight.w800,
              color: amt < 0 ? AppColors.error : AppColors.success,
            ),
          ),
        ],
      ),
    );
  }

  String _menuName(String? menuItemId) {
    if (menuItemId == null) return 'item';
    final matches = context
        .read<MenuProvider>()
        .visibleItems
        .where((m) => m.id == menuItemId);
    return matches.isEmpty ? 'item' : matches.first.name;
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t,
            style: const TextStyle(
                fontWeight: FontWeight.w800, fontSize: 15)),
      );

  Widget _stat(String v, String label) => Column(
        children: [
          Text(v,
              style: const TextStyle(
                  fontSize: 16, fontWeight: FontWeight.w900)),
          Text(label,
              style: const TextStyle(
                  fontSize: 11, color: AppColors.textSecondary)),
        ],
      );
}
