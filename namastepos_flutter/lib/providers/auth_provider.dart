// NamastePOS - Auth state provider (Google Sign-In)

import 'package:flutter/foundation.dart';

import '../models/business.dart';
import '../models/plan_info.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/notification_service.dart';

enum AuthStatus { unknown, authenticated, unauthenticated, locked }

class AuthProvider extends ChangeNotifier {
  AuthProvider() {
    // When any request 401s and the refresh token is dead, fall straight to
    // the login screen instead of letting an "authentication" error surface
    // on an inner screen.
    ApiService.instance.onAuthExpired = _onAuthExpired;
    _bootstrap();
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
  PlanInfo _plan = PlanInfo.starterDefault();
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
  String get role => _role ?? 'business_owner';
  /// Push 14c — explicit permission list for the current user. Owner gets
  /// an empty list here and code should special-case `role == business_owner`
  /// to mean "all permissions". For staff, this is the authoritative
  /// allowlist (overrides role defaults if non-empty).
  List<String> get permissions => _permissions;
  bool canDo(String permission) =>
      role == 'business_owner' || _permissions.contains(permission);
  bool get loading => _loading;
  String? get error => _error;

  /// Convenience for UI code: `if (auth.has('kds')) { ... }`.
  bool has(String featureKey) => _plan.has(featureKey);

  void setPlan(PlanInfo p) { _plan = p; notifyListeners(); }

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
      }
      if (changed) notifyListeners();
    } catch (_) { /* swallow — non-fatal */ }
  }

  Future<void> _restoreCached() async {
    final p = await AuthService.instance.cachedPlan();
    if (p != null) _plan = PlanInfo.fromMap(p);
    _role = await AuthService.instance.cachedRole();
    _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
    // ignore: unawaited_futures
    NotificationService.instance.registerFcmToken(biz.id).catchError((e) {
      debugPrint('[auth] fcm register failed (non-fatal): $e');
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
      final p = await AuthService.instance.cachedPlan();
      if (p != null) _plan = PlanInfo.fromMap(p);
      _role = await AuthService.instance.cachedRole();
      _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
      final p = await AuthService.instance.cachedPlan();
      if (p != null) _plan = PlanInfo.fromMap(p);
      _role = await AuthService.instance.cachedRole();
      _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
      final p = await AuthService.instance.cachedPlan();
      if (p != null) _plan = PlanInfo.fromMap(p);
      _role = await AuthService.instance.cachedRole();
      _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
      final p = await AuthService.instance.cachedPlan();
      if (p != null) _plan = PlanInfo.fromMap(p);
      _role = await AuthService.instance.cachedRole();
      _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
      final p = await AuthService.instance.cachedPlan();
      if (p != null) _plan = PlanInfo.fromMap(p);
      _role = await AuthService.instance.cachedRole();
      _permissions = await AuthService.instance.cachedPermissions() ?? const [];
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
