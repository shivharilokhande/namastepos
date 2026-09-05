// NamastePOS — entitlement staleness watcher (X-Plan-Version).
//
// ══════════════════════════════════════════════════════════════════════════
// WHY (2026-09-05, the Voice POS report)
// ══════════════════════════════════════════════════════════════════════════
// The founder removed Voice POS from a customer's plan and the mic stayed
// visible in their running app. Two things were wrong: the mic had no gate
// (fixed — see test/entitlements_test.dart), and nothing told a RUNNING app
// that its entitlement had changed. The second half was patched with a
// 5-minute timer in HomeScreen calling AuthProvider.refreshPlanIfStale().
//
// A timer is a floor, not a fix. Worst case a customer keeps a revoked
// feature for the poll interval plus AuthProvider.entitlementMaxAge.
//
// The backend already publishes the answer and the app was throwing it away.
// featureService.planVersion() is a 12-hex fingerprint of
// (plan code | tier kind | merged feature set); middleware/featureGate.js
// stamps it as the `X-Plan-Version` response header on authenticated
// /v1/businesses/:businessId routes, and app.js lists it in the CORS
// exposedHeaders. A POS is never idle — the captain board polls, the offline
// outbox drains every 30s, every bill is a write — so comparing that header
// on responses the app is ALREADY receiving collapses detection from minutes
// to the next request, on Android and iOS, with no FCM and no Apple push key.
//
// This class is ONLY the decision: "is this fingerprint different from the
// last one, and should that fire a refresh?". ApiService's dio interceptor
// feeds it from a single response path (so a new endpoint added later cannot
// forget), and AuthProvider supplies the refresh (AuthProvider.refreshPlan,
// the existing path — never a second one writing the same state).
//
// The HomeScreen timer STAYS. This is an optimisation layered on top: an app
// parked on a screen that makes no requests at all still needs the backstop,
// and so does a tenant whose backend feature cache has gone cold (the header
// is best-effort server-side — featureGate never issues a query just to carry
// it, so an ungated request against a cold cache carries no header at all).

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;

/// The response header the backend stamps. Lower-case because dio normalises
/// header names; `Headers.value` is case-insensitive either way.
const String kPlanVersionHeader = 'x-plan-version';

/// What the watcher calls when the fingerprint changes. Wired to
/// AuthProvider.refreshPlan().
typedef PlanRefresh = Future<void> Function();

/// Tracks the last-seen `X-Plan-Version` and fires [onChanged] when it moves.
///
/// Everything here fails safe and quiet: a missing, empty or malformed header
/// is ignored, and a refresh that throws is swallowed. Nothing in this class
/// may ever affect the request the user is actually waiting on.
class PlanVersionWatcher {
  PlanVersionWatcher({this.onChanged});

  /// Set by AuthProvider. Null until then (and after sign-out), which makes
  /// the watcher inert rather than a source of orphaned work.
  PlanRefresh? onChanged;

  /// The fingerprint this client believes it is running on. Null means "we
  /// have never seen one" — the FIRST header is a baseline, not a change.
  /// Firing on it would mean a pointless /auth/me on every cold start and
  /// after every login, when login already hydrated the plan.
  String? _seen;

  /// True while a triggered refresh is in flight. Two things depend on it:
  ///
  ///  * **No storms.** N responses arriving together with the same new
  ///    fingerprint must produce ONE refresh, not N. (Value de-duplication
  ///    below already covers the common case; this covers a change landing
  ///    while an earlier refresh is still running.)
  ///  * **No recursion.** The refresh is itself an HTTP call whose response
  ///    goes back through the same interceptor. /auth/me happens not to carry
  ///    the header today — featureGate is mounted on /businesses/:businessId
  ///    only — but that is an accident of routing, not a guarantee, and the
  ///    refresh may trigger other requests. The guard does not depend on it.
  bool _refreshing = false;

  Future<void>? _inflight;

  /// The fingerprint currently believed to be in force. Test/diagnostic only.
  String? get seen => _seen;

  /// Whether a triggered refresh is running. Test/diagnostic only.
  bool get refreshing => _refreshing;

  /// The in-flight refresh, so tests can await it deterministically. Null when
  /// nothing is running.
  Future<void>? get inFlight => _inflight;

  /// The shape featureService._fingerprint produces: a hex SHA-1 slice (12
  /// chars today). Anything else — an empty header, a proxy's placeholder, a
  /// truncated value — is treated as "no information" rather than as a new
  /// version, because acting on garbage would refresh the plan on every
  /// single response. The bounds are deliberately loose so a change of digest
  /// length server-side does not silently disable this.
  static final RegExp _shape = RegExp(r'^[0-9a-fA-F]{8,64}$');

  /// Feed every response's header value here — present, absent or junk.
  /// Never throws.
  void note(String? raw) {
    try {
      final v = raw?.trim();
      if (v == null || v.isEmpty) return; // header absent — nothing learned
      if (!_shape.hasMatch(v)) return; // malformed — nothing learned
      if (_seen == null) {
        _seen = v; // first header ever: seed the baseline, do NOT refresh
        return;
      }
      if (v == _seen) return; // unchanged — the overwhelmingly common path

      // A refresh is already running. Leave the baseline ALONE so this new
      // fingerprint is re-detected on the next response and still gets its
      // refresh; overwriting it here would swallow the change entirely.
      if (_refreshing) return;

      // Update the baseline BEFORE firing, so every other response carrying
      // this same fingerprint (a burst of parallel polls all answered by the
      // same backend cache entry) de-duplicates against it instead of piling
      // up refreshes behind the in-flight guard.
      _seen = v;
      _fire();
    } catch (_) {
      // A diagnostic header must never break a request.
    }
  }

  /// Drop all state. Called from ApiService.clearTokens() so the next tenant
  /// on this device seeds its own baseline instead of reading the previous
  /// tenant's fingerprint as a change.
  void reset() {
    _seen = null;
    _refreshing = false;
    _inflight = null;
  }

  void _fire() {
    final cb = onChanged;
    if (cb == null) return; // nobody wired up (signed out) — nothing to do
    _refreshing = true;
    _inflight = _run(cb);
    unawaited(_inflight!);
  }

  Future<void> _run(PlanRefresh cb) async {
    try {
      await cb();
    } catch (e) {
      // AuthProvider.refreshPlan() already swallows network errors; this is
      // the belt to that braces. A failed refresh must not throw into the UI
      // and must not leave the guard stuck.
      debugPrint('[plan-version] refresh failed (non-fatal): $e');
    } finally {
      _refreshing = false;
      _inflight = null;
    }
  }
}
