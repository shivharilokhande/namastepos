// NamastePOS - Auth state provider (Google Sign-In)

import 'package:flutter/foundation.dart';

import '../models/business.dart';
import '../models/plan_info.dart';
import '../services/analytics_service.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/notification_service.dart';
import '../services/offline_outbox.dart';
import '../services/upsell_hints.dart';
import '../utils/role_permissions.dart';

enum AuthStatus { unknown, authenticated, unauthenticated, locked }

class AuthProvider extends ChangeNotifier {
  AuthProvider() {
    // When any request 401s and the refresh token is dead, fall straight to
    // the login screen instead of letting an "authentication" error surface
    // on an inner screen.
    ApiService.instance.onAuthExpired = _onAuthExpired;
    // 2026-09-05 — entitlement staleness. The API client watches the backend's
    // `X-Plan-Version` header on responses this app is already making and
    // calls back here the moment the fingerprint moves. See
    // services/plan_version_watcher.dart. This does NOT replace HomeScreen's
    // 5-minute poll, which remains the backstop for an app that is making no
    // requests at all.
    ApiService.instance.onPlanVersionChanged = _onPlanVersionChanged;
    _bootstrap();
  }

  /// The plan fingerprint changed server-side. Go straight to [refreshPlan] —
  /// the SAME path the poll and every explicit refresh use, so there is only
  /// ever one writer of `_plan` / `_role` / `_permissions`.
  ///
  /// Deliberately NOT [refreshPlanIfStale]: that no-ops for
  /// [entitlementMaxAge] after the last fetch, and a fingerprint change is
  /// positive evidence that the cached answer is wrong regardless of its age.
  /// Suppressing it would reintroduce the very window this closes.
  ///
  /// Never throws — refreshPlan() swallows its own failures, and the watcher
  /// catches anything that escapes.
  Future<void> _onPlanVersionChanged() async {
    // A header seen while signed out (a request in flight across a logout)
    // must not resurrect a session's plan fetch.
    if (_status != AuthStatus.authenticated) return;
    await refreshPlan();
  }

