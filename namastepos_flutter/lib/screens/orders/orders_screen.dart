// NamastePOS - Order queue with status tabs

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../models/order.dart';
import '../../providers/auth_provider.dart';
import '../../providers/orders_provider.dart';
import '../../providers/settings_provider.dart';
import '../../services/api_service.dart';
import '../../services/printer_service.dart';
import '../../services/whatsapp_service.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../utils/formatters.dart';
import 'order_detail_screen.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final TabController _tab = TabController(length: 4, vsync: this);
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Web-side status changes (dashboard marks an order ready or
    // collected) previously stayed invisible on mobile until pull-to-
    // refresh. Poll every 5 seconds while this screen is mounted — same
    // cadence the dashboard uses. `context.read` is safe in a Timer
    // callback because we cancel the timer in `dispose`.
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted) return;
      context.read<OrdersProvider>().refresh();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Pull once when the app returns to foreground so the queue is fresh
    // even before the next 5-second tick.
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<OrdersProvider>().refresh();
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _tab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>();

    // When the screen is opened via Navigator.push (e.g. from Reports →
    // Orders KPI), we want the system back arrow. Only fall back to the
    // hamburger / drawer button when this is a top-level tab.
    final isPushed = !(ModalRoute.of(context)?.isFirst ?? true);
    return Scaffold(
      appBar: AppBar(
        leading: isPushed ? null : const HomeDrawerButton(),
        title: const Text('Orders'),
        actions: [
          IconButton(
            tooltip: 'Clean local cache (re-sync from server)',
            icon: const Icon(Icons.cleaning_services_outlined),
            onPressed: () async {
              final auth = context.read<AuthProvider>();
              final biz = auth.business;
              if (biz == null) return;
              // Confirm — this wipes the local SQLite cache.
              final ok = await showDialog<bool>(
                context: context,
                builder: (_) => AlertDialog(
                  title: const Text('Clean local cache?'),
                  content: const Text(
                      'This deletes the local copy of your orders and re-pulls '
                      'from the server. Use this when the app shows orders '
                      'that aren\'t on the dashboard.'),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: const Text('Cancel')),
                    ElevatedButton(
                        onPressed: () => Navigator.pop(context, true),
                        child: const Text('Clean & refresh')),
                  ],
                ),
              );
              if (ok != true || !context.mounted) return;
              await context.read<OrdersProvider>().rebuildFromBackend(biz.id);
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                content: Text('Local cache cleaned — orders re-pulled from server'),
              ));
            },
          ),
        ],
        bottom: TabBar(
          controller: _tab,
          isScrollable: true,
          labelColor: AppColors.primary,
          unselectedLabelColor: AppColors.textSecondary,
          indicatorColor: AppColors.primary,
          tabs: [
            Tab(text: 'Pending (${orders.ofStatus(OrderStatus.pending).length})'),
            Tab(text: 'Ready (${orders.ofStatus(OrderStatus.ready).length})'),
            Tab(text: 'Collected (${orders.ofStatus(OrderStatus.collected).length})'),
            Tab(text: 'Cancelled (${orders.ofStatus(OrderStatus.cancelled).length})'),
          ],
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () => orders.refresh(),
        child: TabBarView(
          controller: _tab,
          children: [
            _OrdersList(status: OrderStatus.pending),
            _OrdersList(status: OrderStatus.ready),
            _OrdersList(status: OrderStatus.collected),
            _OrdersList(status: OrderStatus.cancelled),
          ],
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

class _OrdersList extends StatelessWidget {
  final OrderStatus status;
  const _OrdersList({required this.status});

  @override
  Widget build(BuildContext context) {
    final list = context.watch<OrdersProvider>().ofStatus(status);
    if (list.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 80),
          Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text('No orders here yet.',
                  style: TextStyle(color: AppColors.textSecondary)),
            ),
          ),
        ],
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      itemCount: list.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) => _OrderCard(order: list[i]),
    );
  }
}

class _OrderCard extends StatelessWidget {
  final Order order;
  const _OrderCard({required this.order});

  Color _statusColor() {
    switch (order.status) {
      case OrderStatus.pending: return AppColors.statusPending;
      case OrderStatus.ready: return AppColors.statusReady;
      case OrderStatus.collected: return AppColors.statusCollected;
      case OrderStatus.cancelled: return AppColors.statusCancelled;
    }
  }

