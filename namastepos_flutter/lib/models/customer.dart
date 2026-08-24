// NamastePOS - Customer (CRM record + loyalty points)

class Customer {
  final String id;
  final String phone;
  final String? name;
  final String? email;
  final String tier;
  final int pointsBalance;
  final int lifetimePoints;
  final double totalSpent;
  final int visitCount;

  Customer({
    required this.id,
    required this.phone,
    this.name,
    this.email,
    this.tier = 'bronze',
    this.pointsBalance = 0,
    this.lifetimePoints = 0,
    this.totalSpent = 0,
    this.visitCount = 0,
  });

  factory Customer.fromMap(Map<String, dynamic> m) => Customer(
        id: m['id'] as String,
        phone: m['phone'] as String,
        name: m['name'] as String?,
        email: m['email'] as String?,
        tier: m['tier'] as String? ?? 'bronze',
        pointsBalance: (m['pointsBalance'] as num?)?.toInt() ?? 0,
        lifetimePoints: (m['lifetimePoints'] as num?)?.toInt() ?? 0,
        totalSpent: (m['totalSpent'] as num?)?.toDouble() ?? 0,
        visitCount: (m['visitCount'] as num?)?.toInt() ?? 0,
      );
}

class LoyaltySettingsLite {
  final bool isActive;
  final int earnRatePaise;
  final int redemptionValuePaise;
  final int minRedemptionPoints;
  final int maxRedemptionPct;

  LoyaltySettingsLite({
    required this.isActive,
    required this.earnRatePaise,
    required this.redemptionValuePaise,
    required this.minRedemptionPoints,
    required this.maxRedemptionPct,
  });

  // Hardcode-audit fix (2026-08-24): redemptionValuePaise no longer
  // invents a ₹1/point rate when the backend omits it — 0 disables
  // redemption (maxRedeemable fails closed) instead of discounting real
  // money at a made-up rate. Other fields keep conservative defaults.
  factory LoyaltySettingsLite.fromMap(Map<String, dynamic> m) => LoyaltySettingsLite(
        isActive: m['isActive'] == true,
        earnRatePaise: (m['earnRatePaise'] as num?)?.toInt() ?? 1000,
        redemptionValuePaise: (m['redemptionValuePaise'] as num?)?.toInt() ?? 0,
        minRedemptionPoints: (m['minRedemptionPoints'] as num?)?.toInt() ?? 50,
        maxRedemptionPct: (m['maxRedemptionPct'] as num?)?.toInt() ?? 30,
      );

  /// How many points can this customer use right now?
  int maxRedeemable(int balance, double billInr) {
    // redemptionValuePaise == 0 ⇒ backend didn't send a rate ⇒ redemption off.
    if (!isActive || redemptionValuePaise <= 0 || balance < minRedemptionPoints) return 0;
    final billPaise = (billInr * 100).round();
    final maxValuePaise = (billPaise * maxRedemptionPct / 100).floor();
    final maxByValue = (maxValuePaise / redemptionValuePaise).floor();
    return balance < maxByValue ? balance : maxByValue;
  }

  /// Compute points earned for a given INR amount
  int pointsFor(double amountInr) {
    if (!isActive) return 0;
    return ((amountInr * 100) / earnRatePaise).floor();
  }
}
