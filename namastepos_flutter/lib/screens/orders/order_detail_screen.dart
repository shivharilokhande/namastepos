// NamastePOS - Order detail with timeline & actions

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/order.dart';
import '../../providers/auth_provider.dart';
import '../../providers/orders_provider.dart';
import '../../services/api_service.dart';
import '../../services/printer_service.dart';
import '../../services/whatsapp_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../settings/printer_setup_screen.dart';

class OrderDetailScreen extends StatefulWidget {
  final String orderId;
  const OrderDetailScreen({super.key, required this.orderId});

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  String get orderId => widget.orderId;

  // Fallback fetch (2026-08-23, founder): the screen only searched the
  // OrdersProvider list, so older orders (e.g. opened from a customer's
  // order history months back) rendered "Order not found". Now we fetch
  // by id from the backend when the local list doesn't have it.
  Order? _fetched;
  bool _fetching = false;

  @override
  void initState() {
    super.initState();
    // Always pull the fresh copy — it carries refundedInr and the latest
    // status even when the provider list has a stale/absent row.
    WidgetsBinding.instance.addPostFrameCallback((_) => _fetchById());
  }

  Future<void> _fetchById() async {
    if (_fetching) return;
    _fetching = true;
    try {
      final biz = context.read<AuthProvider>().business;
      if (biz == null) return;
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/orders/$orderId');
      final m = (r.data['order'] as Map?)?.cast<String, dynamic>();
      if (m != null && mounted) {
        // fromBackend — the API sends real bools + embedded items
        // (fromMap is the sqflite 0/1 shape and would throw).
        setState(() => _fetched = Order.fromBackend(m));
      }
    } catch (_) { /* keep the not-found state */ } finally {
      _fetching = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final all = context.watch<OrdersProvider>().orders;
    Order? providerOrder;
    for (final o in all) {
      if (o.id == orderId) { providerOrder = o; break; }
    }
    // Session BILLS only exist merged in the provider list — keep that
    // view. Otherwise the fresh backend copy wins (it carries
    // refundedInr + latest status).
    Order? order = (providerOrder != null && providerOrder.isBill)
        ? providerOrder
        : (_fetched ?? providerOrder);
    final refundedInr = _fetched?.refundedInr ?? order?.refundedInr ?? 0;
    if (order == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Order')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final auth = context.watch<AuthProvider>();

    final isBill = order.isBill;
    final billNumber = order.displayNo ?? order.orderNo;
    return Scaffold(
      appBar: AppBar(title: Text(isBill ? 'Bill #$billNumber' : 'Order #$billNumber')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _statusBanner(order),
          const SizedBox(height: 16),
          if (isBill && order.kots.length > 1) ...[
            _section('KOTs in this bill', _kotsList(order)),
            const SizedBox(height: 12),
          ],
          _section('Items', _itemsList(order)),
          const SizedBox(height: 12),
          _section('Totals', _totals(order, refundedInr)),
          const SizedBox(height: 12),
          _section('Details', _details(order)),
          const SizedBox(height: 12),
          _section('Timeline', _timeline(order)),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: Builder(builder: (btnCtx) => OutlinedButton.icon(
                  onPressed: () async {
                    if (auth.business == null) return;
                    // Bug fix (2026-08-21): earlier version silently
                    // swallowed the whole flow. If no printer was ever
                    // paired, `printSessionBill / printToken` returned
                    // false but the user saw nothing happen. Now we
                    // check the return value + tell them what to do.
                    final messenger = ScaffoldMessenger.of(btnCtx)
                      ..hideCurrentSnackBar();  // clear any lingering snack
                    bool ok = false;
                    try {
                      if (isBill && order.tableSessionId != null) {
                        final r = await ApiService.instance.dio.get(
                          '/businesses/${auth.business!.id}/ops/sessions/${order.tableSessionId}',
                        );
                        final session = (r.data['session'] as Map).cast<String, dynamic>();
                        ok = await PrinterService.instance.printSessionBill(
                          session: session, business: auth.business!,
                        );
                        // Session fetch itself may 404 on older orders;
                        // fall back to per-order path so the user still
                        // gets a receipt.
                        if (!ok) {
                          ok = await PrinterService.instance.printToken(order, auth.business!);
                        }
                      } else {
                        ok = await PrinterService.instance.printToken(order, auth.business!);
                      }
                    } catch (e) {
                      messenger.showSnackBar(SnackBar(
                        content: Text("Couldn't reprint — " + humanizeError(e)),
                        backgroundColor: AppColors.error,
                      ));
                      return;
                    }
                    if (ok) {
                      // Bug fix (B10): also record the reprint on the
                      // backend so the audit trail (`reprint_count`,
                      // `last_reprint_at`) reflects reality and the
                      // "DUPLICATE — printed 2×" banner works. Fire-
                      // and-forget: never block or fail the user
                      // toast on it.
                      try {
                        await ApiService.instance.dio.post(
                          '/businesses/${auth.business!.id}/orders/${order.id}/print',
                        );
                      } catch (_) { /* silent — printer already fired */ }
                      messenger.showSnackBar(const SnackBar(
                        content: Text('Reprinted to the paired thermal printer.'),
                        duration: Duration(seconds: 2),
                      ));
                    } else {
                      // Most common cause: no printer paired yet.
                      messenger.showSnackBar(SnackBar(
                        content: const Text(
                            "No printer connected. Pair one in Settings → Printers."),
                        backgroundColor: AppColors.error,
                        duration: const Duration(seconds: 5),
                        action: SnackBarAction(
                          label: 'Open',
                          textColor: Colors.white,
                          // Bug fix (2026-08-21): the earlier version
                          // used pushNamed('/settings/printers') but
                          // that route was never registered in app.dart
                          // so the button silently did nothing. Push
                          // the screen directly.
                          onPressed: () {
                            messenger.hideCurrentSnackBar();
                            Navigator.of(btnCtx).push(
                              MaterialPageRoute(
                                builder: (_) => const PrinterSetupScreen(),
                              ),
                            );
                          },
                        ),
                      ));
                    }
                  },
                  icon: const Icon(Icons.print_outlined),
                  label: const Text('Reprint'),
                )),
              ),
              if (order.customerPhone != null) ...[
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF25D366)),
                    onPressed: () async {
                      if (auth.business != null) {
                        await WhatsAppService.instance.notifyOrderReady(order, auth.business!);
                      }
                    },
                    icon: const Icon(Icons.chat_rounded),
                    label: const Text('WhatsApp'),
                  ),
                ),
              ],
            ],
          ),
          // FF-304 mobile parity — partial/full refund. Owner-only,
          // collected + paid orders only. Backend endpoint already
          // exists with owner-role + impersonation guards.
          if (auth.role == 'business_owner'
              && order.status == OrderStatus.collected
              && order.paymentMethod != PaymentMethod.unpaid) ...[
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => _openRefundDialog(context, order, auth.business?.id),
                icon: const Icon(Icons.currency_rupee),
                label: const Text('Refund…'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.warning,
                  side: const BorderSide(color: AppColors.warning),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _openRefundDialog(
      BuildContext context, Order order, String? businessId) async {
    if (businessId == null) return;
    final result = await showDialog<_RefundResult>(
      context: context,
      builder: (_) => _RefundDialog(order: order),
    );
    if (result == null) return;
    if (!context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiService.instance.refundOrder(businessId, order.id, {
        if (result.items != null && result.items!.isNotEmpty)
          'items': result.items,
        if (result.amountInr != null)
          'amountInr': result.amountInr,
        if (result.reason != null && result.reason!.isNotEmpty)
          'reason': result.reason,
      });
      messenger.showSnackBar(SnackBar(
        content: Text('Refund processed'),
        backgroundColor: AppColors.success,
      ));
      // Refresh orders so status/audit is up to date, and re-fetch this
      // order so the "Refunded" line shows immediately (2026-08-23).
      if (context.mounted) {
        await context.read<OrdersProvider>().refresh();
      }
      _fetched = null;
      await _fetchById();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
        content: Text('Refund failed: ${humanizeError(e)}'),
        backgroundColor: AppColors.error,
      ));
    }
  }

  Widget _statusBanner(Order o) {
    final color = switch (o.status) {
      OrderStatus.pending => AppColors.statusPending,
      OrderStatus.ready => AppColors.statusReady,
      OrderStatus.collected => AppColors.statusCollected,
      OrderStatus.cancelled => AppColors.statusCancelled,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(Icons.circle, color: color, size: 12),
          const SizedBox(width: 8),
          Text(o.status.name.toUpperCase(),
              style: TextStyle(color: color, fontWeight: FontWeight.w700)),
          const Spacer(),
          Text(AppFmt.dateTime(o.createdAt),
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
        ],
      ),
    );
  }

  Widget _section(String title, Widget child) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  Widget _itemsList(Order o) => Column(
        children: o.items.map((it) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${it.name}  ×${it.qty.toInt()}'),
                    if (it.note != null && it.note!.isNotEmpty)
                      Text('(${it.note})',
                          style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                  ],
                ),
              ),
              Text(AppFmt.money(it.lineTotal, decimals: true),
                  style: const TextStyle(fontWeight: FontWeight.w600)),
            ],
          ),
        )).toList(),
      );

  Widget _totals(Order o, [double refundedInr = 0]) {
    // Full bill breakup (2026-08-26). Coupon is included within Discount.
    final hasSplitGst = o.cgst > 0 || o.sgst > 0;
    final tenders = o.paymentBreakdown ?? const [];
    return Column(
      children: [
        _row('Subtotal', AppFmt.money(o.subtotal, decimals: true)),
        if (o.discount > 0)
          _row('Discount (incl. coupon)', '-${AppFmt.money(o.discount, decimals: true)}'),
        if (o.loyaltyDiscountInr > 0)
          _row('Loyalty${o.pointsRedeemed > 0 ? ' (${o.pointsRedeemed} pts)' : ''}',
              '-${AppFmt.money(o.loyaltyDiscountInr, decimals: true)}'),
        if (o.serviceChargeInr > 0)
          _row('Service charge', AppFmt.money(o.serviceChargeInr, decimals: true)),
        if (hasSplitGst) ...[
          if (o.cgst > 0) _row('CGST', AppFmt.money(o.cgst, decimals: true)),
          if (o.sgst > 0) _row('SGST', AppFmt.money(o.sgst, decimals: true)),
        ] else if (o.igst > 0)
          _row('IGST', AppFmt.money(o.igst, decimals: true))
        else if (o.tax > 0)
          _row('Tax (GST)', AppFmt.money(o.tax, decimals: true)),
        if (o.roundOffInr != 0)
          _row('Round-off', AppFmt.money(o.roundOffInr, decimals: true)),
        const Divider(),
        _row('Total', AppFmt.money(o.total, decimals: true), bold: true, big: true),
        // Payment tenders (split / wallet / points), when present.
        if (tenders.isNotEmpty) ...[
          const SizedBox(height: 4),
          ...tenders.map((t) => _row(
                'Paid · ${(t['method'] ?? '').toString().toUpperCase()}',
                AppFmt.money((t['amountInr'] as num?)?.toDouble() ?? 0, decimals: true),
              )),
        ],
        // Refunds against this order (2026-08-23, founder request)
        if (refundedInr > 0) ...[
          _row('Refunded', '-${AppFmt.money(refundedInr, decimals: true)}',
              color: AppColors.error),
          _row('Net after refund',
              AppFmt.money(o.total - refundedInr, decimals: true),
              bold: true),
        ],
      ],
    );
  }

  Widget _details(Order o) => Column(
        children: [
          _row('Source', o.source.name),
          if (o.tableNo != null) _row('Table', o.tableNo!),
          _row('Payment', o.paymentMethod.name.toUpperCase()),
          if (o.customerPhone != null) _row('Customer', o.customerPhone!),
          _row('Printed', o.printed ? 'Yes' : 'No'),
        ],
      );

  Widget _timeline(Order o) => Column(
        children: [
          _row('Created', AppFmt.dateTime(o.createdAt)),
          if (o.readyAt != null) _row('Ready', AppFmt.dateTime(o.readyAt!)),
          if (o.collectedAt != null) _row('Collected', AppFmt.dateTime(o.collectedAt!)),
          if (o.cancelReason != null && o.cancelReason!.isNotEmpty)
            _row('Cancel reason', o.cancelReason!),
        ],
      );

  /// Drill-down list for bills with multiple KOTs — shows each ticket
  /// (5, 5.1, 5.2…), its total and status so the kitchen + cashier can
  /// trace which round of food belongs to what.
  Widget _kotsList(Order o) => Column(
        children: o.kots.map((k) {
          final label  = k['label']?.toString() ?? '#${k['orderNo']}';
          final total  = (k['total'] as num?)?.toDouble() ?? 0;
          final status = k['status']?.toString() ?? '';
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text('KOT $label',
                      style: const TextStyle(fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: AppColors.primary)),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(status.toUpperCase(),
                      style: const TextStyle(
                          color: AppColors.textSecondary, fontSize: 12)),
                ),
                Text(AppFmt.money(total, decimals: true),
                    style: const TextStyle(fontWeight: FontWeight.w600)),
              ],
            ),
          );
        }).toList(),
      );

  Widget _row(String l, String v,
          {bool bold = false, bool big = false, Color? color}) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Text(l, style: const TextStyle(color: AppColors.textSecondary)),
            const Spacer(),
            Text(
              v,
              style: TextStyle(
                fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                fontSize: big ? 18 : 14,
                color: color ??
                    (bold ? AppColors.primary : AppColors.textPrimary),
              ),
            ),
          ],
        ),
      );
}

