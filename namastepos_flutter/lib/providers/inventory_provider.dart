// NamastePOS - Inventory state provider

import 'package:flutter/foundation.dart';

import '../models/inventory_transaction.dart';
import '../services/repositories.dart';

class InventoryProvider extends ChangeNotifier {
  final Map<String, List<InventoryTransaction>> _history = {};

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
