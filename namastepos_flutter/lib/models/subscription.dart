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

  factory Plan.fromMap(Map<String, dynamic> m) {
    // Tolerant coercion (2026-08-23): backend has historically sent
    // limits as ints OR numeric strings — `(v as num)` crashed the
    // whole subscription parse on a string. Unknown → -1 (unlimited).
    int toIntSafe(dynamic v) =>
        v is num ? v.toInt() : int.tryParse(v?.toString() ?? '') ?? -1;
    // 2026-09-06: `.cast` rather than `as Map<String, dynamic>` — a nested map
    // that is not exactly that type (a Map<dynamic,dynamic> from a cache or a
    // test) used to crash the whole subscription parse.
    final lim = (m['limits'] as Map?)?.cast<String, dynamic>() ?? {};
    return Plan(
      id: m['id']?.toString() ?? '',
      tier: m['tier']?.toString() ?? 'free',
      name: m['name']?.toString() ?? 'Free',
      priceInr: (m['priceInr'] as num?)?.toDouble() ?? 0,
      priceYearlyInr: (m['priceYearlyInr'] as num?)?.toDouble(),
      limits: lim.map((k, v) => MapEntry(k, toIntSafe(v))),
      features: (m['features'] as Map?)?.cast<String, dynamic>() ?? {},
    );
  }
}

/// A downgrade scheduled for the end of the paid period (CONTRACTS round 2 §6,
/// `subscription.pendingPlan`). The server sends the serialised target plan;
/// `effectiveAt` is its own field when present, else the caller falls back to
/// `currentPeriodEnd` (which is when the switch happens).
class PendingPlan {
  final String? code;
  final String name;
  final DateTime? effectiveAt;
  const PendingPlan({this.code, required this.name, this.effectiveAt});

  static PendingPlan? fromMap(Object? raw) {
    if (raw is! Map) return null;
    final m = raw.cast<String, dynamic>();
    final name = (m['name'] ?? m['code'] ?? m['tier'])?.toString();
    if (name == null || name.isEmpty) return null;
    return PendingPlan(
      code: (m['code'] ?? m['tier'])?.toString(),
      name: name,
      effectiveAt: m['effectiveAt'] != null
          ? DateTime.tryParse(m['effectiveAt'].toString())
          : null,
    );
  }
}

/// Admin suspension block (`subscription.suspension`). The tenant cannot lift
/// it from the app — Billing shows the message and hides every upgrade CTA.
class SuspensionInfo {
  final DateTime? since;
  final String message;
  const SuspensionInfo({this.since, required this.message});

  static const defaultMessage = 'Account suspended — contact support.';

  static SuspensionInfo? fromMap(Object? raw) {
    if (raw is! Map) return null;
    final m = raw.cast<String, dynamic>();
    if (m['suspended'] == false) return null;
    final sinceRaw = m['since'] ?? m['suspendedAt'];
    return SuspensionInfo(
      since: sinceRaw != null ? DateTime.tryParse(sinceRaw.toString()) : null,
      message: (m['message']?.toString().trim().isNotEmpty ?? false)
          ? m['message'].toString().trim()
          : defaultMessage,
    );
  }
}

class Subscription {
  final String id;
  /// trialing | active | past_due | paused | cancelled | suspended — or
  /// anything newer the server invents. Kept as a raw string on purpose: an
  /// unknown status must never throw (round 2 MOB #2); every getter below is a
  /// plain comparison and unknown values simply read as "not that".
  final String status;
  final DateTime? trialEndsAt;
  final DateTime currentPeriodEnd;
  final bool cancelAtPeriodEnd;
  /// 'monthly' | 'yearly'. Existing server field (serializeSubscription →
  /// billingPeriod, which is where the cadence lives since FF-402c); parsed
  /// since 2026-09-04 for `upgrade_paid.billing_cycle`.
  final String billingPeriod;
  final Plan? plan;
  /// Scheduled downgrade ("Moves to Starter on 2026-10-01"), else null.
  final PendingPlan? pendingPlan;
  /// True while a resume/restore checkout has been opened and the row flips
  /// back to full service only when its first charge lands.
  final bool reactivationPending;
  /// Present iff the account is admin-suspended.
  final SuspensionInfo? suspension;

  Subscription({
    required this.id,
    required this.status,
    this.trialEndsAt,
    required this.currentPeriodEnd,
    this.cancelAtPeriodEnd = false,
    this.billingPeriod = 'monthly',
    this.plan,
    this.pendingPlan,
    this.reactivationPending = false,
    this.suspension,
  });

  bool get isTrialing => status == 'trialing';
  bool get isActive => status == 'active' || status == 'trialing';
  bool get isPaused => status == 'paused' || status == 'past_due';
  bool get isSuspended => status == 'suspended' || suspension != null;

  /// When a scheduled downgrade takes effect — the server's `effectiveAt` if
  /// it sent one, else the end of the current paid period.
  DateTime? get pendingPlanEffectiveAt =>
      pendingPlan == null ? null : (pendingPlan!.effectiveAt ?? currentPeriodEnd);

  /// Whether POST /billing/resume is worth offering: a pause, or an undo of
  /// cancel-at-period-end on a live row. Never on a suspended account (403),
  /// never while a reactivation charge is already pending.
  bool get canOfferResume =>
      !isSuspended &&
      !reactivationPending &&
      (status == 'paused' || (status == 'active' && cancelAtPeriodEnd));
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
        plan: m['plan'] is Map
            ? Plan.fromMap((m['plan'] as Map).cast<String, dynamic>())
            : null,
        pendingPlan: PendingPlan.fromMap(m['pendingPlan']),
        reactivationPending: m['reactivationPending'] == true,
        suspension: SuspensionInfo.fromMap(m['suspension']) ??
            // Older serialiser: status alone says it. Build the block so the
            // UI has one thing to read.
            (m['status'] == 'suspended'
                ? SuspensionInfo(
                    since: m['suspendedAt'] != null
                        ? DateTime.tryParse(m['suspendedAt'].toString())
                        : null,
                    message: SuspensionInfo.defaultMessage)
                : null),
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