// ── FF-304 mobile refund dialog ─────────────────────────────────────────
// Same two modes as the dashboard version:
//   * Refund amount — freeform, capped at order total
//   * Refund items  — checklist; sent as `itemIds` so backend re-derives
//                     the amount from menu-item prices (safer, immune to
//                     stale-UI over-refund attacks)
//
// Result is returned via `Navigator.pop(_RefundResult(...))`.
class _RefundResult {
  // Partial-qty item refunds (2026-08-23): [{'id': ..., 'qty': ...}]
  final List<Map<String, dynamic>>? items;
  final double? amountInr;
  final String? reason;
  _RefundResult({this.items, this.amountInr, this.reason});
}

class _RefundDialog extends StatefulWidget {
  final Order order;
  const _RefundDialog({required this.order});
  @override
  State<_RefundDialog> createState() => _RefundDialogState();
}

class _RefundDialogState extends State<_RefundDialog> {
  late _Mode _mode;
  late TextEditingController _amount;
  late TextEditingController _reason;
  // Per-item refund QUANTITY (2026-08-23, founder: "2 chai ordered but
  // refund 1 should be possible"). 0 = not refunding this line.
  final Map<String, double> _qtySel = {};

  @override
  void initState() {
    super.initState();
    _mode = _Mode.amount;
    _amount = TextEditingController(
      text: widget.order.total.toStringAsFixed(2),
    );
    _reason = TextEditingController();
  }

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    super.dispose();
  }

  double get _itemsTotal {
    double sum = 0;
    for (final it in widget.order.items) {
      final q = _qtySel[it.id] ?? 0;
      if (q > 0) sum += q * it.price;
    }
    return sum;
  }

  double get _effectiveAmount => _mode == _Mode.items
      ? _itemsTotal
      : (double.tryParse(_amount.text) ?? 0);

  bool get _valid {
    final a = _effectiveAmount;
    return a > 0 && a <= widget.order.total + 0.005;
  }

  @override
  Widget build(BuildContext context) {
    final order = widget.order;
    final total = order.total;
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      title: Text('Refund #${order.displayNo ?? order.orderNo}'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Original total ${AppFmt.money(total)}',
                style: const TextStyle(
                    fontSize: 12, color: AppColors.textSecondary)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => setState(() => _mode = _Mode.amount),
                    style: OutlinedButton.styleFrom(
                      backgroundColor: _mode == _Mode.amount
                          ? AppColors.primary.withValues(alpha: 0.10) : null,
                    ),
                    child: const Text('Amount'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: order.items.isEmpty
                        ? null
                        : () => setState(() => _mode = _Mode.items),
                    style: OutlinedButton.styleFrom(
                      backgroundColor: _mode == _Mode.items
                          ? AppColors.primary.withValues(alpha: 0.10) : null,
                    ),
                    child: const Text('Items'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (_mode == _Mode.amount) ...[
              TextField(
                controller: _amount,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                  labelText: 'Amount (₹)',
                  prefixIcon: Icon(Icons.currency_rupee),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  TextButton(
                    onPressed: () => setState(() =>
                        _amount.text = total.toStringAsFixed(2)),
                    child: const Text('Full'),
                  ),
                  TextButton(
                    onPressed: () => setState(() =>
                        _amount.text = (total / 2).toStringAsFixed(2)),
                    child: const Text('Half'),
                  ),
                ],
              ),
            ],
            if (_mode == _Mode.items) ...[
              // Crash fix (2026-08-22, founder screenshot): AlertDialog
              // sizes its content with IntrinsicWidth, and ListView can't
              // report intrinsic dimensions → layout exception → the
              // dialog rendered as a blank surface. A plain Column works
              // (the outer SingleChildScrollView already scrolls).
              Container(
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.divider),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Qty steppers (2026-08-23): refund PART of a line —
                    // e.g. 1 of the 2 chai.
                    for (final it in order.items)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                      '${it.qty.toStringAsFixed(0)} × ${it.name}',
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w600,
                                          fontSize: 13)),
                                  Text('${AppFmt.money(it.price)} each',
                                      style: const TextStyle(
                                          color: AppColors.textSecondary,
                                          fontSize: 11)),
                                ],
                              ),
                            ),
                            IconButton(
                              visualDensity: VisualDensity.compact,
                              icon: const Icon(Icons.remove_circle_outline,
                                  size: 20),
                              onPressed: (_qtySel[it.id] ?? 0) <= 0
                                  ? null
                                  : () => setState(() => _qtySel[it.id] =
                                      (_qtySel[it.id] ?? 0) - 1),
                            ),
                            SizedBox(
                              width: 22,
                              child: Text(
                                '${(_qtySel[it.id] ?? 0).toStringAsFixed(0)}',
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w800),
                              ),
                            ),
                            IconButton(
                              visualDensity: VisualDensity.compact,
                              icon: const Icon(Icons.add_circle_outline,
                                  size: 20),
                              onPressed: (_qtySel[it.id] ?? 0) >= it.qty
                                  ? null
                                  : () => setState(() => _qtySel[it.id] =
                                      (_qtySel[it.id] ?? 0) + 1),
                            ),
                          ],
                        ),
                      ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 8),
                      decoration: const BoxDecoration(
                        border: Border(top: BorderSide(color: AppColors.divider)),
                      ),
                      child: Row(
                        children: [
                          const Text('Selected total',
                              style: TextStyle(fontWeight: FontWeight.w700)),
                          const Spacer(),
                          Text(AppFmt.money(_itemsTotal),
                              style: const TextStyle(fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
            TextField(
              controller: _reason,
              decoration: const InputDecoration(
                labelText: 'Reason (optional)',
                hintText: 'e.g. Customer complaint — cold food',
              ),
            ),
            if (!_valid)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'Refund must be > ₹0 and no more than the order total.',
                  style: TextStyle(color: AppColors.error, fontSize: 12),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: !_valid ? null : () {
            final result = _mode == _Mode.items
                ? _RefundResult(
                    items: [
                      for (final e in _qtySel.entries)
                        if (e.value > 0) {'id': e.key, 'qty': e.value},
                    ],
                    reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
                  )
                : _RefundResult(
                    amountInr: double.tryParse(_amount.text),
                    reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
                  );
            Navigator.pop(context, result);
          },
          child: Text('Refund ${AppFmt.money(_effectiveAmount)}'),
        ),
      ],
    );
  }
}

enum _Mode { amount, items }
