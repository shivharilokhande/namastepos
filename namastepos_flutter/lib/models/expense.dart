// NamastePOS - Expense model

enum ExpenseCategory {
  ingredients,
  fuel,
  labor,
  rent,
  utilities,
  packaging,
  marketing,
  maintenance,
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
