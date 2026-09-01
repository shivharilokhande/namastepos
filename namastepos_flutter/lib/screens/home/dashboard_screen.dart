// NamastePOS - Dashboard / Home overview

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/menu_item.dart';  // for MenuUnitX.short extension
import '../../models/order.dart';
import '../../providers/auth_provider.dart';
import '../../providers/expenses_provider.dart';
import '../../providers/menu_provider.dart';
import '../../providers/orders_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/kpi_card.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/section_header.dart';
import '../../widgets/subscription_banner.dart';
import '../captain/captain_screen.dart';
import '../expenses/add_expense_screen.dart';
import '../expenses/expenses_screen.dart';
import '../orders/order_detail_screen.dart';
import '../pos/new_order_screen.dart';
import '../reports/income_statement_screen.dart';
import '../reports/monthly_report.dart';
import '../../providers/settings_provider.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final orders = context.watch<OrdersProvider>();
    final expenses = context.watch<ExpensesProvider>();
    final menu = context.watch<MenuProvider>();

    final revenue = orders.todayRevenue;
    final expense = expenses.todayTotal;
    // Bug fix: profit was `revenue - expense` only, ignoring COGS. For an
    // item sold at ₹50 with cost ₹15, the dashboard showed 100% margin.
    // COGS = sum over today's non-cancelled order lines of (qty × menu
    // item's cost_price). If we don't know an item's cost (cost_price is
    // null), it contributes 0 — matches the legacy behaviour for items
    // without a cost set.
    double cogs = 0;
    for (final o in orders.orders) {
      // IST day-bucket (2026-08-23) — same rule as todayRevenue.
      if (!AppFmt.isISTToday(o.createdAt)) continue;
      if (o.status == OrderStatus.cancelled) continue;
      for (final li in o.items) {
        final mi = menu.byId(li.menuItemId);
        if (mi?.costPrice != null) {
          cogs += mi!.costPrice! * li.qty;
        }
      }
    }
    final profit = revenue - cogs - expense;
    final marginPct = revenue == 0 ? 0.0 : (profit / revenue) * 100;
    final pendingOrders = orders.ofStatus(OrderStatus.pending);
    final lowStock = menu.lowStockItems;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: RefreshIndicator(
        onRefresh: () async {
          await Future.wait([
            orders.refresh(),
            expenses.refresh(),
            menu.refresh(),
          ]);
        },
        child: CustomScrollView(
          slivers: [
            SliverAppBar(
              // Compact one-band header — replaced the FlexibleSpaceBar
              // expanded pattern (which left ~50px of empty space between
              // the icons row and the title) with a direct two-line title.
              // Total height ~64px, no padding gap.
              pinned: true,
              backgroundColor: AppColors.surface,
              elevation: 0,
              leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
              titleSpacing: 0,
              toolbarHeight: 64,
              title: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Hello, ${auth.business?.name ?? 'Owner'} 👋',
                    style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  Text(
                    AppFmt.date(DateTime.now()),
                    style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                  ),
                ],
              ),
              actions: [
                IconButton(
                  icon: const Icon(Icons.notifications_none_rounded),
                  onPressed: () {},
                ),
              ],
            ),

            // Subscription banner (only renders when relevant)
            const SliverToBoxAdapter(child: SubscriptionBanner()),

            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverList(
                delegate: SliverChildListDelegate.fixed([
                  // KPI cards
                  GridView.count(
                    crossAxisCount: 2,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                    // 1.5 was tight — icon row + value (22px) + label (12px)
                    // plus paddings exceeded the cell height by ~4.7px and
                    // Flutter painted the "BOTTOM OVERFLOWED" stripe on
                    // every card. 1.35 gives ~15px headroom and looks the
                    // same to the eye.
                    childAspectRatio: 1.35,
                    // Tappable (2026-08-22, founder request): each KPI
                    // opens its detailed report, same destinations the
                    // Reports tab uses. P&L needs the plan feature — we
                    // fall back to the monthly report when locked.
                    children: [
                      KpiCard(
                        label: "Today's Revenue",
                        value: AppFmt.money(revenue),
                        icon: Icons.trending_up_rounded,
                        color: AppColors.success,
                        onTap: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => auth.has('pnl_statement')
                                ? const IncomeStatementScreen(todayDefault: true)
                                : const MonthlyReportScreen())),
                      ),
                      KpiCard(
                        label: 'Expenses',
                        value: AppFmt.money(expense),
                        icon: Icons.receipt_rounded,
                        color: AppColors.warning,
                        onTap: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => const ExpensesScreen())),
                      ),
                      KpiCard(
                        label: 'Profit',
                        value: AppFmt.money(profit),
                        icon: Icons.account_balance_wallet_rounded,
                        color: profit >= 0 ? AppColors.success : AppColors.error,
                        onTap: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => auth.has('pnl_statement')
                                ? const IncomeStatementScreen(todayDefault: true)
                                : const MonthlyReportScreen())),
                      ),
                      KpiCard(
                        label: 'Margin',
                        value: '${marginPct.toStringAsFixed(0)}%',
                        icon: Icons.pie_chart_rounded,
                        color: AppColors.info,
                        onTap: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => auth.has('pnl_statement')
                                ? const IncomeStatementScreen(todayDefault: true)
                                : const MonthlyReportScreen())),
                      ),
                    ],
                  ),

                  const SizedBox(height: 12),

                  // Quick actions
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppColors.divider),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: _quickAction(
                            context,
                            icon: Icons.table_restaurant_rounded,
                            label: 'Tables',
                            color: AppColors.primary,
                            onTap: () {
                              final biz = auth.business;
                              if (biz == null) return;
                              Navigator.push(context, MaterialPageRoute(
                                builder: (_) => CaptainScreen(businessId: biz.id),
                              ));
                            },
                          ),
                        ),
                        Container(width: 1, height: 36, color: AppColors.divider),
                        Expanded(
                          child: _quickAction(
                            context,
                            icon: Icons.add_circle_outline_rounded,
                            label: 'New Order',
                            color: AppColors.secondary,
                            onTap: () => Navigator.push(context,
                                MaterialPageRoute(builder: (_) => const NewOrderScreen())),
                          ),
                        ),
                        Container(width: 1, height: 36, color: AppColors.divider),
                        Expanded(
                          child: _quickAction(
                            context,
                            icon: Icons.money_off_rounded,
                            label: 'Expense',
                            color: AppColors.warning,
                            onTap: () => Navigator.push(context,
                                MaterialPageRoute(builder: (_) => const AddExpenseScreen())),
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 12),

                  // Collections today — where the money actually came from
                  // (2026-09-01, founder). Wallet is prepaid, so it's shown
                  // apart from cash-in-drawer; points are a discount, not cash.
                  const _CollectionsCard(),
                ]),
              ),
            ),

            // Pending orders
            SliverToBoxAdapter(
              child: SectionHeader(
                title: 'Pending orders (${pendingOrders.length})',
                actionLabel: pendingOrders.isEmpty ? null : 'See all',
                onAction: () {},
              ),
            ),
            if (pendingOrders.isEmpty)
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverToBoxAdapter(
                  child: _emptyState(
                    icon: Icons.receipt_long_outlined,
                    text: 'No pending orders. New orders will appear here.',
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, i) {
                      final o = pendingOrders[i];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: _pendingOrderCard(context, o),
                      );
                    },
                    childCount: pendingOrders.length > 5 ? 5 : pendingOrders.length,
                  ),
                ),
              ),

            // Low stock alerts — respects the More → Settings toggle
            // (2026-08-22, founder: unchecking the setting still showed
            // the section on Home).
            if (context.watch<SettingsProvider>().notifyOnLowStock &&
                lowStock.isNotEmpty) ...[
              const SliverToBoxAdapter(
                child: SectionHeader(title: 'Low stock alerts'),
              ),
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, i) {
                      final it = lowStock[i];
                      return Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.warning.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.warning.withValues(alpha: 0.3)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.warning_amber_rounded, color: AppColors.warning),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(it.name,
                                      style: const TextStyle(fontWeight: FontWeight.w600)),
                                  Text(
                                    'Only ${AppFmt.quantity(it.stock)} ${it.unit.short} left (re-order at ${AppFmt.quantity(it.reorderLevel)})',
                                    style: const TextStyle(
                                        color: AppColors.textSecondary, fontSize: 12),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                    childCount: lowStock.length,
                  ),
                ),
              ),
            ],

            const SliverToBoxAdapter(child: SizedBox(height: 30)),
          ],
        ),
      ),
    );
  }

  Widget _quickAction(BuildContext context,
      {required IconData icon, required String label, required Color color, required VoidCallback onTap}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 22),
            ),
            const SizedBox(height: 6),
            Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _pendingOrderCard(BuildContext context, Order o) {
    return InkWell(
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => OrderDetailScreen(orderId: o.id))),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.divider),
        ),
        child: Row(
          children: [
            Container(
              width: 44, height: 44,
              decoration: BoxDecoration(
                color: AppColors.statusPending.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Center(child: Icon(Icons.access_time_rounded, color: AppColors.statusPending)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Order #${o.orderNo}',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text(
                    '${o.items.length} items · ${AppFmt.relative(o.createdAt)}',
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
                  ),
                ],
              ),
            ),
            Text(
              AppFmt.money(o.total),
              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.textPrimary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _emptyState({required IconData icon, required String text}) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        children: [
          Icon(icon, size: 36, color: AppColors.textHint),
          const SizedBox(height: 8),
          Text(text, style: const TextStyle(color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

/// Today's collections, split by tender (cash/upi/card/wallet). Fed by the
/// daily report's accurate `tenders` map — the same numbers the web
/// dashboard's Payments card shows. Wallet is prepaid money spent today, so
/// it's separated from cash-in-drawer; points redeemed are a discount, not a
/// collection. Silent (renders nothing) until data loads or if there's no
/// money in yet, so an empty day doesn't add clutter.
class _CollectionsCard extends StatefulWidget {
  const _CollectionsCard();
  @override
  State<_CollectionsCard> createState() => _CollectionsCardState();
}

class _CollectionsCardState extends State<_CollectionsCard> {
  Map<String, dynamic>? _report;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { if (mounted) setState(() => _loading = false); return; }
    try {
      final r = await ApiService.instance.dailyReport(biz.id, DateTime.now());
      if (mounted) setState(() { _report = r; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false); // best-effort; hide on error
    }
  }

  static const _labels = {
    'cash': 'Cash', 'upi': 'UPI', 'card': 'Card',
    'online': 'Online', 'wallet': 'Wallet (prepaid)',
  };
  static const _icons = {
    'cash': Icons.payments_rounded, 'upi': Icons.qr_code_rounded,
    'card': Icons.credit_card_rounded, 'online': Icons.language_rounded,
    'wallet': Icons.account_balance_wallet_rounded,
  };

  @override
  Widget build(BuildContext context) {
    if (_loading || _report == null) return const SizedBox.shrink();
    final tenders = (_report!['tenders'] as Map?)?.cast<String, dynamic>() ?? const {};
    final entries = tenders.entries
        .where((e) => ((e.value as num?)?.toDouble() ?? 0) > 0)
        .toList()
      ..sort((a, b) => ((b.value as num).toDouble()).compareTo((a.value as num).toDouble()));
    final cashToday = (_report!['cashCollectedToday'] as num?)?.toDouble() ?? 0;
    final walletColl = (_report!['walletCollected'] as num?)?.toDouble() ?? 0;
    final disc = (_report!['discountBreakdown'] as Map?)?.cast<String, dynamic>() ?? const {};
    final pointsVal = (disc['pointsValue'] as num?)?.toDouble() ?? 0;
    if (entries.isEmpty && pointsVal == 0) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.account_balance_rounded, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              const Text('Collections today',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
              const Spacer(),
              Text(AppFmt.money(cashToday + walletColl),
                  style: const TextStyle(fontWeight: FontWeight.w900)),
            ],
          ),
          const SizedBox(height: 8),
          for (final e in entries)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(_icons[e.key] ?? Icons.payments_rounded,
                      size: 15, color: AppColors.textSecondary),
                  const SizedBox(width: 8),
                  Expanded(child: Text(_labels[e.key] ?? e.key,
                      style: const TextStyle(fontSize: 13))),
                  Text(AppFmt.money((e.value as num).toDouble()),
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, fontSize: 13,
                          fontFeatures: [FontFeature.tabularFigures()])),
                ],
              ),
            ),
          const Divider(height: 16),
          _foot('Cash in drawer today (excludes wallet)', cashToday),
          if (walletColl > 0) _foot('Paid from wallet (prepaid earlier)', walletColl),
          if (pointsVal > 0) _foot('Points redeemed (discount, not cash)', pointsVal),
        ],
      ),
    );
  }

  Widget _foot(String label, double amount) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Expanded(child: Text(label,
                style: const TextStyle(fontSize: 11, color: AppColors.textSecondary))),
            Text(AppFmt.money(amount),
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ],
        ),
      );
}
