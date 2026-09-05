// NamastePOS — plan tier + feature list returned by backend /auth/me.

class PlanInfo {
  /// [tierKind] while entitlements are not [loaded] (2026-09-05, review #13).
  /// Used to read 'starter', which told analytics a business was on the free
  /// plan when the truth was "we have not asked yet" — and left a tier-code
  /// default lying around for someone to branch on.
  static const String unknownTierKind = 'unknown';

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

  /// Whether [features] came from the SERVER (a live /auth/me, or the copy of
  /// one cached to secure storage at login) rather than being a placeholder.
  ///
  /// 2026-09-05, fail-closed entitlements. This used to be unrepresentable:
  /// `PlanInfo.starterDefault()` handed out ten real feature keys before any
  /// server answer, so "we have not asked yet" and "the plan grants these"
  /// looked identical to every caller. An unknown entitlement must DENY — a
  /// feature the customer is not paying for appearing while data loads is
  /// exactly the Voice POS bug. Same fail-closed rule as the role getter in
  /// AuthProvider (NP-201).
  final bool loaded;

  PlanInfo({
    required this.tierKind,
    required this.features,
    this.tierLabel,
    this.nextTierLabel,
    this.loaded = false,
  });

  factory PlanInfo.fromMap(Map<String, dynamic> m) => PlanInfo(
        tierKind: m['tierKind'] as String? ?? 'starter',
        tierLabel: _str(m['tierLabel']),
        nextTierLabel: _str(m['nextTierLabel']),
        features: ((m['features'] as List?) ?? const [])
            .map((e) => e.toString())
            .toSet(),
        // A payload the server produced. Even an EMPTY feature list is an
        // answer — "this plan grants nothing" — and must be honoured as one.
        loaded: true,
      );

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  /// Convenience — true if the active plan includes [featureKey].
  ///
  /// FAIL-CLOSED: false whenever the entitlements are not [loaded], so a
  /// caller that reaches for a key before /auth/me has answered (or after a
  /// fetch that failed) gets a denial, never a grant.
  bool has(String featureKey) => loaded && features.contains(featureKey);

  /// "We do not know what this business is entitled to." Everything denied.
  ///
  /// Used before the first server answer and after sign-out. It used to be
  /// `PlanInfo.starterDefault()`, which pre-granted the ten starter keys —
  /// a guess dressed up as an answer. There is no such thing as a safe
  /// default entitlement; the real plan arrives from /auth/me a moment later
  /// (and from secure storage instantly on any device that has logged in
  /// before), so the deny window is a frame, not a session.
  factory PlanInfo.unknown() => PlanInfo(
        tierKind: unknownTierKind,
        features: const <String>{},
      );

  /// True once the server has told us which kind this business is on.
  bool get tierKnown => loaded && tierKind != unknownTierKind;

  Map<String, dynamic> toMap() => {
        'tierKind': tierKind,
        if (tierLabel != null) 'tierLabel': tierLabel,
        if (nextTierLabel != null) 'nextTierLabel': nextTierLabel,
        'features': features.toList(),
      };
}
