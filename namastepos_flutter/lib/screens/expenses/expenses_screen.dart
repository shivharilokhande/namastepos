// NamastePOS - Expenses list

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/expense.dart';
import '../../providers/expenses_provider.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import 'add_expense_screen.dart';

class ExpensesScreen extends StatelessWidget {
  const ExpensesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.watch<ExpensesProvider>();
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Expenses'),
      ),
      bottomNavigationBar: const HomeBottomNav(),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('New expense'),
        onPressed: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const AddExpenseScreen())),
      ),
      body: RefreshIndicator(
        onRefresh: () => p.refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.divider),
              ),
              child: Row(
                children: [
                  const Icon(Icons.savings_outlined, color: AppColors.warning),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: const [
                        Text("Today's expenses",
                            style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                      ],
                    ),
                  ),
                  Text(
                    AppFmt.money(p.todayTotal, decimals: true),
                    style: const TextStyle(
                      fontSize: 20, fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (p.expenses.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 32),
                child: Center(
                  child: Text('No expenses yet.',
                      style: TextStyle(color: AppColors.textSecondary)),
                ),
              )
            else
              ...p.expenses.map((e) => _ExpenseTile(expense: e)),
            const SizedBox(height: 100),
          ],
        ),
      ),
    );
  }
}

class _ExpenseTile extends StatelessWidget {
  final Expense expense;
  const _ExpenseTile({required this.expense});

  IconData _iconFor(ExpenseCategory c) {
    switch (c) {
      case ExpenseCategory.ingredients: return Icons.kitchen_outlined;
      case ExpenseCategory.fuel: return Icons.local_gas_station_outlined;
      case ExpenseCategory.labor: return Icons.people_outline;
      case ExpenseCategory.rent: return Icons.home_outlined;
      case ExpenseCategory.utilities: return Icons.bolt_outlined;
      case ExpenseCategory.packaging: return Icons.inventory_outlined;
      case ExpenseCategory.marketing: return Icons.campaign_outlined;
      case ExpenseCategory.maintenance: return Icons.build_outlined;
      // System-generated categories (2026-08-23) — added to enum but the
      // icon switch wasn't updated, which broke the release build.
      case ExpenseCategory.wastage: return Icons.delete_outline;
      case ExpenseCategory.refundCogs: return Icons.assignment_return_outlined;
      // Founder bug #4 (2026-08-25): restaurant-specific categories.
      // Exhaustive switch — every new enum value MUST get a case here.
      case ExpenseCategory.chef_salary: return Icons.restaurant_outlined;
      case ExpenseCategory.helper_salary: return Icons.support_agent_outlined;
      case ExpenseCategory.staff_salary: return Icons.badge_outlined;
      case ExpenseCategory.gas: return Icons.propane_tank_outlined;
      case ExpenseCategory.electricity: return Icons.electric_bolt_outlined;
      case ExpenseCategory.water: return Icons.water_drop_outlined;
      case ExpenseCategory.transport: return Icons.local_shipping_outlined;
      case ExpenseCategory.equipment: return Icons.blender_outlined;
      case ExpenseCategory.cleaning: return Icons.cleaning_services_outlined;
      case ExpenseCategory.license_fees: return Icons.receipt_long_outlined;
      case ExpenseCategory.other: return Icons.more_horiz_rounded;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
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
              color: AppColors.warning.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(_iconFor(expense.category), color: AppColors.warning),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(expense.category.label,
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                if (expense.description != null && expense.description!.isNotEmpty)
                  Text(expense.description!,
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                Text(AppFmt.date(expense.date),
                    style: const TextStyle(color: AppColors.textHint, fontSize: 11)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                AppFmt.money(expense.amount, decimals: true),
                style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.textPrimary),
              ),
              InkWell(
                onTap: () => context.read<ExpensesProvider>().delete(expense.id),
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child: Icon(Icons.delete_outline, size: 18, color: AppColors.textHint),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
