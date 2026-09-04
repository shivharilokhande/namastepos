// NamastePOS - Subscription model (mirrors backend `subscriptions` table)

class Plan {
  final String id;
  final String tier;        // free | basic | pro
  final String name;
  final double priceInr;
  /// Yearly list price, when the plan offers one. Existing server field
  /// (serializePlan → priceYearlyInr); parsed since 2026-09-04 so
  /// `upgrade_paid.amount_inr` reports what the owner actually paid on a
  /// yearly cadence instead of the monthly figure.
  final double? priceYearlyInr;
  final Map<String, int> limits;
  final Map<String, dynamic> features;

  Plan({
    required this.id,
    required this.tier,
    required this.name,
    required this.priceInr,
    this.priceYearlyInr,
    required this.limits,
    required this.features,
  });

  bool get isFree => tier == 'free';

  factory Plan.fromMap(Map<String, dynamic> m) {
    // Tolerant coercion (2026-08-23): backend has historically sent
    // limits as ints OR numeric strings — `(v as num)` crashed the
    // whole subscription parse on a string. Unknown → -1 (unlimited).
    int toIntSafe(dynamic v) =>
        v is num ? v.toInt() : int.tryParse(v?.toString() ?? '') ?? -1;
    final lim = m['limits'] as Map<String, dynamic>? ?? {};
    return Plan(
      id: m['id'] as String? ?? '',
      tier: m['tier'] as String? ?? 'free',
      name: m['name'] as String? ?? 'Free',
      priceInr: (m['priceInr'] as num?)?.toDouble() ?? 0,
      priceYearlyInr: (m['priceYearlyInr'] as num?)?.toDouble(),
      limits: lim.map((k, v) => MapEntry(k, toIntSafe(v))),
      features: m['features'] as Map<String, dynamic>? ?? {},
    );
  }
}

class Subscription {
  final String id;
  final String status;       // trialing | active | past_due | paused | cancelled
  final DateTime? trialEndsAt;
  final DateTime currentPeriodEnd;
  final bool cancelAtPeriodEnd;
  /// 'monthly' | 'yearly'. Existing server field (serializeSubscription →
  /// billingPeriod, which is where the cadence lives since FF-402c); parsed
  /// since 2026-09-04 for `upgrade_paid.billing_cycle`.
  final String billingPeriod;
  final Plan? plan;

  Subscription({
    required this.id,
    required this.status,
    this.trialEndsAt,
    required this.currentPeriodEnd,
    this.cancelAtPeriodEnd = false,
    this.billingPeriod = 'monthly',
    this.plan,
  });

  bool get isTrialing => status == 'trialing';
  bool get isActive => status == 'active' || status == 'trialing';
  bool get isPaused => status == 'paused' || status == 'past_due';
  int? get daysLeft {
    if (currentPeriodEnd.isBefore(DateTime.now())) return 0;
    return currentPeriodEnd.difference(DateTime.now()).inDays;
  }

  /// Trial countdown for the banner. Returns null if not trialing or no
  /// trial_ends_at on file; 0 if the trial already ran out (use [trialExpired]
  /// to decide whether to gate the app); positive int while the trial is
  /// still running. Always rounds UP so "expires in 12h" still shows "1 day".
  int? get trialDaysLeft {
    if (!isTrialing || trialEndsAt == null) return null;
    final diff = trialEndsAt!.difference(DateTime.now());
    if (diff.isNegative) return 0;
    return diff.inHours ~/ 24 + (diff.inHours % 24 == 0 ? 0 : 1);
  }

  /// True iff the trial deadline has passed and the user hasn't upgraded.
  /// Backend status may still read 'trialing' until the cron sweep catches
  /// up, so we do our own clock check rather than trust the server label.
  bool get trialExpired =>
      isTrialing &&
      trialEndsAt != null &&
      trialEndsAt!.isBefore(DateTime.now());

  factory Subscription.fromActive(Map<String, dynamic> m) => Subscription.fromMap(m);

  factory Subscription.fromMap(Map<String, dynamic> m) => Subscription(
        id: m['id'] as String? ?? '',
        status: m['status'] as String? ?? 'trialing',
        trialEndsAt: m['trialEndsAt'] != null
            ? DateTime.tryParse(m['trialEndsAt'].toString())
            : null,
        // Hardcode-audit fix (2026-08-24): fail CLOSED. A missing or
        // malformed currentPeriodEnd used to silently grant 14 days of
        // access; entitlement now treats it as already expired.
        currentPeriodEnd: DateTime.tryParse(m['currentPeriodEnd']?.toString() ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
        cancelAtPeriodEnd: m['cancelAtPeriodEnd'] == true,
        billingPeriod: m['billingPeriod'] as String? ?? 'monthly',
        plan: m['plan'] != null
            ? Plan.fromMap(m['plan'] as Map<String, dynamic>)
            : null,
      );
}

class AddonActivation {
  final String slug;
  final String name;
  final String? tagline;
  final String? icon;
  final String? category;
  final String status;
  final DateTime currentPeriodEnd;
  final bool cancelAtPeriodEnd;

  AddonActivation({
    required this.slug, required this.name, this.tagline, this.icon,
    this.category, required this.status, required this.currentPeriodEnd,
    this.cancelAtPeriodEnd = false,
  });

  bool get isActive => status == 'active' || status == 'trialing';

  factory AddonActivation.fromMap(Map<String, dynamic> m) {
    final addon = (m['addon'] as Map<String, dynamic>?) ?? const {};
    return AddonActivation(
      slug: addon['slug'] as String? ?? '',
      name: addon['name'] as String? ?? '',
      tagline: addon['tagline'] as String?,
      icon: addon['icon'] as String?,
      category: addon['category'] as String?,
      status: m['status'] as String? ?? 'cancelled',
      currentPeriodEnd: DateTime.tryParse(m['currentPeriodEnd']?.toString() ?? '') ??
          DateTime.now(),
      cancelAtPeriodEnd: m['cancelAtPeriodEnd'] == true,
    );
  }
}
