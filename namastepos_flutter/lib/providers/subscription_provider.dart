// NamastePOS - Subscription + add-on state

import 'package:flutter/foundation.dart';

import '../models/subscription.dart';
import '../services/api_service.dart';

class SubscriptionProvider extends ChangeNotifier {
  Subscription? _subscription;
  final List<AddonActivation> _addons = [];
  bool _loading = false;
  String? _error;
  String? _businessId;
  // NP-115: business id of the CURRENT auth session (synced from AuthProvider
  // via the ChangeNotifierProxyProvider in main.dart). Null when signed out.
  String? _authBusinessId;

  Subscription? get subscription => _subscription;
  List<AddonActivation> get addons => List.unmodifiable(_addons);
  bool get loading => _loading;
  String? get error => _error;
  bool get isTrialing => _subscription?.isTrialing ?? false;
  bool get isPaused => _subscription?.isPaused ?? false;
  String? get planName => _subscription?.plan?.name;

  /// Returns true if the business currently has the named add-on active.
  /// Used to gate screens (e.g. Online Orders tab is locked without 'online-orders').
  bool hasAddon(String slug) =>
      _addons.any((a) => a.slug == slug && a.isActive);

  /// NP-115 — see OrdersProvider.syncAuthSession. Wipes tenant state when the
  /// session's business changes (logout / account switch / restaurant switch).
  void syncAuthSession(String? authBusinessId) {
    if (_authBusinessId == authBusinessId) return;
    _authBusinessId = authBusinessId;
    if (_businessId != null && _businessId != authBusinessId) resetForLogout();
  }

  /// NP-115 — clears all tenant-scoped in-memory state. Same as [clear] but
  /// safe to call during a ProxyProvider `update` (build phase).
  void resetForLogout() {
    _subscription = null;
    _addons.clear();
    _error = null;
    _businessId = null;
    _loading = false;
    Future.microtask(notifyListeners);
  }

  Future<void> load(String businessId) async {
    // NP-115: refuse to load a business that isn't the signed-in one.
    if (businessId != _authBusinessId) return;
    _businessId = businessId;
    _loading = true; _error = null; notifyListeners();
    try {
      final results = await Future.wait<dynamic>([
        ApiService.instance.getSubscription(businessId),
        ApiService.instance.getMyAddons(businessId),
      ]);
      // NP-115: session changed mid-fetch — discard rather than repopulate.
      if (businessId != _authBusinessId) { _loading = false; return; }
      final subData = results[0] as Map<String, dynamic>?;
      _subscription = subData == null ? null : Subscription.fromMap(subData);

      final addonData = results[1] as Map<String, dynamic>;
      final active = (addonData['active'] as List?) ?? const [];
      _addons
        ..clear()
        ..addAll(active.map((m) => AddonActivation.fromMap(m as Map<String, dynamic>)));
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = e.toString();
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  void clear() {
    _subscription = null;
    _addons.clear();
    _error = null;
    notifyListeners();
  }
}
