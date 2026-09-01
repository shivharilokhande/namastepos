// NamastePOS - Auth service (Google Sign-In)
//
// Flow:
//   1. GoogleSignIn.signIn() → opens Google account picker on device
//   2. Get idToken from GoogleSignInAuthentication
//   3. POST /auth/google {idToken} → backend verifies via google-auth-library,
//      issues JWT + refresh token + Business record
//   4. We persist tokens in secure storage; Business in regular prefs.
//
// Demo fallback (when --dart-define DEMO_MODE=true OR backend unreachable):
// we synthesize a local Business so the app still works offline.

import 'dart:convert';

import 'package:flutter/foundation.dart' show kDebugMode;

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:uuid/uuid.dart';

import '../models/business.dart';
import 'api_service.dart';

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  final _api = ApiService.instance;
  // Strix I-2 (2026-08-31): iOS keychain this-device-only (see api_service.dart).
  final _secure = const FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
      synchronizable: false,
    ),
  );
  static const _kBusiness = 'ff_business';

  // Web Client ID from Google Cloud Console (the SAME id the backend lists in
  // GOOGLE_CLIENT_IDS). Passing it as serverClientId makes Google issue an
  // idToken whose audience is THIS web client — which the backend allow-list
  // definitely accepts (it's the same client the dashboard logs in with). We
  // default to it so RELEASE builds (which don't pass --dart-define) still get
  // an accepted-audience token on iOS AND Android, instead of falling back to
  // the platform client and depending on the exact server allow-list. Override
  // at build time if ever needed:
  //   flutter build ios --dart-define=GOOGLE_WEB_CLIENT_ID=xxx.apps.googleusercontent.com
  static const String _webClientId = String.fromEnvironment(
    'GOOGLE_WEB_CLIENT_ID',
    defaultValue:
        '971798684721-apiucda0kik6dhd5dmpr8ne4lkdthr13.apps.googleusercontent.com',
  );

  // Hardcode-audit fix (2026-08-24): DEMO_MODE is now physically unable
  // to survive into a release artifact — it's AND-ed with kDebugMode, so
  // a release build with --dart-define=DEMO_MODE=true still gets a real
  // authenticated session, never the synthetic local one.
  static const bool _demoModeDefine = bool.fromEnvironment(
    'DEMO_MODE', defaultValue: false,
  );
  static final bool _demoModeForced = _demoModeDefine && kDebugMode;

  // google_sign_in 7.x is a full API rewrite:
  //   - GoogleSignIn(...) constructor gone → use GoogleSignIn.instance
  //     (singleton) and initialize() once.
  //   - signIn()/signInSilently() removed → authenticate() throws
  //     GoogleSignInException on cancel instead of returning null.
  //   - GoogleSignInAuthentication.idToken/accessToken are now sync
  //     properties (no `await account.authentication`).
  //   - currentUser gone → subscribe to authenticationEvents if needed.
  bool _googleInitialised = false;
  String? _lastEmail;    // stashed so demo fallback can reuse it

  GoogleSignIn get _google => GoogleSignIn.instance;

  Future<void> _ensureGoogleInitialised() async {
    if (_googleInitialised) return;
    await _google.initialize(
      // On iOS the serverClientId triggers issuance of an idToken whose
      // audience matches the web client (which the backend verifies).
      serverClientId: _webClientId.isEmpty ? null : _webClientId,
    );
    _googleInitialised = true;
  }

  /// Opens Google account picker. Returns the Google idToken on success.
  /// Returns null if the user cancels the picker.
  Future<String?> _getIdTokenFromGoogle() async {
    await _ensureGoogleInitialised();
    try {
      // authenticate() throws when the user cancels (v7 change).
      final account = await _google.authenticate(
        scopeHint: const ['email', 'profile'],
      );
      _lastEmail = account.email;
      // In v7 `authentication` is a synchronous property.
      return account.authentication.idToken;
    } on GoogleSignInException catch (e) {
      // Cancel / no-account cases return null so callers can distinguish
      // them from real failures.
      if (e.code == GoogleSignInExceptionCode.canceled) return null;
      rethrow;
    }
  }

  /// One-tap Google login. Returns the [Business] account on success.
  ///
  /// If the backend is unreachable AND demo mode is forced (or no Google
  /// account is configured on device), we fall back to a local demo business
  /// so the rest of the app still works.
  Future<Business> signInWithGoogle() async {
    String? idToken;
    try {
      idToken = await _getIdTokenFromGoogle();
    } catch (e) {
      // Surface this; the caller will show an error toast.
      if (_demoModeForced) {
        return _demoBusiness('demo@namastepos.in');
      }
      rethrow;
    }

    if (idToken == null) {
      // User cancelled the picker.
      throw Exception('Sign-in cancelled');
    }

    try {
      final data = await _api.signInWithGoogle(idToken);
      final jwt = data['token'] as String?;
      final refresh = data['refreshToken'] as String?;
      if (jwt != null && refresh != null) {
        await _api.setTokens(jwt: jwt, refresh: refresh);
      }
      final business = Business.fromMap(data['business'] as Map<String, dynamic>);
      await _persistBusiness(business);
      // Persist plan + role + perms same as email/PIN paths so bootstrap
      // sees them on next cold start.
      final p = data['plan'];
      if (p != null) await _secure.write(key: _kPlan, value: jsonEncode(p));
      final role = data['role'] as String?;
      if (role != null) await _secure.write(key: _kRole, value: role);
      final perms = data['permissions'];
      if (perms is List) {
        await _secure.write(key: _kPerms, value: jsonEncode(perms));
      }
      return business;
    } on ApiException {
      // Bug fix (2026-08-20): the earlier "fall back to Demo Stall on
      // ANY ApiException" hid real errors — a 401 / audience-mismatch /
      // network drop looked identical to a fresh sign-in, leaving the
      // user staring at a demo business that doesn't map to their real
      // data on the server. Now we only fall back when DEMO_MODE was
      // explicitly requested at build time; everything else surfaces
      // so the login screen can show the actual reason.
      if (_demoModeForced) {
        final email = _lastEmail ?? 'demo@namastepos.in';
        return _demoBusiness(email);
      }
      rethrow;
    }
  }

  /// DEV-ONLY email-based sign-in. Hits POST /auth/dev-login on the backend
  /// (which itself is gated by FF_DEV_LOGIN=1 in env). No Google involvement.
  Future<Business> signInWithEmail(String email, {String? name}) async {
    final data = await _api.devLogin(email, name: name);
    final jwt = data['token'] as String?;
    final refresh = data['refreshToken'] as String?;
    if (jwt != null && refresh != null) {
      await _api.setTokens(jwt: jwt, refresh: refresh);
    }
    final business = Business.fromMap(data['business'] as Map<String, dynamic>);
    await _persistBusiness(business);
    // Stash plan separately so AuthProvider can pull it on next read.
    final p = data['plan'];
    if (p != null) {
      await _secure.write(key: _kPlan, value: jsonEncode(p));
    }
    return business;
  }

  /// Hits /auth/me to refresh user/business/plan from the backend. Also
  /// re-caches the plan, role, and permissions to secure storage so the
  /// next cold-start has them immediately.
  ///
  /// Push 16i — also re-caches role + permissions so the captain's
  /// drawer reflects owner-side permission edits without a sign-out.
  Future<Map<String, dynamic>?> fetchMe() async {
    final data = await _api.me();
    final p = data['plan'];
    if (p != null) {
      await _secure.write(key: _kPlan, value: jsonEncode(p));
    }
    final role = data['role'] as String?;
    if (role != null) {
      await _secure.write(key: _kRole, value: role);
    }
    final perms = data['permissions'];
    if (perms is List) {
      await _secure.write(key: _kPerms, value: jsonEncode(perms));
    }
    return data;
  }

  /// Returns the cached plan from secure storage if any. Used by AuthProvider
  /// during bootstrap so feature flags work before /auth/me responds.
  Future<Map<String, dynamic>?> cachedPlan() async {
    final raw = await _secure.read(key: _kPlan);
    if (raw == null || raw.isEmpty) return null;
    try { return jsonDecode(raw) as Map<String, dynamic>; }
    catch (_) { return null; }
  }
  static const _kPlan = 'ff_plan';

  /// Email + password registration (Push 4). Persists tokens, business,
  /// plan summary — same as Google/dev paths.
  Future<Business> registerWithPassword({
    required String email,
    required String password,
    String? name,
    String? businessName,
  }) async {
    final data = await _api.register(
      email: email, password: password, name: name, businessName: businessName);
    return _persistSessionPayload(data);
  }

  Future<Business> loginWithPassword(String email, String password) async {
    final data = await _api.passwordLogin(email: email, password: password);
    return _persistSessionPayload(data);
  }

  /// PIN-based staff sign-in (Push 14b). Same payload contract as Google
  /// / password — token, refreshToken, user, business, plan, role.
  Future<Business> signInWithPin({
    required String businessId,
    required String userId,
    required String pin,
  }) async {
    final data = await _api.pinLogin(
        businessId: businessId, userId: userId, pin: pin);
    return _persistSessionPayload(data);
  }

  /// Shared post-login persistence (token + biz + plan).
  Future<Business> _persistSessionPayload(Map<String, dynamic> data) async {
    final jwt = data['token'] as String?;
    final refresh = data['refreshToken'] as String?;
    if (jwt != null && refresh != null) {
      await _api.setTokens(jwt: jwt, refresh: refresh);
    }
    final business = Business.fromMap(data['business'] as Map<String, dynamic>);
    await _persistBusiness(business);
    final p = data['plan'];
    if (p != null) await _secure.write(key: _kPlan, value: jsonEncode(p));
    // Push 14b: cache role for the drawer/nav role-gating to consume on
    // cold start. The role field is the authoritative source of what
    // screens this user can see.
    final role = data['role'] as String?;
    if (role != null) await _secure.write(key: _kRole, value: role);
    // Push 14c: cache the permission list. Mobile drawer + bottom nav
    // gate on this when present (falls back to role defaults otherwise).
    final perms = data['permissions'];
    if (perms is List) {
      await _secure.write(key: _kPerms, value: jsonEncode(perms));
    }
    return business;
  }

  static const _kRole = 'ff_role';
  static const _kPerms = 'ff_perms';
  Future<String?> cachedRole() => _secure.read(key: _kRole);
  Future<List<String>?> cachedPermissions() async {
    final raw = await _secure.read(key: _kPerms);
    if (raw == null || raw.isEmpty) return null;
    try {
      final list = jsonDecode(raw) as List;
      return list.map((e) => e.toString()).toList();
    } catch (_) { return null; }
  }

  Future<Business> _demoBusiness(String email) async {
    final demo = Business(
      id: const Uuid().v4(),
      name: 'Demo Stall',
      phone: '',
      city: 'Mumbai',
      category: 'tea-stall',
      createdAt: DateTime.now(),
    );
    await _persistBusiness(demo);
    return demo;
  }

  Future<Business?> cachedBusiness() async {
    final raw = await _secure.read(key: _kBusiness);
    if (raw == null || raw.isEmpty) return null;
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      return Business.fromMap(map);
    } catch (_) {
      return null;
    }
  }

  Future<void> logout() async {
    // v7: signOut/disconnect still exist on the singleton. Both are
    // idempotent and can throw when initialize() was never called (e.g.
    // dev-login path), so swallow.
    try { if (_googleInitialised) await _google.signOut(); } catch (_) {}
    try { if (_googleInitialised) await _google.disconnect(); } catch (_) {}
    await _api.clearTokens();
    // Push 14b: keep _kBusiness around after sign-out. The cached business
    // ID is what powers the "Sign in as staff (PIN)" link on the login
    // screen — clearing it on sign-out left staff with no way to log
    // back in on the same device after the owner signed off. Tokens and
    // plan are cleared (security); only the business identifier stays.
    await _secure.delete(key: _kRole);
    await _secure.delete(key: _kPerms);
    // NOTE: MPIN is intentionally NOT cleared here. Normal sign-out keeps the
    // MPIN + refresh token so the owner can quick-login again (AuthProvider
    // routes a MPIN-enabled sign-out to the lock screen). Only a full
    // account switch (logoutFull → "Use another account") wipes the MPIN.
    // _kPlan stays cached so the next user's plan check works offline;
    // it gets overwritten on the next successful login anyway.
  }

  /// Hard reset — wipes EVERYTHING including the cached business. Used
  /// when the user wants to switch businesses, not just users.
  Future<void> logoutFull() async {
    await logout();
    await _secure.delete(key: _kBusiness);
    await _secure.delete(key: _kPlan);
    // Full account switch — now wipe the MPIN too.
    await clearMpin();
  }

  Future<void> _persistBusiness(Business b) async {
    await _secure.write(key: _kBusiness, value: jsonEncode(b.toMap()));
  }

  // ── Session validation ────────────────────────────────────────────────
  /// Silently confirms we still have a usable session by minting a fresh
  /// access token from the stored refresh token. Returns false if the
  /// refresh token is missing/expired (→ the app should show login).
  Future<bool> ensureValidSession() => _api.ensureFreshToken();

  /// FB-02: session check that returns null when offline (keep session) vs
  /// false when the server rejects the token (log out). See ApiService.
  Future<bool?> tryRefreshSession() => _api.tryRefreshSession();

  // ── Owner MPIN (PhonePe-style quick unlock) ───────────────────────────
  // The MPIN is a convenience lock on top of the real credential (the
  // refresh token). We store only a salted SHA-256 of it in the OS-encrypted
  // keychain — never the PIN itself.
  static const _kMpin = 'ff_mpin_hash';
  static const _kMpinSalt = 'ff_mpin_salt';

  String _hashMpin(String pin, String salt) =>
      sha256.convert(utf8.encode('$salt::$pin')).toString();

  Future<bool> hasMpin() async {
    final h = await _secure.read(key: _kMpin);
    return h != null && h.isNotEmpty;
  }

  Future<void> setMpin(String pin) async {
    var salt = await _secure.read(key: _kMpinSalt);
    if (salt == null || salt.isEmpty) {
      salt = const Uuid().v4();
      await _secure.write(key: _kMpinSalt, value: salt);
    }
    await _secure.write(key: _kMpin, value: _hashMpin(pin, salt));
  }

  Future<bool> verifyMpin(String pin) async {
    final stored = await _secure.read(key: _kMpin);
    final salt = await _secure.read(key: _kMpinSalt);
    if (stored == null || salt == null) return false;
    return _hashMpin(pin, salt) == stored;
  }

  Future<void> clearMpin() async {
    await _secure.delete(key: _kMpin);
    await _secure.delete(key: _kMpinSalt);
    await _secure.delete(key: _kMpinPromptOff);
    await clearMpinFails();
  }

  // Review 2026-08-28: persist the wrong-MPIN counter so relaunching the app
  // can't reset it — otherwise the 4-digit lock is brute-forceable in batches
  // of <5 across restarts.
  static const _kMpinFails = 'ff_mpin_fails';
  Future<int> mpinFails() async =>
      int.tryParse(await _secure.read(key: _kMpinFails) ?? '0') ?? 0;
  Future<int> bumpMpinFails() async {
    final n = (await mpinFails()) + 1;
    await _secure.write(key: _kMpinFails, value: '$n');
    return n;
  }
  Future<void> clearMpinFails() async => _secure.delete(key: _kMpinFails);

  // One-time "set an MPIN?" prompt suppression so we don't nag every launch.
  static const _kMpinPromptOff = 'ff_mpin_prompt_off';
  Future<bool> mpinPromptDismissed() async =>
      (await _secure.read(key: _kMpinPromptOff)) == '1';
  Future<void> dismissMpinPrompt() async =>
      _secure.write(key: _kMpinPromptOff, value: '1');
}
