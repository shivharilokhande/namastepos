// NamastePOS mobile — activation-funnel analytics (Firebase Analytics → GA4).
//
// WHY THIS EXISTS
// The web dashboard was instrumented first (namastepos_dashboard/src/lib/
// analytics.ts + activation.ts), but the phone IS the till: most `first_kot`
// and `first_bill` events happen here, so a web-only funnel undercounts
// activation badly. This file is the mobile half of the SAME contract — the
// event names, the property names and their meanings are identical, so the
// two halves join into one funnel in GA4 and only `platform` differs
// ('web' vs 'android'/'ios').
//
// SHAPE
//   [AnalyticsService]  the ONLY thing in the app that talks to Firebase.
//                       Exposes track() / trackOnce() and nothing else that
//                       emits.
//   [Activation]        named helpers ("first bill was just printed") that
//                       know what a NamastePOS milestone means, so screens
//                       and providers never build an event payload
//                       themselves. Mirrors lib/activation.ts on web.
//
// FOUR HARD RULES, in order of importance:
//
//  1. NO PII, EVER. This product ships a DPDP compliance console; leaking a
//     diner's phone number into Google Analytics would make that console a
//     lie. Enforcement is structural, not a code-review promise:
//       - every event has an ALLOW-LIST of property names (_eventProps);
//         anything not on it is dropped before the Firebase call,
//       - values must be String / num / bool — Maps, Lists and everything
//         else are dropped whole, so nobody can pass `order` or `customer`
//         and hope for the best,
//       - a string that looks like an email, an Indian mobile number, a JWT
//         or a GSTIN is dropped even if its key IS allow-listed,
//       - the user id is the business UUID. Never an email, never a phone.
//     There is deliberately no allow-listed key that can hold a person's
//     name, phone, email, address or GSTIN.
//
//  2. NO-OP WHEN UNCONFIGURED, AND NEVER IN TESTS. `_ready` starts false and
//     only [bootstrap] can flip it — and only when Firebase actually
//     initialised on this platform. Absent that, track() returns on its first
//     line: no crash, no network, no console output. bootstrap() is called
//     from main() alone, so `flutter test` (which never runs main) is a
//     no-op by construction; FLUTTER_TEST is also checked explicitly.
//
//  3. MILESTONE-ONCE PER BUSINESS. business_created / menu_ready / first_kot
//     / first_bill / upgrade_paid fire at most once per business id, ever —
//     not once per app launch. State lives in SharedPreferences; see
//     [trackOnce] for where and for the accepted failure modes.
//
//  4. ANALYTICS NEVER BREAKS THE APP. Every public method swallows its own
//     errors. A funnel event is worth less than an order.
//
//  5. CONSENT FIRST, AND OFF BY DEFAULT. This mirrors the web dashboard
//     exactly (namastepos_dashboard/src/lib/analytics.ts + CookieBanner):
//     there, analytics is off until the owner grants `cookies_analytics`, the
//     banner says so ("Analytics and marketing cookies are off by default"),
//     and events raised before a decision are held and dropped on refusal.
//     Mobile now uses the SAME consent key, surfaced on the DPDP privacy
//     screen (Settings > Privacy & data), and nothing is reported until that
//     key is known-granted:
//       - [bootstrap] reads the stored decision from SharedPreferences BEFORE
//         it enables Firebase collection, so a previously-refused (or
//         never-answered) choice means Firebase itself never collects,
//       - [setEnabled] flips it at runtime and persists it, so the toggle
//         takes effect on the spot and survives a restart,
//       - unknown is treated as REFUSED (there is no in-memory hold on
//         mobile; a funnel event is not worth holding against a consent that
//         may never arrive).
//     A build can still turn the whole module off with
//     `--dart-define=ANALYTICS_DISABLED=true`.

import 'dart:convert';
import 'dart:io' show Platform;

import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:shared_preferences/shared_preferences.dart';

// ── Event contract (must stay identical to the web implementation) ─────────

/// The seven funnel events. Names are the wire names — never rename one
/// without changing namastepos_dashboard/src/lib/analytics.ts in the same
/// breath, or the funnel stops joining.
class FunnelEvent {
  static const signup = 'signup';
  static const businessCreated = 'business_created';
  static const menuReady = 'menu_ready';
  static const firstKot = 'first_kot';
  static const firstBill = 'first_bill';
  static const upgradePaid = 'upgrade_paid';
  static const planLimitHit = 'plan_limit_hit';