  void _onAuthExpired() {
    // Review 2026-08-28: only drop a fully-authenticated session. Previously
    // ANY non-unauthenticated status (including `locked`, the MPIN lock screen)
    // was flipped to unauthenticated, so a stray 401 while locked destroyed a
    // recoverable session and forced a full re-login.
    if (_status != AuthStatus.authenticated) return;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  bool _mpinSet = false;
  /// Whether an owner MPIN is configured on this device.
  bool get mpinEnabled => _mpinSet;
  bool get isOwner => role == 'business_owner';

  AuthStatus _status = AuthStatus.unknown;
  Business? _business;
  PlanInfo _plan = PlanInfo.unknown();

  /// When the plan summary in [_plan] was last taken from the SERVER, so a
  /// long-running session can tell a fresh entitlement from a stale one.
  /// Null while entitlements are unknown or only restored from cache.
  DateTime? _planFetchedAt;
  String? _role;          // business_owner | staff_manager | staff_captain | …
  List<String> _permissions = const []; // Push 14c
  bool _loading = false;
  String? _error;

  AuthStatus get status => _status;
  Business? get business => _business;
  PlanInfo get plan => _plan;
  /// Current user's role in the active business. Used to gate drawer +
  /// bottom-nav items so Captain doesn't see Menu editor, Kitchen doesn't
  /// see Billing, etc. Owner = unrestricted.
  ///
  /// NP-201 — FAIL CLOSED. This used to default to `business_owner`, so any
  /// session with a missing or not-yet-hydrated role (a staff PIN login whose
  /// response omitted `role`, a cold start before /auth/me answers, a stale
  /// keychain read) rendered the FULL owner UI: Reports, Plans & billing,
  /// Marketplace, Staff management, owner Settings. The founder hit exactly
  /// this with a `staff_kitchen` member. An unknown role is now the empty
  /// string, which matches no owner branch and grants no permission — the
  /// user lands on the least-privilege surface until a real role arrives.
  ///
  /// Every gate in the app compares against the literal 'business_owner', so
  /// '' is inert everywhere by construction. Never reintroduce a default.
  String get role => _role ?? '';

  /// Whether we actually know who this user is yet. UI that wants to show a
  /// "loading" state instead of a stripped-down one can check this.
  bool get roleKnown => (_role ?? '').isNotEmpty;

  /// Push 14c — explicit permission list for the current user. Owner gets
  /// an empty list here and code should special-case `role == business_owner`
  /// to mean "all permissions". For staff, this is the authoritative
  /// allowlist (overrides role defaults if non-empty).
  List<String> get permissions => _permissions;

  /// NP-201: single permission oracle, delegating to [RolePerms.can] so the
  /// drawer, the bottom nav and imperative callers can never disagree.
  ///
  ///   owner                       → true
  ///   explicit permission list    → list membership ONLY
  ///   staff, empty list           → that role's defaults
  ///   unknown role, empty list    → DENY
  ///
  /// An empty list is "no explicit grants", never "all grants".
  bool canDo(String permission) =>
      RolePerms.can(role, permission, permissions: _permissions);
  bool get loading => _loading;
  String? get error => _error;

  /// THE entitlement oracle. Every plan-gated surface in the app goes through
  /// here (directly, or via PlanGate).
  ///
  /// FAIL-CLOSED, 2026-09-05. Delegates to [PlanInfo.has], which denies while
  /// entitlements are unknown — not yet fetched, fetch failed, signed out.
  /// The three states that must all deny are "we have not asked", "we asked
  /// and it went wrong", and "we asked and the key is not there"; before this
  /// they were two states and a guess.
  ///
  /// Pass a `Features.` constant, never a string literal — see
  /// constants/feature_keys.dart. `test/entitlements_test.dart` enforces it.
  bool has(String featureKey) => _plan.has(featureKey);

  /// Whether a server-resolved entitlement set is in hand. UI that wants to
  /// show a neutral "loading" state instead of an "upgrade" pitch (which
  /// would be a lie while we simply do not know) checks this.
  bool get entitlementsKnown => _plan.loaded;

  void setPlan(PlanInfo p) {
    _plan = p;
    if (p.loaded) _planFetchedAt = DateTime.now();
    notifyListeners();
  }

  /// Hits /auth/me to fetch a fresh plan summary. Called on app foreground
  /// and from explicit "Refresh plan" actions. Silent on network failure —
  /// the cached plan keeps working until the next successful fetch.
  ///
  /// Push 16i — also refreshes role + permissions so the staff drawer
  /// reflects owner-side permission edits without forcing a sign-out.
  Future<void> refreshPlan() async {
    try {
      final me = await AuthService.instance.fetchMe();
      var changed = false;
      final p = me?['plan'] as Map<String, dynamic>?;
      if (p != null) {
        _plan = PlanInfo.fromMap(p);
        _planFetchedAt = DateTime.now();
        changed = true;
      }
      final role = me?['role'] as String?;
      if (role != null && role != _role) {
        _role = role;
        changed = true;
      }
      final perms = me?['permissions'];
      if (perms is List) {
        final next = perms.map((e) => e.toString()).toList();
        // Only notify if the list actually changed (avoid extra rebuilds).
        if (next.length != _permissions.length ||
            !next.every(_permissions.contains)) {
          _permissions = next;
          changed = true;
        }
      } else if (me != null && _permissions.isNotEmpty) {
        // NP-201: `permissions: null` means "owner — all" (role short-circuits
        // everywhere) or "server could not resolve a list". In neither case is
        // the previously cached list still authoritative, so drop it rather
        // than keeping a possibly-wider set. Staff then fall back to their
        // role's defaults via RolePerms.can(), never to "everything".
        _permissions = const [];
        changed = true;
      }
      if (changed) notifyListeners();
    } catch (_) { /* swallow — non-fatal */ }
  }

  /// How long a cached entitlement set is allowed to go unquestioned in a
  /// RUNNING app. The backend's own feature cache is a 60s TTL, so anything
  /// tighter than that only buys round-trips, not freshness.
  static const Duration entitlementMaxAge = Duration(minutes: 2);

  /// Re-fetch entitlements only if the last server answer is older than
  /// [entitlementMaxAge] (or there has never been one).
  ///
  /// 2026-09-05. Before this, a plan change made in the admin console reached
  /// a running app only on app-resume (HomeScreen's lifecycle hook) or a full
  /// relaunch — a counter phone that stays awake and in-app all shift kept a
  /// removed feature all shift. Screens that draw a gated surface call this
  /// when they open, which bounds the staleness to one screen entry rather
  /// than one app session. Cheap: a no-op when the plan is fresh.
  Future<void> refreshPlanIfStale() async {
    if (_status != AuthStatus.authenticated) return;
    final at = _planFetchedAt;
    if (at != null && DateTime.now().difference(at) < entitlementMaxAge) {
      return;
    }
    await refreshPlan();
  }

  Future<void> _restoreCached() async {
    final p = await AuthService.instance.cachedPlan();
    // A cached plan is a copy of a real server answer (AuthService writes it
    // from the login / auth-me payload and DELETES it when the payload has
    // none), so treating it as loaded is honest — and it keeps the deny
    // window on a warm start down to zero frames. It is not marked as
    // FETCHED, though: _planFetchedAt stays null so refreshPlanIfStale()
    // still goes to the server once.
    if (p != null) _plan = PlanInfo.fromMap(p);
    _role = await AuthService.instance.cachedRole();
    _permissions = await AuthService.instance.cachedPermissions() ?? const [];
  }

  /// Post-login hydration shared by every sign-in path.
  ///
  /// NP-201 did this for role/permissions; entitlements need the same
  /// treatment now that [has] fails closed. If the login response carried no
  /// plan (AuthService then clears the cache), the app would otherwise render
  /// every paid surface as locked until something else happened to call
  /// refreshPlan(). Ask once, before we hand control to HomeScreen.
  Future<void> _hydrateAfterLogin() async {
    final p = await AuthService.instance.cachedPlan();
    if (p != null) _plan = PlanInfo.fromMap(p);
    _role = await AuthService.instance.cachedRole();
    _permissions = await AuthService.instance.cachedPermissions() ?? const [];
    if (!_plan.loaded) await refreshPlan();
  }

  /// Launch/resume gate. CRITICAL: never declare `authenticated` just because
  /// a business is cached — that let inner screens load with a stale token and
  /// then 401 ("header authentication" error). We validate the session first:
  ///   • no cached business / no refresh token → login screen
  ///   • owner MPIN set → locked (show MPIN screen, unlock silently)
  ///   • otherwise → silently mint a fresh token; authenticated only if it works
  /// Status stays `unknown` (splash) until this resolves, so no inner-screen flash.
  Future<void> _bootstrap() async {
    final cached = await AuthService.instance.cachedBusiness();
    if (cached == null) {
      _status = AuthStatus.unauthenticated;
      notifyListeners();
      return;
    }
    _business = cached;
    await _restoreCached();
    _mpinSet = await AuthService.instance.hasMpin();

    final refresh = await ApiService.instance.refreshToken;
    final hasRefresh = refresh != null && refresh.isNotEmpty;
    if (!hasRefresh) {
      // Session fully gone (owner signed out, or first run) — require a login.
      _status = AuthStatus.unauthenticated;
      notifyListeners();
      return;
    }
    if (_mpinSet) {
      // Session recoverable, but gated behind the owner's MPIN.
      _status = AuthStatus.locked;
      notifyListeners();
      return;
    }
    // Silently confirm the session is still valid before showing the app.
    // FB-02 (2026-09-01): only log out on an EXPLICIT server rejection (false).
    // Offline / unreachable server returns null — for an offline-first POS we
    // keep the last-known session (we hold a refresh token) rather than stranding
    // the operator on the login screen with no internet; the next real request
    // refreshes the token or fires onAuthExpired if it's genuinely dead.
    final outcome = await AuthService.instance.tryRefreshSession();
    // NP-201: with the role getter failing closed, a session whose role was
    // never cached (an install that predates role caching, or a login path
    // that used to skip it) would flash the least-privilege UI for the frame
    // or two before HomeScreen's refreshPlan() lands. Hydrate role/permissions
    // here FIRST when we don't know them, so an owner never sees a stripped
    // app on launch and a staff member never sees more than they should.
    // Still fail-closed: if /auth/me can't be reached the role stays unknown.
    //
    // 2026-09-05: `|| !_plan.loaded` added for the same reason, now that
    // entitlements fail closed too. An install with a cached role but no
    // cached plan (a login response that omitted `plan`) would otherwise
    // render every paid surface as locked until HomeScreen's post-frame
    // refresh landed — the mirror image of the Voice POS bug, and just as
    // confusing for an owner who IS paying.
    if (outcome != false && (_role == null || !_plan.loaded)) {
      await refreshPlan();
    }
    _status = (outcome == false) ? AuthStatus.unauthenticated : AuthStatus.authenticated;
    if (outcome != false) _postLogin();
    notifyListeners();
  }

  /// Owner MPIN quick-unlock (PhonePe-style). Returns false on a wrong PIN
  /// (caller counts attempts). On a correct PIN we refresh the session: if the
  /// server session is still alive → authenticated; if it died → back to login.
  Future<bool> unlockWithMpin(String pin) async {
    final ok = await AuthService.instance.verifyMpin(pin);
    if (!ok) return false;
    await AuthService.instance.clearMpinFails(); // reset the persistent counter on success
    // FB-02: correct MPIN offline must UNLOCK, not bounce to login. Only an
    // explicit server rejection (false) logs out; null = offline → stay in.
    final outcome = await AuthService.instance.tryRefreshSession();
    if (outcome == false) {
      _status = AuthStatus.unauthenticated;
    } else {
      // NP-201: same as _bootstrap — hydrate an unknown role before showing
      // the app so the fail-closed getter never strips a legitimate owner.
      if (_role == null || !_plan.loaded) await refreshPlan();
      _status = AuthStatus.authenticated;
      _postLogin();
    }
    notifyListeners();
    return true;
  }

  /// Persistent wrong-MPIN counter (survives relaunch → not brute-forceable).
  Future<int> mpinFails() => AuthService.instance.mpinFails();
  Future<int> bumpMpinFails() => AuthService.instance.bumpMpinFails();

  /// Owner sets/updates their MPIN for faster login next time.
  Future<void> setMpin(String pin) async {
    await AuthService.instance.setMpin(pin);
    _mpinSet = true;
    notifyListeners();
  }

  Future<void> disableMpin() async {
    await AuthService.instance.clearMpin();
    _mpinSet = false;
    notifyListeners();
  }

  /// Whether to show the one-time "set an MPIN?" prompt (owner, no MPIN yet,
  /// hasn't dismissed it before).
  Future<bool> shouldPromptMpin() async {
    if (!isOwner || _mpinSet) return false;
    return !(await AuthService.instance.mpinPromptDismissed());
  }

  Future<void> dismissMpinPrompt() => AuthService.instance.dismissMpinPrompt();

  /// NP-104: full sign-out + local wipe for flows where the account/business
  /// is gone for good (e.g. DPDP account erasure). Same as signOutFromLock.
  Future<void> logoutFull() => signOutFromLock();

  /// Sign out from the MPIN lock screen ("Use another account").
  Future<void> signOutFromLock() async {
    await AuthService.instance.logoutFull();
    _business = null; _role = null; _permissions = const [];
    // NP-114: reset the plan too — without this the previous account's paid
    // entitlements stayed in RAM (login paths only overwrite _plan when the
    // response carries one, and the cached plan is deleted on logout).
    _plan = PlanInfo.unknown();
    _planFetchedAt = null;
    // Same reasoning for the cached upgrade labels: the next tenant's
    // position on the plan ladder is not this one's.
    UpsellHints.instance.clear();
    _mpinSet = false;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  /// Day-1 FCM hook — every successful sign-in path routes through here.
  /// Registers the device's FCM token with the backend so
  /// `sendToBusinessOwners` actually reaches this device. The call is
  /// fire-and-forget and swallows errors so a login can't fail on a
  /// notification-plumbing hiccup.
  void _postLogin() {
    final biz = _business;
    if (biz == null) return;
    // Activation funnel — `business_created`. Hooked here because this is the
    // single funnel every successful sign-in path (Google, password, staff
    // PIN, MPIN unlock, launch bootstrap) already routes through, so no
    // screen has to remember to fire it. trackOnce keys on the business id,
    // so relaunches and re-logins do NOT re-fire; a genuinely different
    // outlet does.
    Activation.businessCreated(category: biz.category);
    // ignore: unawaited_futures
    NotificationService.instance.registerFcmToken(biz.id).catchError((e) {
      debugPrint('[auth] fcm register failed (non-fatal): $e');
    });
    // NP-134: the outbox skips drains while signed out — kick one off now
    // that a fresh session exists so queued orders sync immediately instead
    // of waiting for the next 30s tick. Fire-and-forget, never blocks login.
    // ignore: unawaited_futures
    OfflineOutbox().drainOnce().catchError((e) {
      debugPrint('[auth] post-login outbox drain failed (non-fatal): $e');
      return 0;
    });
  }

  /// One-tap Google sign-in.
  /// Returns true if the user is now authenticated.
  Future<bool> signInWithGoogle() async {
    _loading = true; _error = null; notifyListeners();
    try {
      final biz = await AuthService.instance.signInWithGoogle();
      _business = biz;
      _status = AuthStatus.authenticated;
      // P1 fix (2026-08-22): hydrate plan/role/permissions like the
      // password path — without this the UI ran on starter defaults
      // (paid features locked, wrong staff gating) until next refresh.
      await _hydrateAfterLogin();
      _loading = false;
      notifyListeners();
      _postLogin();
      return true;
    } catch (e) {
      _error = _humanize(e.toString());
      _loading = false;
      notifyListeners();
      return false;
    }
  }

  /// DEV-ONLY email login — same outcome as Google, no Google involvement.
  /// Backend must have FF_DEV_LOGIN=1 set or returns 404.
  Future<bool> signInWithEmail(String email, {String? name}) async {
    _loading = true; _error = null; notifyListeners();
    try {
      final biz = await AuthService.instance.signInWithEmail(email, name: name);
      _business = biz;
      _status = AuthStatus.authenticated;
      await _hydrateAfterLogin();
      _loading = false;
      notifyListeners();
      _postLogin();
      return true;
    } catch (e) {
      _error = e.toString().contains('DEV_LOGIN_DISABLED')
          ? 'Dev login disabled. Set FF_DEV_LOGIN=1 in backend .env'
          : 'Sign-in failed: $e';
      _loading = false;
      notifyListeners();
      return false;
    }
  }

  Future<bool> registerWithPassword({
    required String email,
    required String password,
    String? name,
    String? businessName,
  }) async {
    _loading = true; _error = null; notifyListeners();
    try {
      final biz = await AuthService.instance.registerWithPassword(
        email: email, password: password, name: name, businessName: businessName);
      _business = biz;
      _status = AuthStatus.authenticated;
      await _hydrateAfterLogin();
      _loading = false; notifyListeners();
      _postLogin();
      return true;
    } catch (e) {
      _error = _humanizePwd(e.toString());
      _loading = false; notifyListeners();
      return false;
    }
  }

  Future<bool> loginWithPassword(String email, String password) async {
    _loading = true; _error = null; notifyListeners();
    try {
      final biz = await AuthService.instance.loginWithPassword(email, password);
      _business = biz;
      _status = AuthStatus.authenticated;
      await _hydrateAfterLogin();
      _loading = false; notifyListeners();
      _postLogin();
      return true;
    } catch (e) {
      _error = _humanizePwd(e.toString());
      _loading = false; notifyListeners();
      return false;
    }
  }

  /// PIN-based staff sign-in (Push 14b).
  Future<bool> signInWithPin({
    required String businessId,
    required String userId,
    required String pin,
  }) async {
    _loading = true; _error = null; notifyListeners();
    try {
      final biz = await AuthService.instance.signInWithPin(
          businessId: businessId, userId: userId, pin: pin);
      _business = biz;
      _status = AuthStatus.authenticated;
      await _hydrateAfterLogin();
      // NP-201: staff PIN login is THE path where a wrong role is dangerous
      // (a cook getting the owner UI). Hydrate role + permissions straight
      // from /auth/me before we hand control to HomeScreen, so the first
      // frame is never rendered off a partial login payload. Best-effort:
      // refreshPlan() swallows network errors, and a failure now leaves the
      // fail-closed role from the login response (or '' → least privilege).
      await refreshPlan();
      _loading = false; notifyListeners();
      _postLogin();
      return true;
    } catch (e) {
      _error = e.toString().contains('Invalid PIN')
          ? 'Wrong PIN — please try again'
          : 'Sign-in failed: $e';
      _loading = false; notifyListeners();
      return false;
    }
  }

  String _humanizePwd(String raw) {
    if (raw.contains('already registered')) return 'Email already registered. Try logging in.';
    if (raw.contains('Invalid email or password')) return 'Wrong email or password';
    if (raw.contains('at least 8')) return 'Password must be at least 8 characters';
    if (raw.contains('SocketException') || raw.contains('Network')) {
      return 'No internet — check your connection';
    }
    return raw.replaceAll('ApiException(null): ', '').replaceAll('Exception: ', '');
  }

  /// Persist the owner's declared GST scheme (backend migration 092).
  ///
  /// Kept out of [updateBusiness] deliberately. That method diffs a whole
  /// Business against the cached one and sends what changed, which is right
  /// for a settings form; this is a single compliance answer that has to land
  /// on the server at the moment it is given — the setup wizard writes it
  /// BEFORE its menu step, so a starter menu loaded thirty seconds later gets
  /// the correct GST slab on every item rather than the 5% default.
  ///
  /// `scheme` is one of 'regular' | 'composition' | 'specified_premises';
  /// anything else is refused here rather than by the backend's Joi validator.
  /// Returns true when the server accepted it.
  Future<bool> setGstScheme(String scheme) async {
    const allowed = {'regular', 'composition', 'specified_premises'};
    if (!allowed.contains(scheme)) return false;
    final cur = _business;
    if (cur == null) return false;
    if (cur.gstScheme == scheme) return true; // already what the server holds
    try {
      final resp =
          await ApiService.instance.updateMyBusiness({'gst_scheme': scheme});
      final updated = resp['business'];
      _business = updated is Map<String, dynamic>
          ? Business.fromMap(updated)
          : cur.copyWith(gstScheme: scheme);
      notifyListeners();
      return true;
    } catch (e) {
      _error = _humanize(e.toString());
      notifyListeners();
      return false;
    }
  }

  /// Persist edits to the signed-in user's active business and refresh
  /// the local cache from the server's response. Returns true on success.
  /// Earlier this only updated local state — meaning the dashboard
  /// never saw the change. Now hits PATCH /v1/auth/me.
  Future<bool> updateBusiness(Business b) async {
    final cur = _business;
    if (cur == null) return false;
    // Send only the fields that actually changed, in snake_case to
    // match the backend Joi validator (validators/authController.js).
    final patch = <String, dynamic>{};
    void put(String key, String? next, String? prev) {
      if ((next ?? '') != (prev ?? '')) patch[key] = next ?? '';
    }
    if (b.name != cur.name) patch['name'] = b.name;
    put('phone',        b.phone,       cur.phone);
    put('city',         b.city,        cur.city);
    put('gstin',        b.gstin,       cur.gstin);
    put('address',      b.address,     cur.address);
    put('upi_id',       b.upiId,       cur.upiId);
    put('bank_account', b.bankAccount, cur.bankAccount);
    put('bank_ifsc',    b.bankIfsc,    cur.bankIfsc);
    put('logo_url',     b.logoUrl,     cur.logoUrl);
    if (patch.isEmpty) return true; // nothing to do

    try {
      final resp = await ApiService.instance.updateMyBusiness(patch);
      final updated = resp['business'];
      if (updated is Map<String, dynamic>) {
        _business = Business.fromMap(updated);
      } else {
        // Backend echoed something unexpected — fall back to local merge
        _business = b;
      }
      notifyListeners();
      return true;
    } catch (e) {
      _error = _humanize(e.toString());
      notifyListeners();
      return false;
    }
  }

  Future<void> logout() async {
    // PhonePe-style: if an MPIN is set, "sign out" LOCKS to the MPIN screen
    // (keeps the refresh token + MPIN) so the owner can quick-login again.
    // A true account switch happens via "Use another account" on the lock
    // screen (signOutFromLock → logoutFull).
    if (_mpinSet) {
      _status = AuthStatus.locked;
      notifyListeners();
      return;
    }
    await AuthService.instance.logout();
    _business = null;
    _role = null;
    _permissions = const [];
    // NP-114: drop the old account's plan from RAM (see signOutFromLock).
    _plan = PlanInfo.unknown();
    _planFetchedAt = null;
    UpsellHints.instance.clear();
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  /// Login-screen "Log in with MPIN" — jump to the lock screen if an MPIN is
  /// configured on this device.
  void lockSession() {
    if (_mpinSet) {
      _status = AuthStatus.locked;
      notifyListeners();
    }
  }

  String _humanize(String raw) {
    if (raw.contains('cancel')) return 'Sign-in cancelled';
    if (raw.contains('network') || raw.contains('SocketException')) {
      return 'No internet — please check your connection';
    }
    return 'Sign-in failed. Please try again.';
  }
}
