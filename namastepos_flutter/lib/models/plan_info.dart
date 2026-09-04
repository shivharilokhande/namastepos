// NamastePOS — plan tier + feature list returned by backend /auth/me.

class PlanInfo {
  /// The plan's KIND — its position on the upgrade ladder. The live ladder is
  /// 'starter' | 'pro' | 'pro_plan' | 'advanced' | 'enterprise'
  /// (backend services/planTiers.js, the single source of truth).
  ///
  /// THE TRAP: the kind 'pro' is the **Growth** plan (Rs 299); the plan
  /// actually named **Pro** (Rs 799) is the kind 'pro_plan'. Never map a kind
  /// to a plan NAME in the app, and never derive "the next plan up" here — the
  /// server sends both names in [tierLabel] / [nextTierLabel]. A client that
  /// guesses gets it wrong: this file's old comment claimed the kinds were
  /// 'starter' | 'pro' | 'enterprise', and the upsell built on that told every
  /// Growth / Pro / Advanced tenant to jump to Enterprise (Rs 1,999).
  final String tierKind;

  /// Owner-facing name of the CURRENT plan kind, from the server
  /// ('pro_plan' -> 'Pro'). Null on an older cached summary — show nothing
  /// specific rather than guessing.
  final String? tierLabel;

  /// Owner-facing name of the ONE plan up the ladder, from the server. Null at
  /// the top of the ladder, on a bespoke per-customer plan, or on an older
  /// cached summary — callers must fall back to "a higher plan".
  final String? nextTierLabel;

  final Set<String> features; // active feature_keys

  PlanInfo({
    required this.tierKind,
    required this.features,
    this.tierLabel,
    this.nextTierLabel,
  });

  factory PlanInfo.fromMap(Map<String, dynamic> m) => PlanInfo(
        tierKind: m['tierKind'] as String? ?? 'starter',
        tierLabel: _str(m['tierLabel']),
        nextTierLabel: _str(m['nextTierLabel']),
        features: ((m['features'] as List?) ?? const [])
            .map((e) => e.toString())
            .toSet(),
      );

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  /// Convenience — true if the active plan includes [featureKey].
  bool has(String featureKey) => features.contains(featureKey);

  /// Default "everything locked" plan when the backend hasn't responded yet.
  /// No labels: nothing is known about the ladder until /auth/me lands, so the
  /// UI says "a higher plan" instead of naming one.
  factory PlanInfo.starterDefault() => PlanInfo(
        tierKind: 'starter',
        features: {
          'pos','orders','token_generation','tables_single_floor',
          'menu_basic','reports_basic','expenses','invoice_basic',
          'staff_lite','customers_basic',
        },
      );

  Map<String, dynamic> toMap() => {
        'tierKind': tierKind,
        if (tierLabel != null) 'tierLabel': tierLabel,
        if (nextTierLabel != null) 'nextTierLabel': nextTierLabel,
        'features': features.toList(),
      };
}