  static const all = <String>[
    signup, businessCreated, menuReady, firstKot, firstBill, upgradePaid,
    planLimitHit,
  ];
}

/// Stamped on every event. `business_id` doubles as the Firebase user id.
const _globalProps = <String>['business_id', 'plan_tier', 'platform'];

/// The allow-list. A property name absent from this table never reaches
/// Firebase — that is how rule 1 is enforced. Note what is NOT here: no
/// email, phone, customer_name, staff_name, address, gstin, table label or
/// item name. Ids (business, order) are opaque UUIDs and are fine.
const _eventProps = <String, List<String>>{
  FunnelEvent.signup: ['method', 'has_business_name', 'referral_code'],
  FunnelEvent.businessCreated: ['is_new', 'category'],
  FunnelEvent.menuReady: [
    'item_count', 'source', 'minutes_since_signup', 'over_plan_cap',
  ],
  FunnelEvent.firstKot: ['order_id', 'station_count', 'minutes_since_signup'],
  FunnelEvent.firstBill: [
    'order_id', 'amount_inr', 'payment_mode', 'receipt_channel',
    'line_items', 'minutes_since_signup', 'within_24h',
  ],
  FunnelEvent.upgradePaid: [
    'from_tier', 'to_tier', 'amount_inr', 'billing_cycle',
    'days_since_signup', 'blocked_metric',
  ],
  FunnelEvent.planLimitHit: ['metric', 'limit', 'attempted', 'tier'],
};

/// Milestones that must fire at most once per business.
const _onceEvents = <String>[
  FunnelEvent.businessCreated, FunnelEvent.menuReady, FunnelEvent.firstKot,
  FunnelEvent.firstBill, FunnelEvent.upgradePaid,
];

// ── Identity ──────────────────────────────────────────────────────────────

/// What the funnel needs to know about "who is this". Deliberately tiny and
/// deliberately free of anything that identifies a person.
class AnalyticsIdentity {
  /// Business UUID. Opaque — safe to send, and used as the Firebase user id.
  final String? businessId;

  /// Signup instant. Derived from the EXISTING `Business.createdAt` field
  /// (authService.serializeBusiness → businesses.created_at) — self
  /// registration creates the business inline with the account, so business
  /// creation IS signup. No new server field was invented for this.
  final DateTime? signupAt;

  /// `PlanInfo.tierKind` from /auth/me — a tier KIND, one of the live ladder
  /// 'starter' | 'pro' | 'pro_plan' | 'advanced' | 'enterprise' (backend
  /// services/planTiers.js). NOT a plans.tier code: the kind 'pro' is the
  /// Growth plan. Reported as-is; nothing here maps it to a plan name.
  final String? planTier;

  const AnalyticsIdentity({this.businessId, this.signupAt, this.planTier});

  static const empty = AnalyticsIdentity();
}

// ── The emitter ───────────────────────────────────────────────────────────

class AnalyticsService {
  AnalyticsService._();
  static final AnalyticsService instance = AnalyticsService._();

  /// Kill switch for a build: `--dart-define=ANALYTICS_DISABLED=true`.
  static const bool _disabledByDefine =
      bool.fromEnvironment('ANALYTICS_DISABLED', defaultValue: false);

  /// True inside `flutter test`. bootstrap() is only ever called from main()
  /// so tests are already inert; this is the belt to that braces.
  static final bool _isTest = Platform.environment.containsKey('FLUTTER_TEST');

  // Prefs keys. All three are business-AGNOSTIC on purpose: the business id
  // lives in the VALUE, so nothing that clears "keys belonging to business X"
  // on an outlet switch can wipe or cross-contaminate them.
  static const _kMilestones = 'np_funnel_v1';
  static const _kBlocked = 'np_funnel_blocked_v1';
  static const _kTier = 'np_funnel_tier_v1';
  /// The owner's analytics decision, cached locally so it applies at launch
  /// BEFORE any network call. The durable record is the server-side consent
  /// event under the `cookies_analytics` key (the same key the web cookie
  /// banner writes); this is only the local mirror of it.
  static const _kConsent = 'np_consent_cookies_analytics_v1';

