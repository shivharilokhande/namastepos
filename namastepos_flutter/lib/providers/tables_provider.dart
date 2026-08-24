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

  List<Map<String, dynamic>> get floors => List.unmodifiable(_floors);
  List<Map<String, dynamic>> get tables => List.unmodifiable(_tables);
  bool get loading => _loading;
  String? get error => _error;

  Future<void> load(String businessId) async {
    _businessId = businessId;
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        ApiService.instance.listFloors(businessId),
        ApiService.instance.listOpsTables(businessId),
      ]);
      _floors = results[0].cast<Map<String, dynamic>>();
      _tables = results[1].cast<Map<String, dynamic>>();
    } catch (e) {
      _error = 'Couldn\'t fetch tables: $e';
      _floors = [];
      _tables = [];
    }
    _loading = false;
    notifyListeners();
  }

  Future<void> refresh() async {
    if (_businessId != null) await load(_businessId!);
  }
}
