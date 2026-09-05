// NamastePOS - Reports (Daily / Monthly) with charts

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/order.dart';
import '../../models/expense.dart';
import '../../providers/auth_provider.dart';
import '../../providers/expenses_provider.dart';
import '../../providers/orders_provider.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/kpi_card.dart';
import 'income_statement_screen.dart';
import 'monthly_report.dart';
import 'register_reports_screen.dart';
import 'tip_report_screen.dart';
import '../../widgets/home_bottom_nav.dart' show homeTabIndex;

class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key});

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  DateTime _date = DateTime.now();

  Future<void> _pickDate() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (d != null) setState(() => _date = d);
  }

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>();
    final expenses = context.watch<ExpensesProvider>();
    // 2026-09-05 (review #12): the KPI drill-downs are staff-permission
    // gated server-side (`income_register`, `pnl_statement`) — a cashier
    // tapping Profit got a 403 error page. Mirror the drawer's `_can` checks:
    // no permission → the card stays informative but does not navigate.
    final auth = context.watch<AuthProvider>();
    final canIncomeRegister = auth.canDo('income_register');
    final canExpenseRegister = auth.canDo('expense_register');
    final canPnl = auth.canDo('pnl_statement');

    // FB-04 (2026-09-01): order.createdAt is parsed from a Z-suffixed ISO string
    // → a UTC DateTime. Bucket on the LOCAL (IST) calendar day, else a 00:30 IST
    // order (19:00 UTC prior day) is misattributed to yesterday's takings.
    final dayOrders = orders.orders.where((o) {
      final d = o.createdAt.toLocal();
      return d.year == _date.year &&
          d.month == _date.month &&
          d.day == _date.day &&
          o.status != OrderStatus.cancelled;
    }).toList();

    final revenueBySource = <OrderSource, double>{};
    for (final o in dayOrders) {
      revenueBySource[o.source] = (revenueBySource[o.source] ?? 0) + o.total;
    }
    final revenue = dayOrders.fold<double>(0, (s, o) => s + o.total);

    final dayExpenses = expenses.expenses.where((e) =>
        e.date.year == _date.year && e.date.month == _date.month && e.date.day == _date.day).toList();
    final expensesByCat = <ExpenseCategory, double>{};
    for (final e in dayExpenses) {
      expensesByCat[e.category] = (expensesByCat[e.category] ?? 0) + e.amount;
    }
    final expensesTotal = dayExpenses.fold<double>(0, (s, e) => s + e.amount);
    final profit = revenue - expensesTotal;

    // Top items by qty
    final itemQty = <String, int>{};
    final itemRevenue = <String, double>{};
    for (final o in dayOrders) {
      for (final it in o.items) {
        itemQty[it.name] = (itemQty[it.name] ?? 0) + it.qty.toInt();
        itemRevenue[it.name] = (itemRevenue[it.name] ?? 0) + it.lineTotal;
      }
    }
    final top = itemQty.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    final topItems = top.take(5).toList();

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Reports'),
        actions: [
          // FF-903-c mobile — quick access to per-server tips.
          IconButton(
            tooltip: 'Tips by server',
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const TipReportScreen())),
            icon: const Icon(Icons.currency_rupee_rounded),
          ),
          TextButton.icon(
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const MonthlyReportScreen())),
            icon: const Icon(Icons.calendar_month_rounded),
            label: const Text('Monthly'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Date picker
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.divider),
            ),
            child: Row(
              children: [
                const Icon(Icons.calendar_today_rounded, color: AppColors.primary, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(AppFmt.date(_date),
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
                TextButton(onPressed: _pickDate, child: const Text('Change')),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // KPI cards
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            // 1.5 was tight — KPI cards overflowed by ~5px. Matches the
            // Dashboard ratio (see home/dashboard_screen.dart).
            childAspectRatio: 1.35,
            children: [
              // Each KPI card drills into the matching detail report.
              // Revenue → income register (transaction-level).
              // Expenses → expense register.
              // Profit → income statement / P&L breakdown.
              // Orders → the existing Orders screen (list of bills).
              KpiCard(
                label: 'Revenue', value: AppFmt.money(revenue),
                icon: Icons.trending_up_rounded, color: AppColors.success,
                onTap: !canIncomeRegister ? null : () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => RegisterReportsScreen.income(),
                )),
              ),
              KpiCard(
                label: 'Expenses', value: AppFmt.money(expensesTotal),
                icon: Icons.receipt_rounded, color: AppColors.warning,
                onTap: !canExpenseRegister ? null : () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => RegisterReportsScreen.expense(),
                )),
              ),
              KpiCard(
                label: 'Profit', value: AppFmt.money(profit),
                icon: Icons.account_balance_wallet_rounded,
                color: profit >= 0 ? AppColors.success : AppColors.error,
                onTap: !canPnl ? null : () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => const IncomeStatementScreen(),
                )),
              ),
              KpiCard(
                label: 'Orders', value: dayOrders.length.toString(),
                icon: Icons.receipt_long_rounded, color: AppColors.info,
                // Bug fix (2026-08-22): was Navigator.push(OrdersScreen)
                // which created a second OrdersScreen route above
                // HomeScreen — the bottom nav vanished because the
                // pushed OrdersScreen has no HomeBottomNav (it's tab
                // content). Now we switch to the Orders tab in place.
                onTap: () => homeTabIndex.value = 2,
              ),
            ],
          ),

          const SizedBox(height: 16),

          // Revenue by source pie
          if (revenue > 0)
            _chartCard(
              title: 'Revenue by source',
              child: SizedBox(
                height: 220,
                child: PieChart(PieChartData(
                  sectionsSpace: 4,
                  centerSpaceRadius: 36,
                  sections: revenueBySource.entries.toList().asMap().entries.map((e) {
                    final color = AppColors.chartPalette[e.key % AppColors.chartPalette.length];
                    final entry = e.value;
                    final pct = (entry.value / revenue) * 100;
                    return PieChartSectionData(
                      value: entry.value,
                      title: '${pct.toStringAsFixed(0)}%',
                      color: color,
                      titleStyle: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700),
                      radius: 70,
                    );
                  }).toList(),
                )),
              ),
              legend: Wrap(
                spacing: 12,
                runSpacing: 4,
                children: revenueBySource.entries.toList().asMap().entries.map((e) {
                  final color = AppColors.chartPalette[e.key % AppColors.chartPalette.length];
                  return Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(width: 10, height: 10, decoration: BoxDecoration(
                        color: color, borderRadius: BorderRadius.circular(2),
                      )),
                      const SizedBox(width: 4),
                      Text('${e.value.key.name}  ${AppFmt.money(e.value.value)}',
                          style: const TextStyle(fontSize: 12)),
                    ],
                  );
                }).toList(),
              ),
            ),

          if (revenue > 0) const SizedBox(height: 16),

          // Expenses bar
          if (expensesTotal > 0)
            _chartCard(
              title: 'Expenses by category',
              child: SizedBox(
                height: 240,
                child: BarChart(BarChartData(
                  alignment: BarChartAlignment.spaceAround,
                  barGroups: expensesByCat.entries.toList().asMap().entries.map((e) {
                    return BarChartGroupData(x: e.key, barRods: [
                      BarChartRodData(
                        toY: e.value.value,
                        color: AppColors.chartPalette[e.key % AppColors.chartPalette.length],
                        width: 18,
                        borderRadius: const BorderRadius.vertical(top: Radius.circular(6)),
                      ),
                    ]);
                  }).toList(),
                  titlesData: FlTitlesData(
                    rightTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    topTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    leftTitles: AxisTitles(
                      sideTitles: SideTitles(showTitles: true, reservedSize: 36),
                    ),
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        getTitlesWidget: (v, meta) {
                          final cats = expensesByCat.keys.toList();
                          if (v.toInt() < 0 || v.toInt() >= cats.length) return const SizedBox();
                          return Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Text(cats[v.toInt()].label.substring(0, 3),
                                style: const TextStyle(fontSize: 10)),
                          );
                        },
                      ),
                    ),
                  ),
                  gridData: FlGridData(show: true, horizontalInterval: 100, drawVerticalLine: false),
                  borderData: FlBorderData(show: false),
                )),
              ),
            ),

          if (expensesTotal > 0) const SizedBox(height: 16),

          // Top items
          _chartCard(
            title: 'Top items',
            child: topItems.isEmpty
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('No sales yet for this date',
                        style: TextStyle(color: AppColors.textSecondary))),
                  )
                : Column(
                    children: topItems.map((t) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          Container(
                            width: 28, height: 28,
                            decoration: BoxDecoration(
                              color: AppColors.primary.withValues(alpha: 0.10),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Center(child: Text('${t.value}',
                                style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800))),
                          ),
                          const SizedBox(width: 10),
                          Expanded(child: Text(t.key,
                              style: const TextStyle(fontWeight: FontWeight.w600))),
                          Text(AppFmt.money(itemRevenue[t.key] ?? 0),
                              style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700)),
                        ],
                      ),
                    )).toList(),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _chartCard({required String title, required Widget child, Widget? legend}) {
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
          const SizedBox(height: 12),
          child,
          if (legend != null) ...[const SizedBox(height: 10), legend],
        ],
      ),
    );
  }
}