  /// The consent key this gate is wired to, shared with the web dashboard and
  /// accepted by the backend (complianceService CONSENT_KEYS).
  static const String consentKey = 'cookies_analytics';

  static const int _maxStringLen = 100;

  FirebaseAnalytics? _fa;
  bool _ready = false;
  /// Tri-state on purpose: `null` = the owner has not answered (or we could
  /// not read the answer), which counts as NOT granted — same default as the
  /// web dashboard, where analytics stays off until `cookies_analytics` is
  /// explicitly granted.
  bool? _consent;
  bool _bootstrapped = false;
  AnalyticsIdentity Function()? _identityProvider;

  /// Cached milestone map, loaded once. Single-flight so two concurrent
  /// trackOnce calls cannot both see an empty map and double-fire.
  Future<Map<String, String>>? _milestonesFuture;

  String? _lastUserId;

  /// Master switch. False ⇒ every emitter here is a silent no-op.
  /// Requires BOTH a working Firebase and a granted `cookies_analytics`.
  bool get enabled => _ready && _consent == true;

  /// The owner's stored decision: true granted, false refused, null not asked.
  /// The privacy screen renders the toggle from the SERVER's consent record;
  /// this is what the app itself acts on between launches.
  bool? get consentGranted => _consent;

  /// Exposed so [Activation] can skip the WORK behind an event (the station
  /// count read for first_kot, the plan-cap read for menu_ready) and not just
  /// the emit. Without this an unconfigured build would still pay for network
  /// calls whose only consumer is analytics.
  bool get disabled => !enabled;

  /// The platform stamp. Web sends 'web'; we send the OS.
  static String get platform {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'other';
  }

  /// Wire the module to the app's session state. Called ONCE from main.dart,
  /// which is what keeps this file free of any import from providers/ or
  /// screens/ — and therefore safe to call from ApiService's own error
  /// interceptor with no import cycle.
  void setIdentityProvider(AnalyticsIdentity Function() fn) {
    _identityProvider = fn;
  }

