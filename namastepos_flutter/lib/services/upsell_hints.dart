// NamastePOS mobile — the server's upgrade labels, remembered.
//
// WHY THIS EXISTS
// The app must never work out its own "next plan up". The live ladder is
// starter -> pro (Growth Rs 299) -> pro_plan (Pro Rs 799) -> advanced
// (Rs 999) -> enterprise (Rs 1,999) and the word "pro" means a different
// plan in each of the two namespaces (backend services/planTiers.js). The
// old PlanGate did `tierKind == 'starter' ? 'Pro' : 'Enterprise'`, so a
// Growth, Pro or Advanced tenant hitting a locked feature was told to buy
// Enterprise — skipping every plan in between.
//
// The server names the target for us, in two places, with the same values:
//   * every 402 FEATURE_LOCKED body carries `requiredTierLabel` +
//     `currentTierLabel` (middleware/featureGate.js, requireFeature.js),
//   * /auth/me's plan summary carries `nextTierLabel` + `tierLabel`
//     (services/featureService.planSummary), which is what PlanInfo parses.
//
// This store holds the first of those: ApiService's error interceptor — the
// one place every request failure passes through — drops the label here as
// requests come back, keyed by the feature that was locked. PlanGate prefers
// the per-feature label, falls back to the plan summary's nextTierLabel, and
// where neither is known says "a higher plan". It NEVER names a plan it was
// not told about.
//
// In-memory only and deliberately so: it is a display hint, it must not
// outlive a plan change, and a wrong-but-persisted plan name is exactly the
// bug this file exists to prevent.

class UpsellHints {
  UpsellHints._();
  static final UpsellHints instance = UpsellHints._();

  /// feature key -> the plan label the server said unlocks it.
  final Map<String, String> _byFeature = {};

  /// The most recent required label seen on any 402, for surfaces that know a
  /// feature is locked but not which key (a swallowed save, a list load).
  String? _lastRequired;

  /// The owner's current plan name, as the server labelled it.
  String? _currentLabel;

  String? get lastRequiredLabel => _lastRequired;
  String? get currentLabel => _currentLabel;

  /// Record what the server said. Call with the raw 402 body's fields; empty
  /// or missing values are ignored so a partial body can never blank a label
  /// we already learned.
  void remember({
    String? feature,
    String? requiredTierLabel,
    String? currentTierLabel,
  }) {
    final req = _clean(requiredTierLabel);
    final cur = _clean(currentTierLabel);
    if (cur != null) _currentLabel = cur;
    if (req == null) return;
    _lastRequired = req;
    final key = _clean(feature);
    if (key != null) _byFeature[key] = req;
  }

  /// The server's label for what unlocks [featureKey], or null if unknown.
  String? labelFor(String? featureKey) {
    if (featureKey != null) {
      final hit = _byFeature[featureKey];
      if (hit != null) return hit;
    }
    return _lastRequired;
  }

  /// Wiped on sign-out / account switch: the next tenant's ladder position is
  /// not this one's.
  void clear() {
    _byFeature.clear();
    _lastRequired = null;
    _currentLabel = null;
  }

  static String? _clean(String? v) {
    if (v == null) return null;
    final s = v.trim();
    return s.isEmpty ? null : s;
  }
}
