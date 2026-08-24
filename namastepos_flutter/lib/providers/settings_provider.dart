// NamastePOS - Settings state (printer config, aggregators, etc.)

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsProvider extends ChangeNotifier {
  SettingsProvider() {
    _load();
  }

  // Printer
  bool _printerEnabled = true;
  int _paperWidthMm = 58; // or 80
  String? _printerName;
  String? _printerAddress;

  // Aggregators (API keys live server-side; PUT via aggregators_screen.dart)
  bool _zomatoEnabled = false;
  bool _swiggyEnabled = false;

  // Notifications
  bool _notifyOnLowStock = true;
  bool _notifyOnNewOrder = true;
  bool _autoWhatsAppOnReady = false;

  // Currency/locale formatting lives in lib/utils/formatters.dart (AppFmt).

  bool get printerEnabled => _printerEnabled;
  int get paperWidthMm => _paperWidthMm;
  String? get printerName => _printerName;
  String? get printerAddress => _printerAddress;
  bool get zomatoEnabled => _zomatoEnabled;
  bool get swiggyEnabled => _swiggyEnabled;
  bool get notifyOnLowStock => _notifyOnLowStock;
  bool get notifyOnNewOrder => _notifyOnNewOrder;
  bool get autoWhatsAppOnReady => _autoWhatsAppOnReady;

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    _printerEnabled = p.getBool('printerEnabled') ?? true;
    _paperWidthMm = p.getInt('paperWidthMm') ?? 58;
    _printerName = p.getString('printerName');
    _printerAddress = p.getString('printerAddress');
    _zomatoEnabled = p.getBool('zomatoEnabled') ?? false;
    _swiggyEnabled = p.getBool('swiggyEnabled') ?? false;
    _notifyOnLowStock = p.getBool('notifyOnLowStock') ?? true;
    _notifyOnNewOrder = p.getBool('notifyOnNewOrder') ?? true;
    _autoWhatsAppOnReady = p.getBool('autoWhatsAppOnReady') ?? false;
    // Scrub legacy plaintext aggregator keys from older builds.
    await p.remove('zomatoKey');
    await p.remove('swiggyKey');
    notifyListeners();
  }

  Future<void> _set<T>(String key, T value) async {
    final p = await SharedPreferences.getInstance();
    if (value is bool) {
      await p.setBool(key, value);
    } else if (value is int) {
      await p.setInt(key, value);
    } else if (value is double) {
      await p.setDouble(key, value);
    } else if (value is String) {
      await p.setString(key, value);
    } else if (value == null) {
      await p.remove(key);
    }
    notifyListeners();
  }

  Future<void> setPrinter({String? name, String? address, int? paperWidth}) async {
    if (name != null) { _printerName = name; await _set('printerName', name); }
    if (address != null) { _printerAddress = address; await _set('printerAddress', address); }
    if (paperWidth != null) { _paperWidthMm = paperWidth; await _set('paperWidthMm', paperWidth); }
  }

  Future<void> togglePrinter(bool v) async {
    _printerEnabled = v;
    await _set('printerEnabled', v);
  }

  Future<void> toggleZomato(bool v) async {
    _zomatoEnabled = v;
    await _set('zomatoEnabled', v);
  }

  Future<void> toggleSwiggy(bool v) async {
    _swiggyEnabled = v;
    await _set('swiggyEnabled', v);
  }

  Future<void> toggleLowStockAlerts(bool v) async {
    _notifyOnLowStock = v;
    await _set('notifyOnLowStock', v);
  }

  Future<void> toggleNewOrderAlerts(bool v) async {
    _notifyOnNewOrder = v;
    await _set('notifyOnNewOrder', v);
  }

  Future<void> toggleAutoWhatsApp(bool v) async {
    _autoWhatsAppOnReady = v;
    await _set('autoWhatsAppOnReady', v);
  }
}
