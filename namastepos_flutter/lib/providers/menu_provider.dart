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
import '../services/api_service.dart';
import '../services/repositories.dart';

class MenuProvider extends ChangeNotifier {
  final List<MenuItem> _items = [];
  bool _loading = false;
  String _selectedCategory = 'All';
  String? _businessId;
  String? _error;

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

  Future<void> load(String businessId) async {
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
      // Replace local cache wholesale so deletions on backend reflect here.
      await MenuRepo.instance.replaceAll(businessId, remote);
      _items
        ..clear()
        ..addAll(remote);
    } catch (e) {
      // 2. Backend unreachable → fall back to local cache (offline mode).
      _error = 'Couldn\'t reach server — showing cached menu';
      final cached = await MenuRepo.instance.listForBusiness(businessId, onlyActive: false);
      _items
        ..clear()
        ..addAll(cached);
    }

    _loading = false;
    notifyListeners();
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
  }

  Future<void> remove(MenuItem item) async {
    await MenuRepo.instance.softDelete(item.id);
    _items.removeWhere((i) => i.id == item.id);
    notifyListeners();
  }

  Future<void> refresh() async {
    if (_businessId != null) await load(_businessId!);
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
