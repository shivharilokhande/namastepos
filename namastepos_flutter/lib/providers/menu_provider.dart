// NamastePOS — Menu state provider.
//
// The BACKEND is the source of truth (`GET /v1/businesses/:id/menu`).
// Local SQLite is just a read-through cache for offline mode.
//
// Earlier this provider seeded "demo" menu items into local SQLite when
// the cache was empty — which is why mobile showed Masala Dosa / Idli
// even though the dashboard's business had a different menu. That fallback
// is now removed; on first run with no network the user sees an empty
// list with a "couldn't reach server" hint.

import 'package:flutter/foundation.dart';

import '../models/menu_item.dart';
import '../services/analytics_service.dart';
import '../services/api_service.dart';
import '../services/repositories.dart';

class MenuProvider extends ChangeNotifier {
  final List<MenuItem> _items = [];
  bool _loading = false;
  String _selectedCategory = 'All';
  String? _businessId;
  String? _error;
  // NP-115: business id of the CURRENT auth session (synced from AuthProvider
  // via the ChangeNotifierProxyProvider in main.dart). Null when signed out.
  String? _authBusinessId;

  /// NP-115 — see OrdersProvider.syncAuthSession. Wipes tenant state when the
  /// session's business changes (logout / account switch / restaurant switch).
  void syncAuthSession(String? authBusinessId) {
    if (_authBusinessId == authBusinessId) return;
    _authBusinessId = authBusinessId;
    if (_businessId != null && _businessId != authBusinessId) resetForLogout();
  }

  /// NP-115 — clears all tenant-scoped in-memory state.
  void resetForLogout() {
    _items.clear();
    _businessId = null;
    _loading = false;
    _error = null;
    _selectedCategory = 'All';
    // The plan's menu-item cap is tenant-scoped — never let the previous
    // outlet's cap decide the next one's `menu_ready.over_plan_cap`.
    _cachedMenuCap = null;
    _menuCapResolved = false;
    // May run during a ProxyProvider `update` (build phase) — defer.
    Future.microtask(notifyListeners);
  }

  List<MenuItem> get items => List.unmodifiable(_items);
  bool get loading => _loading;
  String? get error => _error;
  String get selectedCategory => _selectedCategory;

  List<String> get categories {
    final set = <String>{};
    for (final i in _items) {
      set.add(i.category);
    }
    final list = set.toList()..sort();
    return ['All', ...list];
  }

  List<MenuItem> get visibleItems {
    if (_selectedCategory == 'All') return items;
    return items.where((i) => i.category == _selectedCategory).toList();
  }

  List<MenuItem> get lowStockItems =>
      _items.where((i) => i.isLowStock).toList(growable: false);

  set selectedCategory(String c) {
    _selectedCategory = c;
    notifyListeners();
  }

  /// [source] is the activation-funnel attribution for `menu_ready` — the
  /// wire vocabulary shared with the web dashboard: 'wizard' | 'manual' |
  /// 'bulk_csv' | 'migrate' | 'template' | 'paste'. It only matters on the
  /// single refresh that crosses the 3-item threshold; every ordinary refresh
  /// leaves it at 'manual'. The two import screens pass their own source so
  /// "median signup to first bill BY menu route" can be read later, which is
  /// the whole reason those screens exist.
  Future<void> load(String businessId, {String source = 'manual'}) async {
    // NP-115: refuse to load a business that isn't the signed-in one.
    if (businessId != _authBusinessId) {
      debugPrint('MENU load skipped: $businessId != auth $_authBusinessId');
      return;
    }
    _businessId = businessId;
    _loading = true;
    _error = null;
    notifyListeners();

    // 1. Try backend FIRST — it's the source of truth.
    try {
      final raw = await ApiService.instance.listMenu(businessId);
      final remote = raw.cast<Map<String, dynamic>>()
          .map(MenuItem.fromBackend)
          .toList();
      // NP-115: session changed mid-fetch — discard rather than repopulate.
      if (businessId != _authBusinessId) { _loading = false; return; }
      // Replace local cache wholesale so deletions on backend reflect here.
      await MenuRepo.instance.replaceAll(businessId, remote);
      _items
        ..clear()
        ..addAll(remote);
    } catch (e) {
      // NP-115: never serve the local cache for a business that no longer
      // matches the session (e.g. 403 after a restaurant switch).
      if (businessId != _authBusinessId) { _loading = false; return; }
      // 2. Backend unreachable → fall back to local cache (offline mode).
      _error = 'Couldn\'t reach server — showing cached menu';
      final cached = await MenuRepo.instance.listForBusiness(businessId, onlyActive: false);
      _items
        ..clear()
        ..addAll(cached);
    }

    _loading = false;
    notifyListeners();
    // Activation funnel — `menu_ready`. Hooked to the one place a menu list
    // lands in the app so no screen has to remember it. Cheap to call on
    // every refresh: it exits immediately once the milestone has fired or
    // while the owner is still under the 3-item threshold.
    // ignore: unawaited_futures
    _maybeTrackMenuReady(businessId, source);
  }

