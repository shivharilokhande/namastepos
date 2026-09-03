// NamastePOS — Tables / Floors state provider.
//
// Mobile previously had no top-level Tables screen, just a Captain view.
// Now we share state via this provider so any screen (Captain, Tables tab
// once we add it) can show the same list. Backend is the source of truth.

import 'package:flutter/foundation.dart';
import '../services/api_service.dart';

class TablesProvider extends ChangeNotifier {
  List<Map<String, dynamic>> _floors = [];
  List<Map<String, dynamic>> _tables = [];
  bool _loading = false;
  String? _error;
  String? _businessId;

  // NP-115: business id of the CURRENT auth session (synced from AuthProvider
  // via the ChangeNotifierProxyProvider in main.dart). Null when signed out.
  String? _authBusinessId;

  List<Map<String, dynamic>> get floors => List.unmodifiable(_floors);
  List<Map<String, dynamic>> get tables => List.unmodifiable(_tables);
  bool get loading => _loading;
  String? get error => _error;

  /// NP-115 — see OrdersProvider.syncAuthSession. Wipes tenant state when the
  /// session's business changes (logout / account switch / restaurant switch).
  void syncAuthSession(String? authBusinessId) {
    if (_authBusinessId == authBusinessId) return;
    _authBusinessId = authBusinessId;
    if (_businessId != null && _businessId != authBusinessId) resetForLogout();
  }

  /// NP-115 — clears all tenant-scoped in-memory state.
  void resetForLogout() {
    _floors = [];
    _tables = [];
    _businessId = null;
    _loading = false;
    _error = null;
    // May run during a ProxyProvider `update` (build phase) — defer.
    Future.microtask(notifyListeners);
  }

  Future<void> load(String businessId) async {
    // NP-115: refuse to load a business that isn't the signed-in one.
    if (businessId != _authBusinessId) {
      debugPrint('TABLES load skipped: $businessId != auth $_authBusinessId');
      return;
    }
    _businessId = businessId;
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        ApiService.instance.listFloors(businessId),
        ApiService.instance.listOpsTables(businessId),
      ]);
      // NP-115: session changed mid-fetch — discard rather than repopulate.
      if (businessId != _authBusinessId) { _loading = false; return; }
      _floors = results[0].cast<Map<String, dynamic>>();
      _tables = results[1].cast<Map<String, dynamic>>();
    } catch (e) {
      if (businessId != _authBusinessId) { _loading = false; return; }
      _error = 'Couldn\'t fetch tables: $e';
      _floors = [];
      _tables = [];
    }
    _loading = false;
    notifyListeners();
  }

  Future<void> refresh() async {
    // NP-115: no-op when signed out or holding another tenant's data.
    if (_businessId == null || _businessId != _authBusinessId) return;
    await load(_businessId!);
  }
}