  /// Bill rows (groupBy=session) wrap multiple KOTs. Tapping "Mark Ready"
  /// on the bill must flip EVERY pending KOT to ready, otherwise the
  /// collapse logic keeps the bill in Pending (worst-status wins). We
  /// fall back to the single-order path when this isn't a bill.
  /// Fix (2026-08-23, founder: "Cannot move order from collected to
  /// ready"): only include KOTs that can legally move to [target] —
  /// a bill can hold already-collected KOTs (kitchen finished them)
  /// alongside a fresh pending one, and the transitions matrix rightly
  /// rejects collected→ready for the finished ones.
  List<String> _kotIdsToUpdate(OrderStatus target) {
    if (order.isBill && order.kots.isNotEmpty) {
      const advanceable = {
        OrderStatus.ready: ['pending'],
        OrderStatus.collected: ['pending', 'ready'],
        OrderStatus.cancelled: ['pending', 'ready', 'collected'],
      };
      final from = advanceable[target] ?? const <String>[];
      return order.kots
          .where((k) => from.contains(k['status']?.toString()))
          .map((k) => k['id']?.toString())
          .whereType<String>()
          .toList();
    }
    return [order.id];
  }

  Future<void> _markReady(BuildContext context) async {
    final orders = context.read<OrdersProvider>();
    final auth = context.read<AuthProvider>();
    final settings = context.read<SettingsProvider>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      for (final id in _kotIdsToUpdate(OrderStatus.ready)) {
        await orders.updateStatus(id, OrderStatus.ready);
      }
      // Force a backend refresh so the local list is guaranteed in sync
      // (covers the case where the cascade hits an order our local copy
      // didn't have visibility into).
      await orders.refresh();
      // WhatsApp auto-notify is gated on BOTH the plan feature AND the
      // local toggle. See the matching block in confirm_order_screen.
      // Fix (2026-08-22): skip dine-in — waiter delivers to the table,
      // no "ready for pickup" WhatsApp needed (matches backend rule).
      if (order.source != OrderSource.dineIn &&
          settings.autoWhatsAppOnReady &&
          auth.has('auto_whatsapp_order') &&
          order.customerPhone != null &&
          auth.business != null) {
        await WhatsAppService.instance.notifyOrderReady(order, auth.business!);
      }
      messenger.showSnackBar(const SnackBar(
        content: Text('Order marked ready'),
        duration: Duration(seconds: 1),
      ));
    } catch (e) {
      // Previously rethrew silently → user sees nothing happen. Now show
      // the actual reason so we can diagnose (likely 401/402/404).
      messenger.showSnackBar(SnackBar(
        content: Text("Couldn't mark ready — " + humanizeError(e)),
        backgroundColor: AppColors.error,
      ));
    }
  }

  Future<void> _markCollected(BuildContext context) async {
    final orders = context.read<OrdersProvider>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      for (final id in _kotIdsToUpdate(OrderStatus.collected)) {
        await orders.updateStatus(id, OrderStatus.collected);
      }
      await orders.refresh();
      messenger.showSnackBar(const SnackBar(
        content: Text('Order collected'),
        duration: Duration(seconds: 1),
      ));
    } catch (e) {
      messenger.showSnackBar(SnackBar(
        content: Text("Couldn't mark collected — " + humanizeError(e)),
        backgroundColor: AppColors.error,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => OrderDetailScreen(orderId: order.id))),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.divider),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // FF-249: aggregator ribbon. Prominent per-provider tag so
            // kitchen staff can tell at a glance whether this is a
            // Zomato / Swiggy / Dunzo pickup vs a walk-in. Only shown
            // for actual online-channel orders.
            if (_isOnlineChannel(order.source)) _channelRibbon(order.source),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _statusColor().withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    order.status.name.toUpperCase(),
                    style: TextStyle(
                      color: _statusColor(),
                      fontWeight: FontWeight.w700,
                      fontSize: 11,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  // For bill rows (groupBy=session), show the bill #
                  // pinned to the first KOT in the session. Plain rows
                  // show their own KOT number as before.
                  '#${order.displayNo ?? order.orderNo}',
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
                ),
                if (order.isBill && order.kots.length > 1) ...[
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      '${order.kots.length} KOTs',
                      style: const TextStyle(
                        color: AppColors.primary,
                        fontSize: 10, fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
                const Spacer(),
                Text(AppFmt.time(order.createdAt),
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              order.items.map((e) => '${e.name} x${e.qty.toInt()}').join(', '),
              maxLines: 2, overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.textPrimary),
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(_sourceIcon(order.source), size: 14, color: AppColors.textSecondary),
                const SizedBox(width: 4),
                Text(order.source.name,
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                if (order.tableNo != null) ...[
                  const SizedBox(width: 12),
                  const Icon(Icons.table_restaurant_outlined, size: 14, color: AppColors.textSecondary),
                  const SizedBox(width: 4),
                  Text('T-${order.tableNo}',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                ],
                const Spacer(),
                Text(AppFmt.money(order.total, decimals: true),
                    style: const TextStyle(fontWeight: FontWeight.w800, color: AppColors.primary)),
              ],
            ),
            if (order.status != OrderStatus.collected && order.status != OrderStatus.cancelled) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  if (order.status == OrderStatus.pending) ...[
                    Expanded(
                      child: OutlinedButton.icon(
                        icon: const Icon(Icons.check_circle_outline, size: 18),
                        label: const Text('Mark Ready'),
                        onPressed: () => _markReady(context),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  if (order.status == OrderStatus.ready)
                    Expanded(
                      child: OutlinedButton.icon(
                        icon: const Icon(Icons.done_all_rounded, size: 18),
                        label: const Text('Collected'),
                        onPressed: () => _markCollected(context),
                      ),
                    ),
                  IconButton(
                    icon: const Icon(Icons.print_outlined),
                    tooltip: 'Reprint',
                    onPressed: () async {
                      final auth = context.read<AuthProvider>();
                      if (auth.business != null) {
                        await PrinterService.instance.printToken(order, auth.business!);
                      }
                    },
                  ),
                  if (order.status == OrderStatus.collected)
                    IconButton(
                      icon: const Icon(Icons.description_outlined),
                      tooltip: 'Generate e-invoice (IRN)',
                      onPressed: () async {
                        final auth = context.read<AuthProvider>();
                        if (auth.business == null) return;
                        try {
                          final irn = await ApiService.instance
                              .generateEinvoice(auth.business!.id, order.id);
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text('IRN: ${irn['irn'] ?? 'OK'}')));
                        } catch (e) {
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text(humanizeError(e))));
                        }
                      },
                    ),
                  IconButton(
                    icon: const Icon(Icons.close_rounded, color: AppColors.error),
                    tooltip: 'Cancel',
                    onPressed: () => _cancel(context),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _cancel(BuildContext context) async {
    final reason = TextEditingController();
    final r = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Cancel order?'),
        content: TextField(
          controller: reason,
          decoration: const InputDecoration(hintText: 'Reason (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('No')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Yes, cancel')),
        ],
      ),
    );
    if (r == true && context.mounted) {
      final orders = context.read<OrdersProvider>();
      // Cancel every KOT in the bill so the bill doesn't get stuck in
      // a partially-cancelled state.
      for (final id in _kotIdsToUpdate(OrderStatus.cancelled)) {
        await orders.updateStatus(
          id,
          OrderStatus.cancelled,
          reason: reason.text.trim().isEmpty ? null : reason.text.trim(),
        );
      }
      await orders.refresh();
    }
  }

  IconData _sourceIcon(OrderSource s) {
    switch (s) {
      case OrderSource.dineIn: return Icons.table_restaurant_outlined;
      case OrderSource.takeaway: return Icons.takeout_dining_outlined;
      case OrderSource.zomato: return Icons.delivery_dining_outlined;
      case OrderSource.swiggy: return Icons.motorcycle_outlined;
      case OrderSource.other: return Icons.receipt_long_outlined;
    }
  }

  // FF-249 helpers ─────────────────────────────────────────────────────
  bool _isOnlineChannel(OrderSource s) =>
      s == OrderSource.zomato || s == OrderSource.swiggy;

  Widget _channelRibbon(OrderSource s) {
    final meta = switch (s) {
      OrderSource.zomato => ('ZOMATO', const Color(0xFFE23744)),
      OrderSource.swiggy => ('SWIGGY', const Color(0xFFFC8019)),
      _ => ('ONLINE', AppColors.textSecondary),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: meta.$2,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.delivery_dining, size: 12, color: Colors.white),
        const SizedBox(width: 4),
        Text(meta.$1,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 10,
              fontWeight: FontWeight.w900,
              letterSpacing: 0.5,
            )),
      ]),
    );
  }
}