  /// Fires `menu_ready` the first time the owner has >= 3 ACTIVE menu items
  /// they authored themselves (the setup wizard's three untouched demo rows
  /// do not count — see Activation.countOwnerAuthored, which uses the same
  /// pre-fill table as the dashboard).
  ///
  /// `source` names the route the menu arrived by. 'manual' for hand-typed
  /// items, 'template' for a loaded starter menu and 'paste' for a pasted
  /// one — the same three strings the dashboard sends, because a funnel that
  /// spells them differently on each platform cannot be joined.
  Future<void> _maybeTrackMenuReady(String businessId, String source) async {
    final a = AnalyticsService.instance;
    if (a.disabled) return;
    try {
      if (await a.hasFired(FunnelEvent.menuReady)) return;
      final rows = _items
          .map((i) => (name: i.name, price: i.price as num, active: i.isActive))
          .toList();
      // Only worth the extra subscription read once the threshold is met —
      // Activation.menuReady bails before using it otherwise, so resolve the
      // cap lazily here for the single render that crosses the line.
      int? cap;
      if (Activation.countOwnerAuthored(rows) >= 3) {
        cap = await _menuItemCap(businessId);
      }
      await Activation.menuReady(rows, source, planItemCap: cap);
    } catch (_) { /* analytics never surfaces an error to the menu screen */ }
  }

  // Remembered so the one extra GET above happens at most once per session.
  int? _cachedMenuCap;
  bool _menuCapResolved = false;

  Future<int?> _menuItemCap(String businessId) async {
    if (_menuCapResolved) return _cachedMenuCap;
    try {
      final sub = await ApiService.instance.getSubscription(businessId);
      final raw = (sub?['plan'] as Map?)?['limits'];
      final v = raw is Map ? raw['menu_items'] : null;
      _cachedMenuCap = v is num ? v.toInt() : int.tryParse('${v ?? ''}');
    } catch (_) {
      _cachedMenuCap = null;
    }
    _menuCapResolved = true;
    return _cachedMenuCap;
  }

  Future<void> upsert(MenuItem item, {bool isNew = false}) async {
    if (isNew) {
      await MenuRepo.instance.create(item);
      _items.add(item);
    } else {
      await MenuRepo.instance.update(item);
      final idx = _items.indexWhere((i) => i.id == item.id);
      if (idx >= 0) _items[idx] = item;
    }
    notifyListeners();
    // Same hook on the write path so the third item the owner types fires
    // `menu_ready` immediately rather than on the next menu refresh.
    final bid = _businessId;
    if (bid != null) {
      // ignore: unawaited_futures
      _maybeTrackMenuReady(bid, 'manual');
    }
  }

  Future<void> remove(MenuItem item) async {
    await MenuRepo.instance.softDelete(item.id);
    _items.removeWhere((i) => i.id == item.id);
    notifyListeners();
  }

  Future<void> refresh({String source = 'manual'}) async {
    // NP-115: no-op when signed out or holding another tenant's data.
    if (_businessId == null || _businessId != _authBusinessId) return;
    await load(_businessId!, source: source);
  }

  MenuItem? byId(String id) {
    try { return _items.firstWhere((i) => i.id == id); } catch (_) { return null; }
  }

  void updateLocalStock(String menuItemId, double newStock) {
    final idx = _items.indexWhere((i) => i.id == menuItemId);
    if (idx >= 0) {
      _items[idx] = _items[idx].copyWith(stock: newStock);
      notifyListeners();
    }
  }
}
