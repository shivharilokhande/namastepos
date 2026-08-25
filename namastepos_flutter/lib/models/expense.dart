// NamastePOS - Expense model

// New categories (founder bug #4, 2026-08-25) use snake_case identifiers ON
// PURPOSE: repositories.dart sends `category.name` as the API value, and the
// backend/Postgres enum expects snake_case ('chef_salary'). camelCase names
// (like refundCogs) would be rejected by the backend Joi whitelist on create.
// ignore_for_file: constant_identifier_names
enum ExpenseCategory {
  ingredients,
  fuel,
  labor,
  rent,
  utilities,
  packaging,
  marketing,
  maintenance,
  // Founder bug #4 (2026-08-25) — real restaurant expense heads.
  chef_salary,
  helper_salary,
  staff_salary,
  gas,
  electricity,
  water,
  transport,
  equipment,
  cleaning,
  license_fees,
  // System-generated categories (2026-08-23) — created by the backend
  // (wastage log mirror, refunded prepared-food cost). Not user-pickable;
  // see [ExpenseCategoryX.userSelectable].
  wastage,
  refundCogs,
  other,
}

extension ExpenseCategoryX on ExpenseCategory {
  String get label {
    switch (this) {
      case ExpenseCategory.ingredients: return 'Ingredients';
      case ExpenseCategory.fuel: return 'Fuel';
      case ExpenseCategory.labor: return 'Labor';
      case ExpenseCategory.rent: return 'Rent';
      case ExpenseCategory.utilities: return 'Utilities';
      case ExpenseCategory.packaging: return 'Packaging';
      case ExpenseCategory.marketing: return 'Marketing';
      case ExpenseCategory.maintenance: return 'Maintenance';
      case ExpenseCategory.chef_salary: return 'Chef Salary';
      case ExpenseCategory.helper_salary: return 'Helper Salary';
      case ExpenseCategory.staff_salary: return 'Staff Salary';
      case ExpenseCategory.gas: return 'Gas';
      case ExpenseCategory.electricity: return 'Electricity';
      case ExpenseCategory.water: return 'Water';
      case ExpenseCategory.transport: return 'Transport';
      case ExpenseCategory.equipment: return 'Equipment';
      case ExpenseCategory.cleaning: return 'Cleaning';
      case ExpenseCategory.license_fees: return 'License Fees';
      case ExpenseCategory.wastage: return 'Wastage';
      case ExpenseCategory.refundCogs: return 'Refund (food cost)';
      case ExpenseCategory.other: return 'Other';
    }
  }

  /// System categories are written by the backend, never picked by hand.
  bool get userSelectable =>
      this != ExpenseCategory.wastage && this != ExpenseCategory.refundCogs;
}

ExpenseCategory expenseCategoryFromString(String? s) {
  if (s == 'wastage') return ExpenseCategory.wastage;
  if (s == 'refund_cogs') return ExpenseCategory.refundCogs;
  // 2026-08-25: the new categories need no special-casing — their enum
  // identifiers ARE the snake_case wire values (see comment on the enum),
  // so the name-match below round-trips both API and local sqflite rows.
  return ExpenseCategory.values.firstWhere(
    (e) => e.name == s,
    orElse: () => ExpenseCategory.other,
  );
}

class Expense {
  final String id;
  final String businessId;
  final ExpenseCategory category;
  final double amount;
  final String? description;
  final DateTime date;
  final String? receiptUrl;
  final bool synced;
  final DateTime createdAt;

  const Expense({
    required this.id,
    required this.businessId,
    required this.category,
    required this.amount,
    this.description,
    required this.date,
    this.receiptUrl,
    this.synced = false,
    required this.createdAt,
  });

  factory Expense.fromMap(Map<String, dynamic> m) => Expense(
        id: m['id'] as String,
        businessId: m['businessId'] as String? ?? '',
        category: expenseCategoryFromString(m['category'] as String?),
        amount: (m['amount'] as num?)?.toDouble() ?? 0,
        description: m['description'] as String?,
        date: DateTime.tryParse(m['date']?.toString() ?? '') ?? DateTime.now(),
        receiptUrl: m['receiptUrl'] as String?,
        synced: (m['synced'] as int? ?? 0) == 1,
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'businessId': businessId,
        'category': category.name,
        'amount': amount,
        'description': description,
        'date': date.toIso8601String(),
        'receiptUrl': receiptUrl,
        'synced': synced ? 1 : 0,
        'createdAt': createdAt.toIso8601String(),
      };
}