  /// Apply the owner's analytics consent. Called by the privacy screen's
  /// toggle (Settings > Privacy & data) right after it records the
  /// `cookies_analytics` consent event server-side, and by that screen on
  /// load so the server's record wins over a stale local mirror.
  ///
  /// `false` makes every emitter a no-op IMMEDIATELY and tells Firebase to
  /// stop collecting; nothing is queued or replayed. The choice is persisted
  /// so it also applies at the next launch, before any reporting starts.
  /// Never throws.
  Future<void> setEnabled(bool value) async {
    _consent = value;
    try {
      await _fa?.setAnalyticsCollectionEnabled(value);
    } catch (e) {
      if (kDebugMode) debugPrint('[analytics] setEnabled($value) failed: $e');
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_kConsent, value);
    } catch (_) { /* storage unavailable — applies for this session only */ }
  }

  /// The stored decision, or null when never answered / unreadable. Unknown
  /// is treated as refused by [enabled].
  Future<bool?> _readConsent() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(_kConsent);
    } catch (_) {
      return null; // storage unavailable ⇒ fail closed
    }
  }

  /// Resolve the Firebase Analytics instance, if this platform has a Firebase
  /// config at all. Call from main() AFTER NotificationService.initPush()
  /// (which already initialises Firebase on Android). Never throws.
  ///
  /// Android: android/app/google-services.json is present, so Firebase is
  ///   live and analytics starts collecting.
  /// iOS: there is no ios/Runner/GoogleService-Info.plist yet, so
  ///   Firebase.initializeApp() throws, we swallow it, and the whole module
  ///   stays a no-op. Drop the plist into the Runner target and iOS starts
  ///   reporting with ZERO code change — that is the only remaining step.
  /// CONSENT ORDER MATTERS HERE: the stored `cookies_analytics` decision is
  /// read FIRST, and `setAnalyticsCollectionEnabled` is passed that decision
  /// — so an owner who refused (or was never asked) has Firebase collection
  /// switched off before a single event can be raised. Reporting never starts
  /// before consent is known.
  Future<void> bootstrap() async {
    if (_bootstrapped) return;
    _bootstrapped = true;
    if (_disabledByDefine || _isTest) return;
    _consent = await _readConsent();
    try {
      if (Firebase.apps.isEmpty) {
        // Idempotent for the default app; throws when the platform has no
        // Firebase config file (today: iOS).
        await Firebase.initializeApp();
      }
      final fa = FirebaseAnalytics.instance;
      await fa.setAnalyticsCollectionEnabled(_consent == true);
      _fa = fa;
      _ready = true;
    } catch (e) {
      // No Firebase on this platform / this build. Stay silent and inert.
      if (kDebugMode) debugPrint('[analytics] disabled: $e');
    }
  }

  // ── Time helpers (derived from Business.createdAt — no new server field) ──

  AnalyticsIdentity _identity() {
    final p = _identityProvider;
    if (p == null) return AnalyticsIdentity.empty;
    try {
      return p();
    } catch (_) {
      return AnalyticsIdentity.empty;
    }
  }

  Duration? _elapsed() {
    final at = _identity().signupAt;
    if (at == null) return null;
    final d = DateTime.now().difference(at);
    return d.isNegative ? Duration.zero : d;
  }

  /// Whole minutes from signup to now, or null when the timestamp is unknown.
  int? minutesSinceSignup() {
    final d = _elapsed();
    return d == null ? null : (d.inSeconds / 60).round();
  }

  /// Whole days from signup to now, or null when the timestamp is unknown.
  int? daysSinceSignup() => _elapsed()?.inDays;

  /// The activation window. Null when the signup timestamp is unknown.
  bool? withinFirst24h() {
    final d = _elapsed();
    return d == null ? null : d.inHours < 24;
  }

  // ── Sanitisation ────────────────────────────────────────────────────────

  static final _reEmail =
      RegExp(r'[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}', caseSensitive: false);
  static final _reIndianMobile = RegExp(r'(?:\+?91[- ]?)?[6-9]\d{9}\b');
  static final _reJwt =
      RegExp(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b');
  // 15-char GSTIN (2 state digits + 10-char PAN + entity + Z + checksum).
  static final _reGstin =
      RegExp(r'\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b', caseSensitive: false);

  /// Returns the value to send, or `null` to drop the property entirely.
  ///
  /// Maps, Lists and every other composite are ALWAYS dropped — that closes
  /// the "just pass the whole order/customer object" hole permanently.
  /// Firebase only accepts String and num parameter values, so bools are
  /// normalised to 'true'/'false' (which is exactly how GA4 renders the
  /// booleans the web half sends, so the two still join).
  static Object? _safeValue(Object? v) {
    if (v == null) return null;
    if (v is bool) return v ? 'true' : 'false';
    if (v is num) return v.isFinite ? v : null;
    if (v is! String) return null; // Map / List / DateTime / anything else
    var s = v.trim();
    if (s.length > _maxStringLen) s = s.substring(0, _maxStringLen);
    if (s.isEmpty) return '';
    if (_reEmail.hasMatch(s) ||
        _reIndianMobile.hasMatch(s) ||
        _reJwt.hasMatch(s) ||
        _reGstin.hasMatch(s)) {
      return null;
    }
    return s;
  }

  Map<String, Object> _buildParams(String event, Map<String, Object?>? props) {
    final id = _identity();
    final allowed = <String>{..._globalProps, ...?_eventProps[event]};
    final merged = <String, Object?>{
      'business_id': id.businessId,
      'plan_tier': id.planTier,
      'platform': platform,
      ...?props,
    };
    final out = <String, Object>{};
    merged.forEach((k, raw) {
      if (!allowed.contains(k)) {
        if (kDebugMode) {
          debugPrint('[analytics] dropped un-allow-listed prop "$k" on $event');
        }
        return;
      }
      final v = _safeValue(raw);
      if (v == null) return;
      out[k] = v;
    });
    return out;
  }

  // ── The only public emitter ─────────────────────────────────────────────

  /// Send one funnel event. Silent no-op when analytics is unconfigured.
  ///
  ///   AnalyticsService.instance.track(
  ///     FunnelEvent.planLimitHit,
  ///     {'metric': 'menu_items', 'limit': 10, 'attempted': 11},
  ///   );
  void track(String event, [Map<String, Object?>? props]) {
    if (disabled) return;
    final fa = _fa;
    if (fa == null) return;
    try {
      if (!_eventProps.containsKey(event)) return; // unknown event, drop
      final params = _buildParams(event, props);
      final bid = _identity().businessId;
      if (bid != null && bid.isNotEmpty && bid != _lastUserId) {
        _lastUserId = bid;
        // Fire-and-forget: a failed user-id write must not lose the event.
        fa.setUserId(id: bid).catchError((_) {});
      }
      fa.logEvent(name: event, parameters: params).catchError((_) {});
    } catch (e) {
      if (kDebugMode) debugPrint('[analytics] track($event) failed: $e');
    }
  }

  // ── First-time-only milestones ─────────────────────────────────────────

  Future<Map<String, String>> _milestones() {
    return _milestonesFuture ??= (() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getString(_kMilestones);
        if (raw == null || raw.isEmpty) return <String, String>{};
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          return decoded.map((k, v) => MapEntry('$k', '$v'));
        }
      } catch (_) { /* storage unavailable — treat as "nothing fired" */ }
      return <String, String>{};
    })();
  }

  static String _milestoneKey(String event, String businessId) =>
      '$event:$businessId';

  /// True when this milestone has already been recorded for this business.
  /// Lets [Activation] skip the work behind an event as well as the emit.
  Future<bool> hasFired(String event) async {
    if (disabled) return false;
    final bid = _identity().businessId;
    if (bid == null || bid.isEmpty) return false;
    final all = await _milestones();
    return all.containsKey(_milestoneKey(event, bid));
  }

  /// Fire a milestone exactly once per business. Returns true if the event
  /// was emitted, false if it had already fired (or could not be keyed).
  ///
  /// WHERE THE STATE LIVES: `SharedPreferences['np_funnel_v1']`, one JSON map
  /// of `"<event>:<businessId>" -> ISO timestamp`.
  ///
  /// WHY SharedPreferences and not sqflite or flutter_secure_storage:
  ///   • sqflite is wiped by DatabaseService.clearAll(), which AuthService
  ///     .logoutFull() calls on every account/outlet switch — the milestone
  ///     would be forgotten and re-fire on the next bill.
  ///   • flutter_secure_storage is the token store; main() calls deleteAll()
  ///     on it during the iOS keychain migration, and it is the wrong tool
  ///     for non-secret marketing state anyway.
  ///   • SharedPreferences is never cleared anywhere in this app, already
  ///     carries exactly this kind of "shown once" flag (widgets/feature_tour
  ///     .dart `np_seen_feature_tour_v2`), and survives restarts.
  /// Business ids sit inside the map keys but the PREFS key is
  /// business-agnostic, so switching outlets neither wipes the map nor lets
  /// one outlet's milestone satisfy another's — each business id gets its own
  /// entry and an outlet the owner has not billed from yet still fires.
  ///
  /// FAILURE MODES — deliberately accepted for a marketing funnel:
  ///   • per device+install. Reinstalling the app, clearing app data, or
  ///     activating on a second phone re-fires the milestone, so GA4 will
  ///     show a small over-count of "first" events. Dedupe on business_id in
  ///     the report if it matters.
  ///   • the same business activating on web AND app fires both halves once
  ///     each — same dedupe.
  ///   • the guard is written BEFORE the event leaves the device, so an
  ///     emit that fails silently still consumes the milestone.
  Future<bool> trackOnce(String event, [Map<String, Object?>? props]) async {
    if (disabled) return false;
    if (!_onceEvents.contains(event)) {
      track(event, props);
      return true;
    }
    final bid = _identity().businessId;
    // No business id ⇒ we cannot key the milestone, so we must not fire: an
    // unkeyed event would repeat on every launch.
    if (bid == null || bid.isEmpty) return false;
    final key = _milestoneKey(event, bid);
    final all = await _milestones();
    if (all.containsKey(key)) return false;
    // Mark in memory FIRST (synchronously, before any further await) so a
    // concurrent caller in the same turn cannot slip past the check.
    all[key] = DateTime.now().toIso8601String();
    track(event, props);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kMilestones, jsonEncode(all));
    } catch (_) { /* storage disabled — may re-fire next launch */ }
    return true;
  }

  // ── plan_limit_hit → upgrade_paid.blocked_metric ───────────────────────

  /// Remember the plan metric that last refused this owner.
  Future<void> recordBlockedMetric(String metric) async {
    if (disabled || metric.isEmpty) return;
    final bid = _identity().businessId;
    if (bid == null || bid.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
          _kBlocked, jsonEncode({'businessId': bid, 'metric': metric}));
    } catch (_) { /* storage disabled */ }
  }

  /// The metric that last 403'd, so upgrade_paid can say what forced it.
  Future<String> lastBlockedMetric() async {
    final bid = _identity().businessId;
    if (bid == null || bid.isEmpty) return '';
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_kBlocked);
      if (raw == null || raw.isEmpty) return '';
      final v = jsonDecode(raw);
      if (v is Map && v['businessId'] == bid && v['metric'] is String) {
        return v['metric'] as String;
      }
    } catch (_) { /* storage disabled */ }
    return '';
  }

  // ── upgrade_paid.from_tier ─────────────────────────────────────────────

  Future<String> lastSeenTier(String businessId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_kTier);
      if (raw == null || raw.isEmpty) return '';
      final v = jsonDecode(raw);
      if (v is Map && v['businessId'] == businessId && v['tier'] is String) {
        return v['tier'] as String;
      }
    } catch (_) { /* storage disabled */ }
    return '';
  }

  Future<void> rememberTier(String businessId, String tier) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
          _kTier, jsonEncode({'businessId': businessId, 'tier': tier}));
    } catch (_) { /* storage disabled */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Activation — the named helpers. This is the COMPOSITION layer: it knows
// what a "menu_ready" or a "first_bill" means in NamastePOS terms, so screens
// and providers don't. It never touches Firebase; every emit goes through
// AnalyticsService.track/trackOnce, which owns the allow-list, the PII scrub
// and the no-op guard.
// ═══════════════════════════════════════════════════════════════════════════

/// Receipt channels a mobile bill can leave by. Mirrors the web enum plus
/// `bluetooth`, which only exists on the phone.
class ReceiptChannel {
  static const bluetooth = 'bluetooth';
  static const whatsapp = 'whatsapp';
  static const pdf = 'pdf';
  static const none = 'none';
}

class Activation {
  Activation._();

  static AnalyticsService get _a => AnalyticsService.instance;

  // ── "Owner-authored" ────────────────────────────────────────────────────
  //
  // The activation metric deliberately excludes rows the product filled in
  // for the owner, so clicking through the setup wizard cannot fake an
  // activation. On mobile the pre-filled rows come from
  // SetupWizardScreen._items (Masala Chai 30 / Butter Naan 40 / Paneer Tikka
  // 250) — the same three the dashboard wizard seeds. A row counts as
  // pre-filled only when BOTH the name and the price still match the default
  // exactly; edit either one and it is the owner's. Kept byte-identical to
  // the web PREFILLED table (which also lists the dashboard CSV sample rows)
  // so both platforms measure the same thing.
  static const _prefilled = <String, num>{
    'masala chai': 30,
    'butter naan': 40,
    'paneer tikka': 250,
    // namastepos_dashboard MenuCsvImportDialog SAMPLE_CSV rows
    'paneer butter masala': 280,
    'chicken 65': 240,
  };

  /// Tolerant number coercion — the backend has historically sent plan
  /// limits as ints OR numeric strings (see Plan.fromMap).
  static num? _num(Object? v) =>
      v is num ? v : num.tryParse('${v ?? ''}');

  static bool _isPrefilled(Object? name, Object? price) {
    final n = '${name ?? ''}'.trim().toLowerCase();
    final want = _prefilled[n];
    if (want == null) return false;
    final p = price is num ? price : num.tryParse('${price ?? ''}');
    return p != null && p == want;
  }

  /// True when at least one billed line is not an untouched pre-fill.
  static bool hasOwnerAuthoredLine(List<({String name, num price})> lines) {
    if (lines.isEmpty) return false;
    return lines.any((l) => !_isPrefilled(l.name, l.price));
  }

  /// Active menu items the owner actually authored.
  static int countOwnerAuthored(List<({String name, num price, bool active})> items) {
    return items
        .where((it) => it.active && !_isPrefilled(it.name, it.price))
        .length;
  }

  // ── 1. signup ──────────────────────────────────────────────────────────

  /// POST /auth/register or a Google sign-UP returned a session. Not fired by
  /// the login screen: Google there is a sign-IN on an existing account.
  static void signup({
    required String method, // 'email' | 'google'
    required bool hasBusinessName,
    String? referralCode,
  }) {
    if (_a.disabled) return;
    _a.track(FunnelEvent.signup, {
      'method': method,
      'has_business_name': hasBusinessName,
      // An opaque referral code, not a person. Kept because attribution is
      // the whole point of the referral programme.
      'referral_code': referralCode ?? '',
    });
  }

  // ── 2. business_created ────────────────────────────────────────────────

  /// Fired once, the first time a business id lands in a session on this
  /// device. Hooked to AuthProvider._postLogin, the single funnel every
  /// successful sign-in path already routes through.
  ///
  /// `is_new` is derived from the business's own createdAt rather than an
  /// auth-response flag the mobile client never receives: a business created
  /// inside the last 10 minutes is this signup's, anything older is a
  /// returning owner signing in on a new device.
  static void businessCreated({String? category}) {
    if (_a.disabled) return;
    final mins = _a.minutesSinceSignup();
    _a.trackOnce(FunnelEvent.businessCreated, {
      'is_new': mins != null && mins <= 10,
      // Business category (Café / QSR / Cloud kitchen …) — a segment, not an
      // identifier. Null until the wizard sets it.
      'category': category,
    });
  }

  // ── 3. menu_ready ──────────────────────────────────────────────────────

  static const int _menuReadyThreshold = 3;

  /// Crossing >= 3 owner-authored ACTIVE menu items for the first time.
  ///
  /// Safe to call on every menu refresh: it exits before doing any work if
  /// the milestone has already fired or the threshold is not met.
  /// `source` uses the web vocabulary ('wizard' | 'manual' | 'bulk_csv' |
  /// 'migrate'); mobile has no CSV/migrate path, so it is always 'manual' or
  /// 'wizard'.
  static Future<void> menuReady(
    List<({String name, num price, bool active})> items,
    String source, {
    int? planItemCap,
  }) async {
    if (_a.disabled) return;
    if (await _a.hasFired(FunnelEvent.menuReady)) return;
    final count = countOwnerAuthored(items);
    if (count < _menuReadyThreshold) return;
    await _a.trackOnce(FunnelEvent.menuReady, {
      'item_count': count,
      'source': source,
      'minutes_since_signup': _a.minutesSinceSignup(),
      // The pricing cliff, as a boolean: an owner already over their plan's
      // menu cap the moment their menu is usable.
      'over_plan_cap': planItemCap != null &&
          planItemCap != -1 &&
          count > planItemCap,
    });
  }

  // ── 4. first_kot ───────────────────────────────────────────────────────

  /// First kitchen ticket for this business. The KOT is generated
  /// server-side inside the order-create transaction (orderService →
  /// kotService.generateTickets), so a successful POST /orders IS the KOT
  /// fire — exactly as on web, where there is no separate "fire KOT" call.
  ///
  /// `stationCount` is supplied by the caller (which already has an API
  /// client) so this module stays free of any dependency on ApiService.
  static Future<void> firstKot({
    String? orderId,
    required Future<int> Function() stationCount,
  }) async {
    if (_a.disabled) return;
    if (await _a.hasFired(FunnelEvent.firstKot)) return;
    int stations = 0;
    try {
      stations = await stationCount();
    } catch (_) {
      // 402 on Starter (kds is a paid feature) ⇒ genuinely zero configured
      // stations, which is the honest answer, not a missing value.
      stations = 0;
    }
    await _a.trackOnce(FunnelEvent.firstKot, {
      'order_id': orderId,
      'station_count': stations,
      'minutes_since_signup': _a.minutesSinceSignup(),
    });
  }

  // ── 5. first_bill — THE activation event ───────────────────────────────

  /// First settled order carrying at least one owner-authored line.
  ///
  /// Idempotent per business, so it is safe to call from every settle path
  /// (POS "Pay & Place", table-session settle) — whichever the owner reaches
  /// first wins, and `receipt_channel` records how, or `none` when the bill
  /// was settled without producing a receipt at all, which is itself worth
  /// knowing.
  static Future<void> firstBill({
    String? orderId,
    required num amountInr,
    required String? paymentMode,
    required String receiptChannel,
    required List<({String name, num price})> lines,
  }) async {
    if (_a.disabled) return;
    if (await _a.hasFired(FunnelEvent.firstBill)) return;
    // "Real" bill: excludes a wizard click-through that only ever billed the
    // three pre-filled demo rows.
    if (!hasOwnerAuthoredLine(lines)) return;
    final mode = (paymentMode ?? '').toLowerCase();
    const known = ['cash', 'upi', 'card', 'split', 'online', 'wallet'];
    await _a.trackOnce(FunnelEvent.firstBill, {
      'order_id': orderId,
      'amount_inr': (amountInr * 100).round() / 100,
      'payment_mode': known.contains(mode) ? mode : 'other',
      'receipt_channel': receiptChannel,
      'line_items': lines.length,
      'minutes_since_signup': _a.minutesSinceSignup(),
      'within_24h': _a.withinFirst24h(),
    });
  }

  // ── 6. upgrade_paid ────────────────────────────────────────────────────

  /// Watch a subscription payload and fire once when it is a CONFIRMED paid
  /// tier. The Razorpay webhook is server-side and invisible to the app, so
  /// the client-observable proof is the subscription row the webhook writes:
  /// a non-free plan with status 'active'. Razorpay's own
  /// EVENT_PAYMENT_SUCCESS is NOT enough — that is the client saying so.
  ///
  /// Called from SubscriptionProvider.load(), the one place every screen's
  /// subscription data comes from.
  static Future<void> upgradePaid({
    required String? businessId,
    required String tier,
    required num priceInr,
    required String status,
    required String billingCycle, // 'monthly' | 'yearly'
  }) async {
    if (_a.disabled) return;
    if (businessId == null || businessId.isEmpty || tier.isEmpty) return;
    final isPaidTier = tier != 'free' && priceInr > 0;
    final confirmed = status == 'active';
    if (!isPaidTier || !confirmed) {
      // Still on a free/trialing plan: keep the "from" tier fresh so the
      // eventual upgrade reports where they actually came from.
      if (!await _a.hasFired(FunnelEvent.upgradePaid)) {
        await _a.rememberTier(businessId, tier);
      }
      return;
    }
    if (await _a.hasFired(FunnelEvent.upgradePaid)) return;
    final from = await _a.lastSeenTier(businessId);
    final blocked = await _a.lastBlockedMetric();
    final fired = await _a.trackOnce(FunnelEvent.upgradePaid, {
      'from_tier': from.isEmpty ? 'free' : from,
      'to_tier': tier,
      'amount_inr': priceInr,
      'billing_cycle': billingCycle == 'yearly' ? 'yearly' : 'monthly',
      'days_since_signup': _a.daysSinceSignup(),
      // Which cap pushed them over. This is the line that turns the pricing
      // cliff into revenue attribution.
      'blocked_metric': blocked,
    });
    if (fired) await _a.rememberTier(businessId, tier);
  }

  // ── 7. plan_limit_hit ──────────────────────────────────────────────────

  /// Hooked off the backend's `error: 'PLAN_LIMIT'` response (see
  /// subscriptionService.enforceLimit), whose `details` carry
  /// { metric, limit, current, plan }. NOT a once-per-business milestone —
  /// every refusal is a signal.
  ///
  /// `attempted` is `current + 1`: the create that was actually refused.
  static void planLimitHit(Map<String, dynamic> details) {
    if (_a.disabled) return;
    final metric = '${details['metric'] ?? ''}';
    if (metric.isEmpty) return;
    final limit = _num(details['limit']);
    final current = _num(details['current']);
    _a.track(FunnelEvent.planLimitHit, {
      'metric': metric,
      'limit': limit,
      // The create that was actually refused, i.e. one past what they hold.
      'attempted': current == null ? null : current + 1,
      'tier': details['plan'] is String ? details['plan'] as String : null,
    });
    // Remembered for upgrade_paid.blocked_metric.
    // ignore: unawaited_futures
    _a.recordBlockedMetric(metric);
  }
}
