// NamastePOS - Monthly P&L report with export

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/order.dart';
import '../../providers/auth_provider.dart';
import '../../providers/expenses_provider.dart';
import '../../providers/orders_provider.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/kpi_card.dart';
import 'income_statement_screen.dart';
import 'register_reports_screen.dart';

class MonthlyReportScreen extends StatefulWidget {
  const MonthlyReportScreen({super.key});

  @override
  State<MonthlyReportScreen> createState() => _MonthlyReportScreenState();
}

class _MonthlyReportScreenState extends State<MonthlyReportScreen> {
  DateTime _month = DateTime(DateTime.now().year, DateTime.now().month);

  Future<void> _pickMonth() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _month,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
      initialEntryMode: DatePickerEntryMode.calendarOnly,
    );
    if (d != null) setState(() => _month = DateTime(d.year, d.month));
  }

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>().orders;
    final expenses = context.watch<ExpensesProvider>().expenses;
    // 2026-09-05 (review #12): mirror the drawer's staff-permission checks on
    // the drill-downs (see reports_screen.dart).
    final auth = context.watch<AuthProvider>();
    final canIncomeRegister = auth.canDo('income_register');
    final canExpenseRegister = auth.canDo('expense_register');
    final canPnl = auth.canDo('pnl_statement');
    final daysInMonth = DateUtils.getDaysInMonth(_month.year, _month.month);

    final daily = List<double>.filled(daysInMonth, 0);
    final dailyExpense = List<double>.filled(daysInMonth, 0);

    for (final o in orders) {
      // FB-04 (2026-09-01): bucket on the LOCAL (IST) day — createdAt is UTC.
      final d = o.createdAt.toLocal();
      if (d.year == _month.year && d.month == _month.month &&
          o.status != OrderStatus.cancelled) {
        daily[d.day - 1] += o.total;
      }
    }
    for (final e in expenses) {
      if (e.date.year == _month.year && e.date.month == _month.month) {
        dailyExpense[e.date.day - 1] += e.amount;
      }
    }

    final totalRevenue = daily.fold<double>(0, (a, b) => a + b);
    final totalExpense = dailyExpense.fold<double>(0, (a, b) => a + b);
    final profit = totalRevenue - totalExpense;

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Monthly P&L'),
      ),
      bottomNavigationBar: const HomeBottomNav(),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Month picker
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.divider),
            ),
            child: Row(
              children: [
                const Icon(Icons.calendar_month_rounded, color: AppColors.primary, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(DateFormat('MMMM yyyy').format(_month),
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
                TextButton(onPressed: _pickMonth, child: const Text('Change')),
              ],
            ),
          ),
          const SizedBox(height: 12),
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            // KpiCard contents (icon + value + label) need a bit more
            // vertical room — 1.5 was overflowing by ~4-5 pixels on
            // narrow phones. 1.35 gives breathing room without making
            // the cards look stretched.
            childAspectRatio: 1.35,
            children: [
              // Tap-through to the detailed reports. Same destinations
              // as the day-view Reports screen so the user has one
              // mental model across daily / monthly.
              KpiCard(
                label: 'Revenue', value: AppFmt.money(totalRevenue),
                icon: Icons.trending_up_rounded, color: AppColors.success,
                onTap: !canIncomeRegister ? null : () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => RegisterReportsScreen.income(),
                )),
              ),
              KpiCard(
                label: 'Expenses', value: AppFmt.money(totalExpense),
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
                label: 'Margin',
                value: totalRevenue == 0
                    ? '0%' : '${(profit / totalRevenue * 100).toStringAsFixed(0)}%',
                icon: Icons.pie_chart_rounded, color: AppColors.info,
                onTap: !canPnl ? null : () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => const IncomeStatementScreen(),
                )),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.divider),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Daily revenue (₹)',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 12),
                SizedBox(
                  height: 220,
                  child: LineChart(
                    LineChartData(
                      minY: 0,
                      lineBarsData: [
                        LineChartBarData(
                          spots: List.generate(daysInMonth, (i) => FlSpot(i.toDouble() + 1, daily[i])),
                          isCurved: true,
                          color: AppColors.primary,
                          barWidth: 2,
                          dotData: FlDotData(show: false),
                          belowBarData: BarAreaData(
                            show: true,
                            color: AppColors.primary.withValues(alpha: 0.10),
                          ),
                        ),
                      ],
                      titlesData: FlTitlesData(
                        rightTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                        topTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                        bottomTitles: AxisTitles(
                          sideTitles: SideTitles(showTitles: true, interval: 5, reservedSize: 22),
                        ),
                        leftTitles: AxisTitles(
                          sideTitles: SideTitles(showTitles: true, reservedSize: 40),
                        ),
                      ),
                      gridData: FlGridData(drawVerticalLine: false),
                      borderData: FlBorderData(show: false),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
