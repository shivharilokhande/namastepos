// NamastePOS - Inventory transaction log (every stock movement)

enum InventoryReason { purchase, sale, waste, adjustment, returned, transfer }

InventoryReason inventoryReasonFromString(String? s) {
  return InventoryReason.values.firstWhere(
    (e) => e.name == s,
    orElse: () => InventoryReason.adjustment,
  );
}

class InventoryTransaction {
  final String id;
  final String businessId;
  final String menuItemId;
  final double qtyChange;    // +ve = stock in, -ve = stock out
  final double balanceAfter;
  final InventoryReason reason;
  final String? orderId;     // when reason == sale
  final String? note;
  final DateTime createdAt;

  const InventoryTransaction({
    required this.id,
    required this.businessId,
    required this.menuItemId,
    required this.qtyChange,
    required this.balanceAfter,
    required this.reason,
    this.orderId,
    this.note,
    required this.createdAt,
  });

  factory InventoryTransaction.fromMap(Map<String, dynamic> m) =>
      InventoryTransaction(
        id: m['id'] as String,
        businessId: m['businessId'] as String? ?? '',
        menuItemId: m['menuItemId'] as String? ?? '',
        qtyChange: (m['qtyChange'] as num?)?.toDouble() ?? 0,
        balanceAfter: (m['balanceAfter'] as num?)?.toDouble() ?? 0,
        reason: inventoryReasonFromString(m['reason'] as String?),
        orderId: m['orderId'] as String?,
        note: m['note'] as String?,
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'businessId': businessId,
        'menuItemId': menuItemId,
        'qtyChange': qtyChange,
        'balanceAfter': balanceAfter,
        'reason': reason.name,
        'orderId': orderId,
        'note': note,
        'createdAt': createdAt.toIso8601String(),
      };
}
