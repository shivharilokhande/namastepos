// NamastePOS - Expenses state provider

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../models/expense.dart';
import '../services/repositories.dart';
import '../utils/formatters.dart';

class ExpensesProvider extends ChangeNotifier {
  final List<Expense> _expenses = [];
  bool _loading = false;
  String? _businessId;

  List<Expense> get expenses => List.unmodifiable(_expenses);
  bool get loading => _loading;

  // Fix (2026-08-23, founder screenshot: "Today's expenses ₹0.00" while
  // the ₹12 wastage entry sat right below it): backend DATEs serialise
  // as previous-day-18:30Z, so raw year/month/day comparison missed
  // them. Bucket by IST day instead.
  double get todayTotal => _expenses
      .where((e) => AppFmt.isISTToday(e.date))
      .fold<double>(0, (s, e) => s + e.amount);

  Map<ExpenseCategory, double> get byCategoryToday {
    final m = <ExpenseCategory, double>{};
    for (final e in _expenses) {
      if (AppFmt.isISTToday(e.date)) {
        m[e.category] = (m[e.category] ?? 0) + e.amount;
      }
    }
    return m;
  }

  Future<void> load(String businessId, {DateTime? start, DateTime? end}) async {
    _businessId = businessId;
    _loading = true; notifyListeners();
    final list = await ExpenseRepo.instance.list(
      businessId,
      start: start ?? DateTime.now().subtract(const Duration(days: 30)),
      end: end ?? DateTime.now(),
    );
    _expenses
      ..clear()
      ..addAll(list);
    _loading = false; notifyListeners();
  }

  Future<Expense> add({
    required String businessId,
    required ExpenseCategory category,
    required double amount,
    String? description,
    DateTime? date,
  }) async {
    final e = Expense(
      id: const Uuid().v4(),
      businessId: businessId,
      category: category,
      amount: amount,
      description: description,
      date: date ?? DateTime.now(),
      createdAt: DateTime.now(),
    );
    await ExpenseRepo.instance.create(e);
    _expenses.insert(0, e);
    notifyListeners();
    return e;
  }

  Future<void> delete(String id) async {
    await ExpenseRepo.instance.delete(id);
    _expenses.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  Future<void> refresh() async {
    if (_businessId != null) await load(_businessId!);
  }
}
