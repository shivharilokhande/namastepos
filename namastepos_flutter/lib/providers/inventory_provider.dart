// NamastePOS - Inventory state provider

import 'package:flutter/foundation.dart';

import '../models/inventory_transaction.dart';
import '../services/repositories.dart';

class InventoryProvider extends ChangeNotifier {
  final Map<String, List<InventoryTransaction>> _history = {};
  // NP-115: business id of the CURRENT auth session (synced from AuthProvider
  // via the ChangeNotifierProxyProvider in main.dart). Null when signed out.
  String? _authBusinessId;

  /// NP-115 — history rows are tenant data (keyed by menu-item id, which is
  /// tenant-scoped): drop the cache whenever the session's business changes.
  void syncAuthSession(String? authBusinessId) {
    if (_authBusinessId == authBusinessId) return;
    _authBusinessId = authBusinessId;
    resetForLogout();
  }

  /// NP-115 — clears all tenant-scoped in-memory state.
  void resetForLogout() {
    if (_history.isEmpty) return;
    _history.clear();
    // May run during a ProxyProvider `update` (build phase) — defer.
    Future.microtask(notifyListeners);
  }

  Future<void> adjust({
    required String businessId,
    required String menuItemId,
    required double delta,
    required InventoryReason reason,
    String? note,
  }) async {
    await InventoryRepo.instance.adjust(
      businessId: businessId,
      menuItemId: menuItemId,
      delta: delta,
      reason: reason,
      note: note,
    );
    // bust history cache for this item
    _history.remove(menuItemId);
    notifyListeners();
  }

  Future<List<InventoryTransaction>> history(String menuItemId,
      {bool force = false}) async {
    if (!force && _history.containsKey(menuItemId)) {
      return _history[menuItemId]!;
    }
    final list = await InventoryRepo.instance.history(menuItemId);
    _history[menuItemId] = list;
    notifyListeners();
    return list;
  }
}
