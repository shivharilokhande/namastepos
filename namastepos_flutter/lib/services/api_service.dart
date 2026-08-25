// NamastePOS - API client (Dio-based, with JWT refresh + offline tolerance)

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiException implements Exception {
  final int? statusCode;
  final String message;
  ApiException(this.message, [this.statusCode]);
  @override
  String toString() => 'ApiException($statusCode): $message';
}

class ApiService {
  ApiService._() {
    _dio = Dio(BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Content-Type': 'application/json'},
    ));
    _dio.interceptors.add(_authInterceptor());
  }

  static final ApiService instance = ApiService._();

  // Override this at build-time via --dart-define=API_URL=https://...
  static const String baseUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'https://api.namastepos.in/v1',
  );

  late final Dio _dio;
  /// Bug fix: a separate naked Dio (no auth interceptor) is used for the
  /// /auth/refresh call. The previous implementation reused _dio, which
  /// re-attached the expired Bearer token to refresh requests; if /auth/refresh
  /// itself returned 401 (revoked refresh token), the interceptor recursed
  /// indefinitely retrying with the same broken token.
  late final Dio _refreshDio = Dio(BaseOptions(
    baseUrl: baseUrl,
    connectTimeout: const Duration(seconds: 12),
    receiveTimeout: const Duration(seconds: 20),
    headers: {'Content-Type': 'application/json'},
  ));
  /// Single-flight refresh lock — prevents N parallel 401s from triggering
  /// N parallel refresh calls (which would race + revoke each other's tokens).
  Future<bool>? _inflightRefresh;
  Dio get dio => _dio;
  final _secure = const FlutterSecureStorage();

  static const _tokenKey = 'ff_jwt';
  static const _refreshKey = 'ff_refresh';

  Future<void> setTokens({required String jwt, required String refresh}) async {
    await _secure.write(key: _tokenKey, value: jwt);
    await _secure.write(key: _refreshKey, value: refresh);
  }

  Future<void> clearTokens() async {
    await _secure.delete(key: _tokenKey);
    await _secure.delete(key: _refreshKey);
  }

  Future<String?> get token => _secure.read(key: _tokenKey);
  Future<String?> get refreshToken => _secure.read(key: _refreshKey);

  InterceptorsWrapper _authInterceptor() {
    return InterceptorsWrapper(
      onRequest: (options, handler) async {
        final t = await token;
        if (t != null && t.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $t';
        }
        handler.next(options);
      },
      onError: (e, handler) async {
        // Don't try to refresh on the refresh endpoint itself, otherwise
        // we recurse forever when the refresh token is revoked.
        final path = e.requestOptions.path;
        final isRefresh = path.contains('/auth/refresh');
        if (e.response?.statusCode == 401 && !isRefresh) {
          final ok = await _refresh();
          if (ok) {
            try {
              final req = e.requestOptions;
              final t = await token;
              req.headers['Authorization'] = 'Bearer $t';
              final resp = await _dio.fetch(req);
              return handler.resolve(resp);
            } catch (_) {/* fall through */}
          }
        }
        handler.next(e);
      },
    );
  }

  Future<bool> _refresh() {
    // Single-flight: if a refresh is already in progress, share its result
    // with every caller. Prevents N concurrent 401s each starting their own
    // refresh and revoking each other's freshly-issued tokens.
    return _inflightRefresh ??= _refreshOnce().whenComplete(() {
      _inflightRefresh = null;
    });
  }

  Future<bool> _refreshOnce() async {
    final r = await refreshToken;
    if (r == null) {
      // No refresh token persisted — user effectively logged out.
      debugPrint('AUTH: refresh skipped — no refresh token in secure storage');
      return false;
    }
    try {
      // Use the naked _refreshDio (no auth interceptor) so the expired
      // Bearer is not attached to the refresh call, and so a 401 from
      // /auth/refresh doesn't re-enter this function.
      final resp = await _refreshDio.post('/auth/refresh', data: {'refreshToken': r});
      final newJwt = resp.data['token'] as String?;
      final newRefresh = resp.data['refreshToken'] as String?;
      if (newJwt == null) {
        debugPrint('AUTH: refresh response missing "token" field');
        return false;
      }
      await _secure.write(key: _tokenKey, value: newJwt);
      if (newRefresh != null) {
        await _secure.write(key: _refreshKey, value: newRefresh);
      }
      return true;
    } catch (e) {
      debugPrint('AUTH: refresh failed: $e');
      // If the refresh token itself is dead, clear it so subsequent
      // requests bail immediately instead of looping.
      if (e is DioException && e.response?.statusCode == 401) {
        await clearTokens();
      }
      return false;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  /// Exchange a Google ID token for a NamastePOS JWT + refresh + Business.
  Future<Map<String, dynamic>> signInWithGoogle(String idToken) async {
    final r = await _wrap(() => _dio.post('/auth/google', data: {'idToken': idToken}));
    return r as Map<String, dynamic>;
  }

  /// DEV-ONLY: skip Google verification. Backend must have FF_DEV_LOGIN=1
  /// or this returns 404. Used for macOS desktop builds where Google OAuth
  /// isn't wired up.
  Future<Map<String, dynamic>> devLogin(String email, {String? name}) async {
    final r = await _wrap(() => _dio.post('/auth/dev-login', data: {
      'email': email,
      if (name != null) 'name': name,
    }));
    return r as Map<String, dynamic>;
  }

  /// Email + password registration (Push 4). Returns the same session
  /// payload shape as Google/dev — token, refreshToken, user, business, plan.
  Future<Map<String, dynamic>> register({
    required String email,
    required String password,
    String? name,
    String? businessName,
  }) async {
    final r = await _wrap(() => _dio.post('/auth/register', data: {
      'email': email,
      'password': password,
      if (name != null) 'name': name,
      if (businessName != null) 'businessName': businessName,
    }));
    return r as Map<String, dynamic>;
  }

  /// Email + password login. Same payload shape.
  Future<Map<String, dynamic>> passwordLogin({
    required String email,
    required String password,
  }) async {
    final r = await _wrap(() => _dio.post('/auth/login', data: {
      'email': email,
      'password': password,
    }));
    return r as Map<String, dynamic>;
  }

  /// (Kept for later) phone+OTP path — currently unused.
  Future<Map<String, dynamic>> requestOtp(String phone) async {
    final r = await _wrap(() => _dio.post('/auth/request-otp', data: {'phone': phone}));
    return r as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> verifyOtp({
    required String phone,
    required String code,
    String? verificationSid,
  }) async {
    final r = await _wrap(() => _dio.post('/auth/verify-otp', data: {
          'phone': phone,
          'code': code,
          'verificationSid': verificationSid,
        }));
    return r as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> me() async {
    final r = await _wrap(() => _dio.get('/auth/me'));
    return r as Map<String, dynamic>;
  }

  /// PATCH /auth/me — update the signed-in user's active business.
  /// Accepts a subset of fields (name, phone, city, gstin, address,
  /// upi_id, bank_account, bank_ifsc, logo_url, onboarded). Backend
  /// echoes the updated business object.
  Future<Map<String, dynamic>> updateMyBusiness(Map<String, dynamic> patch) async {
    final r = await _wrap(() => _dio.patch('/auth/me', data: patch));
    return r as Map<String, dynamic>;
  }

  // ── Menu ─────────────────────────────────────────────────────────────────
  Future<List<dynamic>> listMenu(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/menu'));
    return (r as Map)['items'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> upsertMenuItem(
      String businessId, Map<String, dynamic> body, {String? id}) async {
    final r = await _wrap(() => id == null
        ? _dio.post('/businesses/$businessId/menu', data: body)
        : _dio.put('/businesses/$businessId/menu/$id', data: body));
    return r as Map<String, dynamic>;
  }

  Future<void> deleteMenuItem(String businessId, String id) async {
    await _wrap(() => _dio.delete('/businesses/$businessId/menu/$id'));
  }

  // ── Orders ───────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> createOrder(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post('/businesses/$businessId/orders', data: body));
    return r as Map<String, dynamic>;
  }

  /// List orders. Pass `groupBy: 'session'` to collapse multi-KOT
  /// bills into one row per table session (one bill per dining party).
  /// Kitchen views (KOT/KDS) should leave groupBy null so each KOT
  /// stays its own ticket.
  Future<List<dynamic>> listOrders(String businessId,
      {DateTime? date, String? status, String? groupBy,
       int? limit, int? offset}) async {
    // P1 fix (2026-08-22): backend caps at 100 by default. On a busy
    // lunch service, dine-in + takeaway easily crosses 200 orders and
    // the older ones vanished from the mobile Orders tab. Pass a big
    // limit by default so today's list is complete; callers can override
    // when they need proper pagination.
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/orders',
          queryParameters: {
            if (date != null) 'date': date.toIso8601String().substring(0, 10),
            if (status != null) 'status': status,
            if (groupBy != null) 'groupBy': groupBy,
            // P0 fix (2026-08-22): backend Joi caps limit at 500 and
            // rejects (400) anything higher — 1000 broke every orders
            // fetch. 500 is the server-side max.
            'limit': limit ?? 500,
            if (offset != null) 'offset': offset,
          },
        ));
    return (r as Map)['orders'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> updateOrderStatus(
      String businessId, String orderId, String status) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/orders/$orderId/status',
          data: {'status': status},
        ));
    return r as Map<String, dynamic>;
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> createExpense(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post('/businesses/$businessId/expenses', data: body));
    return r as Map<String, dynamic>;
  }

  Future<List<dynamic>> listExpenses(String businessId,
      {DateTime? start, DateTime? end}) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/expenses',
          queryParameters: {
            if (start != null) 'startDate': start.toIso8601String().substring(0, 10),
            if (end != null) 'endDate': end.toIso8601String().substring(0, 10),
          },
        ));
    return (r as Map)['expenses'] as List? ?? const [];
  }

  // ── Billing / Subscription ───────────────────────────────────────────────
  Future<Map<String, dynamic>?> getSubscription(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/billing'));
    return (r as Map<String, dynamic>)['subscription'] as Map<String, dynamic>?;
  }

  Future<List<dynamic>> listPlans() async {
    final r = await _wrap(() => _dio.get('/plans'));
    return (r as Map)['plans'] as List? ?? const [];
  }

  // ── Staff CRUD (Push 14a) ─────────────────────────────────────────────
  // Direct PIN-based staff management, used by the in-app Staff screen.
  // Separate from the email-invite flow on /staff/invites which the
  // dashboard uses.
  Future<List<dynamic>> listStaff(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/staff/pin'));
    return (r as Map)['staff'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> createStaff(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/staff/pin',
          data: body,
        ));
    return (r as Map)['staff'] as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> updateStaff(
      String businessId, String userId, Map<String, dynamic> patch) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/staff/pin/$userId',
          data: patch,
        ));
    return (r as Map)['staff'] as Map<String, dynamic>;
  }

  // Push 14e — auto-comply with plan limit. Server deactivates excess
  // non-owner staff, keeping the earliest joined N. Returns the result
  // ({ cap, deactivated, deactivatedUserIds }).
  Future<Map<String, dynamic>> complyStaffLimit(String businessId) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/staff/pin/comply-limit',
        ));
    return (r as Map).cast<String, dynamic>();
  }

  // PIN-based staff login. Returns the same session payload shape as
  // Google/password (token, refreshToken, user, business, plan, role).
  Future<Map<String, dynamic>> pinLogin({
    required String businessId,
    required String userId,
    required String pin,
  }) async {
    final r = await _wrap(() => _dio.post('/auth/pin-login', data: {
          'businessId': businessId,
          'userId': userId,
          'pin': pin,
        }));
    return r as Map<String, dynamic>;
  }

  /// Public (no-auth) staff picker — returns [{userId, role, displayName}]
  /// for active non-owner staff in a business. Used by the mobile PIN
  /// login screen to render the staff list before the user has signed in.
  Future<List<dynamic>> staffPicker(String businessId) async {
    final r = await _wrap(() => _dio.post('/auth/staff-picker', data: {
          'businessId': businessId,
        }));
    return (r as Map)['staff'] as List? ?? const [];
  }

  /// Public (no-auth) phone-first staff login step 1. Given a mobile number,
  /// returns the outlets the staffer can sign into:
  ///   [{userId, businessId, role, displayName, businessName}]
  /// Empty list = no staff account for that number (never errors, so a
  /// stranger can't tell whether a number exists). The caller then collects
  /// the PIN and finishes via [pinLogin] with the chosen outlet's ids. This
  /// removes the old requirement that the OWNER log in first on the device.
  Future<List<dynamic>> staffResolve(String phone) async {
    final r = await _wrap(() => _dio.post('/auth/staff-resolve', data: {
          'phone': phone,
        }));
    return (r as Map)['outlets'] as List? ?? const [];
  }

  /// POST /businesses/:id/billing/change → creates a Razorpay subscription
  /// (or downgrades to free) and returns the checkout payload the SDK needs:
  ///   { subscriptionId, razorpayKeyId, plan: {...},
  ///     checkoutOptions: { key, subscription_id, name, description, theme } }
  ///
  /// Tier-name translation: the mobile UI talks in tier_kind values
  /// (starter / pro / enterprise) but the backend's Joi validator still
  /// expects the legacy `tier` values (free / basic / pro). We map at the
  /// boundary so the rest of the app can stay on the new vocabulary.
  /// See migrations/031_plan_features.sql for the historical mapping.
  Future<Map<String, dynamic>> changePlan(
      String businessId, String tierKind,
      {String billingPeriod = 'monthly'}) async {
    const tierKindToLegacy = {
      'starter': 'free',
      'pro': 'basic',
      'enterprise': 'pro',
    };
    final legacyTier = tierKindToLegacy[tierKind] ?? tierKind;
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/billing/change',
          // 2026-08-24: pass cadence so yearly plans work + the backend can
          // persist billing_period (and pick the right Razorpay plan).
          data: {'tier': legacyTier, 'billingPeriod': billingPeriod},
        ));
    return r as Map<String, dynamic>;
  }

  // Push 15 — Income statement (Schedule III P&L) + tax invoices
  Future<Map<String, dynamic>> incomeStatement(String businessId,
      {required String startDate, required String endDate}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/reports/income-statement',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
    ));
    return (r as Map)['report'] as Map<String, dynamic>;
  }

  /// Download an income statement export. `format` is 'pdf' | 'xlsx' | 'csv'.
  /// Returns the raw bytes so the caller can save it / print it via the
  /// `printing` package on iOS/Android.
  Future<List<int>> incomeStatementExport(String businessId,
      {required String format, required String startDate, required String endDate}) async {
    final response = await _dio.get<List<int>>(
      '/businesses/$businessId/reports/income-statement.$format',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
      options: Options(responseType: ResponseType.bytes),
    );
    return response.data ?? const [];
  }

  // Push 15h — register reports (income / expense / invoice)
  Future<Map<String, dynamic>> incomeRegister(String businessId,
      {required String startDate, required String endDate}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/reports/income-register',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
    ));
    return (r as Map)['report'] as Map<String, dynamic>;
  }
  Future<Map<String, dynamic>> expenseRegister(String businessId,
      {required String startDate, required String endDate}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/reports/expense-register',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
    ));
    return (r as Map)['report'] as Map<String, dynamic>;
  }
  Future<Map<String, dynamic>> invoiceRegister(String businessId,
      {required String startDate, required String endDate}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/reports/invoice-register',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
    ));
    return (r as Map)['report'] as Map<String, dynamic>;
  }
  /// `kind` is 'income' | 'expense' | 'invoice'; `format` is 'pdf' | 'xlsx' | 'csv'.
  Future<List<int>> registerExport(String businessId,
      {required String kind, required String format,
       required String startDate, required String endDate}) async {
    final pathPart = {
      'income':  'income-register',
      'expense': 'expense-register',
      'invoice': 'invoice-register',
    }[kind]!;
    final response = await _dio.get<List<int>>(
      '/businesses/$businessId/reports/$pathPart.$format',
      queryParameters: {'startDate': startDate, 'endDate': endDate},
      options: Options(responseType: ResponseType.bytes),
    );
    return response.data ?? const [];
  }

  Future<List<dynamic>> listTaxInvoices(String businessId,
      {String? startDate, String? endDate}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/tax-invoices',
      queryParameters: {
        if (startDate != null) 'startDate': startDate,
        if (endDate != null) 'endDate': endDate,
      },
    ));
    return (r as Map)['invoices'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> getTaxInvoice(String businessId, String invoiceId) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/tax-invoices/$invoiceId',
    ));
    return (r as Map)['invoice'] as Map<String, dynamic>;
  }

  Future<List<int>> taxInvoicePdf(String businessId, String invoiceId) async {
    final response = await _dio.get<List<int>>(
      '/businesses/$businessId/tax-invoices/$invoiceId/pdf',
      options: Options(responseType: ResponseType.bytes),
    );
    return response.data ?? const [];
  }

  Future<Map<String, dynamic>> cancelTaxInvoice(
      String businessId, String invoiceId, {String? reason}) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/tax-invoices/$invoiceId/cancel',
      data: {if (reason != null) 'reason': reason},
    ));
    return (r as Map)['invoice'] as Map<String, dynamic>;
  }

  // Add-ons
  Future<Map<String, dynamic>> getMyAddons(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/addons'));
    return r as Map<String, dynamic>;
  }

  Future<List<dynamic>> listAddonCatalog() async {
    final r = await _wrap(() => _dio.get('/addons'));
    return (r as Map)['addons'] as List? ?? const [];
  }

  // ── Loyalty / Customer CRM ─────────────────────────────────────────────
  /// Returns {customer, loyaltySettings} — customer may be null (new visitor).
  /// Returns null when the addon isn't subscribed (402).
  Future<Map<String, dynamic>?> lookupCustomer(String businessId, String phone) async {
    try {
      final r = await _wrap(() => _dio.get(
            '/businesses/$businessId/customers/lookup',
            queryParameters: {'phone': phone},
          ));
      return r as Map<String, dynamic>;
    } on ApiException catch (e) {
      if (e.statusCode == 402) return null; // addon not active → silently skip
      rethrow;
    }
  }

  Future<List<dynamic>> listCustomers(String businessId, {String? search}) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/customers',
          queryParameters: { if (search != null) 'search': search },
        ));
    return (r as Map)['customers'] as List? ?? const [];
  }

  // ── KOT + Tables (Sprint 2) ─────────────────────────────────────────────
  Future<List<dynamic>> listFloors(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/ops/floors'));
    return (r as Map)['floors'] as List? ?? const [];
  }

  Future<List<dynamic>> listOpsTables(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/ops/tables'));
    return (r as Map)['tables'] as List? ?? const [];
  }

  /// Alias for symmetry with the dashboard helpers.
  Future<List<dynamic>> listTables(String businessId) => listOpsTables(businessId);

  /// FF-217b — create a floor (Ground floor / First floor / …). Used by
  /// the first-time setup wizard and the tables editor.
  Future<Map<String, dynamic>> createFloor(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/ops/floors',
      data: body,
    ));
    return ((r as Map)['floor'] as Map).cast<String, dynamic>();
  }

  /// FF-217b — create a single table on a floor.
  Future<Map<String, dynamic>> createOpsTable(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/ops/tables',
      data: body,
    ));
    return ((r as Map)['table'] as Map).cast<String, dynamic>();
  }

  /// P0 fix (2026-08-22): register this device's FCM token with the
  /// backend so owner-alert push (FF-248) and order-ready push
  /// (FF-330) actually reach the phone. Called from
  /// NotificationService after the app boots and the user is logged
  /// in. Idempotent — backend upserts by (userId, deviceToken).
  Future<void> registerFcmToken({
    required String businessId,
    required String token,
    String platform = 'android',
  }) async {
    try {
      await _wrap(() => _dio.post(
        '/businesses/$businessId/device-tokens',
        data: {'token': token, 'platform': platform},
      ));
    } catch (e) {
      // Push is best-effort — never fail the caller.
      // ignore: avoid_print
      // ignored
    }
  }

  /// Bug fix (2026-08-22): mobile inventory adjustments were only
  /// written to local SQLite — the server never got the delta so on
  /// restart the stock reverted. Now goes through
  /// PUT /businesses/:id/menu-items/:itemId/stock. Reason must be one
  /// of `purchase | sale | waste | adjustment | returned | transfer`
  /// (backend Joi enum); `adjustment` is the safe default.
  Future<Map<String, dynamic>> adjustStock({
    required String businessId,
    required String menuItemId,
    required double delta,
    String reason = 'adjustment',
    String? note,
  }) async {
    // Route fix (2026-08-23, founder: "inventory refill not saving"):
    // menu routes are mounted at /businesses/:id/menu — the old
    // /menu-items/... path 404'd on every stock adjustment.
    final r = await _wrap(() => _dio.put(
      '/businesses/$businessId/menu/$menuItemId/stock',
      data: {
        'delta': delta,
        'reason': reason,
        if (note != null && note.isNotEmpty) 'note': note,
      },
    ));
    // Backend wraps the row under { item: {...} }
    final item = ((r as Map)['item']) as Map;
    return item.cast<String, dynamic>();
  }

  /// FF-304 mobile refund — partial or full. Backend accepts either
  /// `itemIds` (line-level, safer — amount computed server-side) or
  /// `amountInr` (freeform). `reason` is optional.
  Future<Map<String, dynamic>> refundOrder(
      String businessId, String orderId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/orders/$orderId/refund',
      data: body,
    ));
    return (r as Map).cast<String, dynamic>();
  }

  /// Owner-facing refund HISTORY (2026-08-25). Backs the mobile Refunds
  /// list. Read-only — issuing a refund lives in order_detail_screen via
  /// [refundOrder]. Tenant-scoped by the route; optional `status` filter
  /// (pending|processed|failed|cancelled) and `limit` (backend caps 200).
  Future<List<dynamic>> listRefunds(
      String businessId, {String? status, int? limit}) async {
    final params = <String, dynamic>{};
    if (status != null) params['status'] = status;
    if (limit != null) params['limit'] = limit;
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/refunds',
      queryParameters: params.isEmpty ? null : params,
    ));
    return (r as Map)['refunds'] as List? ?? const [];
  }

  /// FF-903-c mobile tip report — per-server tip totals for a date range.
  /// Backend service reads `startDate` / `endDate` (not from/to).
  Future<List<Map<String, dynamic>>> tipReport(
      String businessId, {String? startDate, String? endDate}) async {
    final params = <String, String>{};
    if (startDate != null) params['startDate'] = startDate;
    if (endDate   != null) params['endDate']   = endDate;
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/tips/report',
      queryParameters: params,
    ));
    final report = ((r as Map)['report']) ?? const [];
    return (report as List)
        .cast<Map>()
        .map((m) => m.cast<String, dynamic>())
        .toList();
  }

  /// FF-402 mobile floor/table editor — rename or reorder a floor.
  Future<Map<String, dynamic>> updateFloor(
      String businessId, String floorId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.put(
      '/businesses/$businessId/ops/floors/$floorId',
      data: body,
    ));
    return ((r as Map)['floor'] as Map).cast<String, dynamic>();
  }

  Future<void> deleteFloor(String businessId, String floorId) async {
    await _wrap(() => _dio.delete(
      '/businesses/$businessId/ops/floors/$floorId',
    ));
  }

  /// Rename / move / resize a table. Fields backed by opsController:
  ///   { floorId?, label?, seats?, xPos?, yPos?, shape? }
  Future<Map<String, dynamic>> updateOpsTable(
      String businessId, String tableId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.put(
      '/businesses/$businessId/ops/tables/$tableId',
      data: body,
    ));
    return ((r as Map)['table'] as Map).cast<String, dynamic>();
  }

  Future<void> deleteOpsTable(String businessId, String tableId) async {
    await _wrap(() => _dio.delete(
      '/businesses/$businessId/ops/tables/$tableId',
    ));
  }

  /// FF-218 — bulk import menu items from a parsed CSV.
  Future<Map<String, dynamic>> bulkImportMenu(
      String businessId, List<Map<String, dynamic>> items) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/menu/bulk',
      data: {'items': items},
    ));
    return r as Map<String, dynamic>;
  }

  // Push 16e — QR token per table (owner-side, for printing).
  Future<String?> qrTokenForTable(String businessId, String tableId) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/ops/tables/$tableId/qr',
    ));
    return (r as Map)['token'] as String?;
  }

  Future<String?> rotateQrToken(String businessId, String tableId) async {
    final r = await _wrap(() => _dio.post(
      '/businesses/$businessId/ops/tables/$tableId/qr/rotate',
    ));
    return (r as Map)['token'] as String?;
  }

  Future<Map<String, dynamic>> openTableSession(
      String businessId, String tableId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/ops/tables/$tableId/sessions',
          data: body,
        ));
    return (r as Map)['session'] as Map<String, dynamic>;
  }

  Future<List<dynamic>> listKotTickets(String businessId, {String? stationId}) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/ops/kot/tickets',
          queryParameters: { if (stationId != null) 'stationId': stationId },
        ));
    return (r as Map)['tickets'] as List? ?? const [];
  }

  // ── Reports ──────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> dailyReport(String businessId, DateTime date) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/reports/daily',
          queryParameters: {'date': date.toIso8601String().substring(0, 10)},
        ));
    return r as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> monthlyReport(
      String businessId, String month) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/reports/monthly',
          queryParameters: {'month': month},
        ));
    return r as Map<String, dynamic>;
  }

  // ── Variants + modifier groups (Batch F) ────────────────────────────────
  Future<List<dynamic>> listVariants(String businessId, String menuItemId) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/menu/$menuItemId/variants',
        ));
    return (r as Map)['variants'] as List? ?? const [];
  }

  /// Editor write-side (Push 7 / variants-and-modifiers on mobile parity).
  ///
  /// Mirrors the dashboard `ffApi.setVariants`. Payload: `{variants:[{id?,label,price,...}]}`.
  /// Backend replaces-all (soft-deactivates anything missing from the list) and
  /// returns the resulting variants. We surface that so callers can re-seed
  /// their local state with the freshly-assigned IDs for newly-inserted rows.
  Future<List<dynamic>> setVariants(
      String businessId, String menuItemId, List<Map<String, dynamic>> variants) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/menu/$menuItemId/variants',
          data: {'variants': variants},
        ));
    return (r as Map)['variants'] as List? ?? const [];
  }

  /// All modifier groups in the catalog (full payload with nested modifiers).
  ///
  /// Hits the sprint1Extras route, NOT /menu/:itemId/modifier-groups — that
  /// per-item endpoint only returns attached IDs.
  Future<List<dynamic>> listAllModifierGroups(String businessId) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/modifier-groups',
        ));
    return (r as Map)['groups'] as List? ?? const [];
  }

  /// IDs of modifier groups currently attached to a menu item.
  Future<List<String>> getItemModifierGroupIds(
      String businessId, String menuItemId) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/menu/$menuItemId/modifier-groups',
        ));
    final ids = (r as Map)['groupIds'] as List? ?? const [];
    return ids.map((e) => e.toString()).toList();
  }

  /// Replace-all attach: writes the given group IDs as this item's modifier
  /// groups. Empty list detaches everything.
  Future<void> setItemModifierGroups(
      String businessId, String menuItemId, List<String> groupIds) async {
    await _wrap(() => _dio.put(
          '/businesses/$businessId/menu/$menuItemId/modifier-groups',
          data: {'groupIds': groupIds},
        ));
  }

  /// Upsert a modifier group (with its nested modifiers). Pass `id` for
  /// edit, omit for create. Backend Joi shape mirrors this exactly:
  ///   { id?, name, kind: 'single_select'|'multi_select',
  ///     minSelect, maxSelect, displayOrder, isActive,
  ///     modifiers: [{ id?, name, priceDeltaInr, displayOrder? }] }
  /// Returns the full refreshed groups list (backend convention).
  Future<List<dynamic>> upsertModifierGroup(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/modifier-groups',
          data: body,
        ));
    return (r as Map)['groups'] as List? ?? const [];
  }

  /// DEPRECATED — name lied (hit per-item endpoint, expected full groups, got
  /// only IDs). Kept as a stub so any stale callers compile; new code should
  /// use [listAllModifierGroups] + [getItemModifierGroupIds] instead.
  @Deprecated('Use listAllModifierGroups + getItemModifierGroupIds')
  Future<List<dynamic>> listModifierGroupsForItem(
      String businessId, String menuItemId) async {
    final groups = await listAllModifierGroups(businessId);
    final attached = (await getItemModifierGroupIds(businessId, menuItemId)).toSet();
    return groups.where((g) => attached.contains((g as Map)['id'])).toList();
  }

  // ── Sessions + bill split (Batch F) ─────────────────────────────────────
  Future<Map<String, dynamic>> sessionDetail(
      String businessId, String sessionId) async {
    // ops.routes mounted at /businesses/:bid/ops — the GET
    // /sessions/:sessionId handler is /ops/sessions/:sessionId.
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/ops/sessions/$sessionId',
        ));
    return (r as Map)['session'] as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> splitBill(
      String businessId, String sessionId, Map<String, dynamic> body) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/sessions/$sessionId/split',
          data: body,
        ));
    return (r as Map)['split'] as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> paySplitInvoice(
      String businessId, String invoiceId, String paymentMethod) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/bill-split-invoices/$invoiceId/pay',
          data: {'paymentMethod': paymentMethod},
        ));
    return (r as Map)['invoice'] as Map<String, dynamic>;
  }

  // ── KDS (Batch F) ───────────────────────────────────────────────────────
  Future<List<dynamic>> listStations(String businessId) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/ops/kot/stations',
        ));
    return (r as Map)['stations'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> markKotTicket(
      String businessId, String ticketId, String status) async {
    final r = await _wrap(() => _dio.put(
          '/businesses/$businessId/kds/tickets/$ticketId/status',
          data: {'status': status},
        ));
    return (r as Map)['ticket'] as Map<String, dynamic>;
  }

  // ── E-invoice + menu sold-out (Batch G) ─────────────────────────────────
  Future<Map<String, dynamic>> generateEinvoice(
      String businessId, String orderId) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/einvoice/$orderId',
        ));
    return (r as Map)['irn'] as Map<String, dynamic>;
  }

  Future<void> setItemSoldOut(
      String businessId, String menuItemId, String mode) async {
    // mode: 'forever' | 'tomorrow_open' | ISO date | 'available'
    // Fix (2026-08-23): backend Joi expects the key `until` (null =
    // make available again) — the old `mode` key failed validation on
    // every toggle ("Validation failed" on device).
    await _wrap(() => _dio.put(
          '/businesses/$businessId/menu/$menuItemId/sold-out',
          data: {'until': mode == 'available' ? null : mode},
        ));
  }

  // ── Reservations + reviews + reservations (Batch H) ─────────────────────
  Future<List<dynamic>> listReservations(String businessId, {String? date}) async {
    final r = await _wrap(() => _dio.get(
          '/businesses/$businessId/reservations',
          queryParameters: { if (date != null) 'date': date },
        ));
    return (r as Map)['reservations'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> upsertReservation(
      String businessId, Map<String, dynamic> body, {String? id}) async {
    final r = id == null
        ? await _wrap(() => _dio.post(
            '/businesses/$businessId/reservations', data: body))
        : await _wrap(() => _dio.put(
            '/businesses/$businessId/reservations/$id', data: body));
    return (r as Map)['reservation'] as Map<String, dynamic>;
  }

  Future<List<dynamic>> listReviews(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/reviews'));
    return (r as Map)['reviews'] as List? ?? const [];
  }

  Future<void> replyReview(String businessId, String reviewId, String reply) async {
    await _wrap(() => _dio.post(
          '/businesses/$businessId/reviews/$reviewId/reply',
          data: {'reply': reply},
        ));
  }

  Future<Map<String, dynamic>> dailyClosing(String businessId, Map<String, dynamic> body) async {
    // Route fix (2026-08-22): backend route is PLURAL /daily-closings —
    // the singular path 404'd ("Route not found") on Close day.
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/daily-closings', data: body));
    // Backend wraps the row: { closing: {...} }
    return ((r as Map)['closing'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<void> logWastage(String businessId, Map<String, dynamic> body) async {
    await _wrap(() => _dio.post(
          '/businesses/$businessId/wastage', data: body));
  }

  /// Wastage report — {summary, byReason, recent[]} (GET /wastage).
  Future<Map<String, dynamic>> wastageReport(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/wastage'));
    return ((r as Map)['report'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  // ── Settings (Batch I) ──────────────────────────────────────────────────
  Future<List<dynamic>> listSurgeRules(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/surge/rules'));
    return (r as Map)['rules'] as List? ?? const [];
  }

  /// Create a surge rule (owner-only). POST /surge/rules.
  Future<void> createSurgeRule(
      String businessId, Map<String, dynamic> body) async {
    await _wrap(() =>
        _dio.post('/businesses/$businessId/surge/rules', data: body));
  }

  /// Update a surge rule (owner-only). PUT /surge/rules/:id.
  Future<void> updateSurgeRule(
      String businessId, String ruleId, Map<String, dynamic> body) async {
    await _wrap(() =>
        _dio.put('/businesses/$businessId/surge/rules/$ruleId', data: body));
  }

  /// Delete a surge rule (owner-only). DELETE /surge/rules/:id.
  Future<void> deleteSurgeRule(String businessId, String ruleId) async {
    await _wrap(
        () => _dio.delete('/businesses/$businessId/surge/rules/$ruleId'));
  }

  Future<List<dynamic>> listMemberships(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/memberships'));
    return (r as Map)['memberships'] as List? ?? const [];
  }

  // Membership plan update + delete (2026-08-24): screen was create+read only.
  Future<Map<String, dynamic>> updateMembership(
      String businessId, String id, Map<String, dynamic> body) async {
    final r = await _wrap(
        () => _dio.put('/businesses/$businessId/memberships/$id', data: body));
    return (r as Map)['membership'] as Map<String, dynamic>;
  }

  Future<void> deleteMembership(String businessId, String id) async {
    await _wrap(() => _dio.delete('/businesses/$businessId/memberships/$id'));
  }

  // ── Food coupons (2026-08-25) ────────────────────────────────────────
  // Owner-managed promo codes for restaurant bills. Mirrors the dashboard
  // CouponsPage. `includeInactive` surfaces soft-deleted (deactivated) rows
  // so their redemption history stays visible.
  Future<List<dynamic>> listFoodCoupons(
      String businessId, {bool includeInactive = false}) async {
    final r = await _wrap(() => _dio.get(
      '/businesses/$businessId/food-coupons',
      queryParameters: includeInactive ? {'includeInactive': 'true'} : null,
    ));
    return (r as Map)['coupons'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> createFoodCoupon(
      String businessId, Map<String, dynamic> body) async {
    final r = await _wrap(
        () => _dio.post('/businesses/$businessId/food-coupons', data: body));
    return (r as Map)['coupon'] as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> updateFoodCoupon(
      String businessId, String id, Map<String, dynamic> body) async {
    final r = await _wrap(() =>
        _dio.put('/businesses/$businessId/food-coupons/$id', data: body));
    return (r as Map)['coupon'] as Map<String, dynamic>;
  }

  // DELETE = soft deactivate on the backend, so redemption history survives.
  Future<void> deleteFoodCoupon(String businessId, String id) async {
    await _wrap(() => _dio.delete('/businesses/$businessId/food-coupons/$id'));
  }

  Future<List<dynamic>> listQrCodes(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/qr-codes'));
    return (r as Map)['qrCodes'] as List? ?? const [];
  }

  Future<Map<String, dynamic>> getBillTemplate(String businessId) async {
    final r = await _wrap(() => _dio.get('/businesses/$businessId/bill-template'));
    return (r as Map)['template'] as Map<String, dynamic>;
  }

  Future<void> saveBillTemplate(String businessId, Map<String, dynamic> body) async {
    await _wrap(() => _dio.put(
          '/businesses/$businessId/bill-template', data: body));
  }

  // ── Driver heartbeat (Batch J) ──────────────────────────────────────────
  Future<void> driverPing(String businessId, String driverId,
      {required double lat, required double lng}) async {
    await _wrap(() => _dio.post(
          '/businesses/$businessId/drivers/$driverId/ping',
          data: {'lat': lat, 'lng': lng},
        ));
  }

  // ── DPDP compliance ──────────────────────────────────────────────────
  //
  // Records a consent grant/withdrawal against the currently signed-in
  // user. The backend appends an immutable row to `consent_events` —
  // it never UPDATEs an existing row, so calling this repeatedly is
  // safe and produces an audit trail.
  //
  // Throws if not signed in (no JWT) — `_wrap` will return a 401.
  Future<Map<String, dynamic>> recordConsent({
    required String consentKey,
    required bool granted,
    String? policyVersion,
    String source = 'mobile_app',
    Map<String, dynamic>? context,
  }) async {
    final r = await _wrap(() => _dio.post('/me/consents', data: {
      'consentKey':    consentKey,
      'granted':       granted,
      if (policyVersion != null) 'policyVersion': policyVersion,
      'source':        source,
      if (context != null) 'context': context,
    }));
    return r as Map<String, dynamic>;
  }

  /// Current state of every consent key for the signed-in user.
  Future<List<dynamic>> currentConsents() async {
    final r = await _wrap(() => _dio.get('/me/consents'));
    return (r as Map<String, dynamic>)['consents'] as List<dynamic>;
  }

  /// File a data subject request (access / correction / erasure / portability).
  Future<Map<String, dynamic>> fileDataSubjectRequest({
    required String requestType,
    Map<String, dynamic>? details,
  }) async {
    final r = await _wrap(() => _dio.post('/me/dsr', data: {
      'requestType': requestType,
      if (details != null) 'details': details,
    }));
    return r as Map<String, dynamic>;
  }

  /// Download the signed-in user's data dump (DPDP portability right).
  /// Returns the raw JSON body — caller decides whether to save to disk.
  Future<Map<String, dynamic>> exportMyData() async {
    final r = await _wrap(() => _dio.get('/me/export'));
    return r as Map<String, dynamic>;
  }

  /// Erase the signed-in user's account. Backend keeps records required
  /// by law (invoices etc.) but anonymises direct identifiers.
  Future<Map<String, dynamic>> eraseMyAccount() async {
    final r = await _wrap(() => _dio.delete('/me/account'));
    return r as Map<String, dynamic>;
  }

  /// Fetch the published grievance officer contact (no auth required).
  Future<Map<String, dynamic>> grievanceOfficer() async {
    final r = await _wrap(() => _dio.get('/compliance/grievance-officer'));
    return r as Map<String, dynamic>;
  }

  /// File a grievance complaint (no auth required).
  Future<Map<String, dynamic>> fileGrievance({
    String? businessId,
    String? complainantName,
    String? complainantEmail,
    String? complainantPhone,
    String category = 'other',
    required String subject,
    required String body,
  }) async {
    final r = await _wrap(() => _dio.post('/compliance/grievance', data: {
      if (businessId != null) 'businessId': businessId,
      if (complainantName != null) 'complainantName': complainantName,
      if (complainantEmail != null) 'complainantEmail': complainantEmail,
      if (complainantPhone != null) 'complainantPhone': complainantPhone,
      'category': category,
      'subject': subject,
      'body': body,
    }));
    return r as Map<String, dynamic>;
  }

  // ── Round-2 mobile parity (2026-08-25) ──────────────────────────────────
  // Wallet-as-tender, split settle + shortfall, join-tables, membership
  // buy/cancel. Mirrors the dashboard's NewOrderDialog / TablesPage local
  // API helpers so mobile and web speak the exact same contracts.

  /// GET /customers/:customerId/wallet → {balanceInr, transactions[]}.
  /// Returns null on 402 (loyalty addon not subscribed) — callers hide the
  /// wallet tender instead of erroring, same as the dashboard does.
  Future<Map<String, dynamic>?> walletFor(
      String businessId, String customerId) async {
    try {
      final r = await _wrap(() => _dio.get(
            '/businesses/$businessId/customers/$customerId/wallet',
          ));
      return (r as Map).cast<String, dynamic>();
    } on ApiException catch (e) {
      if (e.statusCode == 402) return null; // addon not active → hide wallet
      rethrow;
    }
  }

  /// POST /ops/sessions/:sessionId/close — settle a table session (v2 body).
  /// paymentBreakdown: 1-3 legs [{method: cash|upi|card|online|wallet,
  /// amountInr}] which must sum to (session total − discountInr −
  /// shortfallInr) ±₹0.01 or the server 400s. shortfallInr books the unpaid
  /// gap as negative wallet balance (due) on the session's identified
  /// customer — server refuses without one. Returns the closed session.
  Future<Map<String, dynamic>> closeSessionV2(
    String businessId,
    String sessionId, {
    required String paymentMethod,
    double discountInr = 0,
    List<Map<String, dynamic>>? paymentBreakdown,
    double shortfallInr = 0,
  }) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/ops/sessions/$sessionId/close',
          data: {
            'paymentMethod': paymentMethod,
            if (discountInr > 0) 'discountInr': discountInr,
            if (paymentBreakdown != null && paymentBreakdown.isNotEmpty)
              'paymentBreakdown': paymentBreakdown,
            if (shortfallInr > 0) 'shortfallInr': shortfallInr,
          },
        ));
    return ((r as Map)['session'] as Map).cast<String, dynamic>();
  }

  /// Join-tables (2026-08-25): one big party across several physical tables
  /// shares ONE session/bill. POST /ops/sessions/:sid/join-table {tableId}.
  /// Returns the updated session. (UI is agent F2's — method only here.)
  Future<Map<String, dynamic>> joinTable(
      String businessId, String sessionId, String tableId) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/ops/sessions/$sessionId/join-table',
          data: {'tableId': tableId},
        ));
    return ((r as Map)['session'] as Map).cast<String, dynamic>();
  }

  /// Detach a previously joined table and free it. Returns the session.
  Future<Map<String, dynamic>> unjoinTable(
      String businessId, String sessionId, String tableId) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/ops/sessions/$sessionId/unjoin-table',
          data: {'tableId': tableId},
        ));
    return ((r as Map)['session'] as Map).cast<String, dynamic>();
  }

  /// Sell a membership at the counter — POST /memberships/subscribe. A real
  /// payment: method 'wallet' debits the customer wallet atomically; an
  /// optional paymentBreakdown (1-3 legs) splits the plan price (legs must
  /// sum to it ±₹0.01). Returns the created subscription row. (UI is agent
  /// F3's — method only here.)
  Future<Map<String, dynamic>> subscribeMembership(
    String businessId, {
    required String customerId,
    required String membershipId,
    String paymentMethod = 'cash',
    List<Map<String, dynamic>>? paymentBreakdown,
  }) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/memberships/subscribe',
          data: {
            'customerId': customerId,
            'membershipId': membershipId,
            'paymentMethod': paymentMethod,
            if (paymentBreakdown != null && paymentBreakdown.isNotEmpty)
              'paymentBreakdown': paymentBreakdown,
          },
        ));
    return ((r as Map)['subscription'] as Map).cast<String, dynamic>();
  }

  /// Cancel a sold membership → refund the unused share minus the
  /// cancellation charge. POST /customer-memberships/:id/cancel.
  /// mode: 'wallet' (credit customer wallet) | 'cash' | 'upi' (payout).
  /// cancellationPct null → backend default (10%). Owner/manager only.
  /// Returns the backend result map (refund amounts + subscription state).
  Future<Map<String, dynamic>> cancelCustomerMembership(
    String businessId,
    String customerMembershipId, {
    required String mode,
    double? cancellationPct,
  }) async {
    final r = await _wrap(() => _dio.post(
          '/businesses/$businessId/customer-memberships/$customerMembershipId/cancel',
          data: {
            'mode': mode,
            if (cancellationPct != null) 'cancellationPct': cancellationPct,
          },
        ));
    return (r as Map).cast<String, dynamic>();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  Future<dynamic> _wrap(Future<Response> Function() fn) async {
    try {
      final resp = await fn();
      return resp.data;
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      final msg = e.response?.data is Map
          ? (e.response!.data['message']?.toString() ?? e.message ?? 'API error')
          : (e.message ?? 'Network error');
      throw ApiException(msg, code);
    }
  }
}
