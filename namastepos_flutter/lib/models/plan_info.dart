// NamastePOS — plan tier + feature list returned by backend /auth/me.

class PlanInfo {
  final String tierKind;          // 'starter' | 'pro' | 'enterprise'
  final Set<String> features;     // active feature_keys

  PlanInfo({required this.tierKind, required this.features});

  factory PlanInfo.fromMap(Map<String, dynamic> m) => PlanInfo(
        tierKind: m['tierKind'] as String? ?? 'starter',
        features: ((m['features'] as List?) ?? const [])
            .map((e) => e.toString())
            .toSet(),
      );

  /// Convenience — true if the active plan includes [featureKey].
  bool has(String featureKey) => features.contains(featureKey);

  /// Default "everything locked" plan when the backend hasn't responded yet.
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
        'features': features.toList(),
      };
}
