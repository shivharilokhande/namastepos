// NamastePOS mobile — lightweight i18n resolver (FF-604b).
//
// Reads the device locale (Platform.localeName), falls back to `en`.
// Owner can override at runtime via a Settings toggle; the choice is
// persisted in SharedPreferences.
//
// Not using `flutter_localizations` on purpose — we only ship en + hi
// for launch and the dependency graph is already heavy. If we grow to
// 5+ languages, migrate to the official intl setup then.
//
// Usage:
//   T.of(context, 'orders.newOrder')   // returns "New order" or "नया ऑर्डर"
//   or the short form:
//   tr('orders.newOrder')

import 'dart:ui' show PlatformDispatcher;
import 'package:shared_preferences/shared_preferences.dart';

const Map<String, Map<String, String>> _dict = {
  'en': {
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.loading': 'Loading…',
    'common.search': 'Search',
    'common.total': 'Total',
    'common.subtotal': 'Subtotal',
    'orders.newOrder': 'New order',
    'orders.placeOrder': 'Place order',
    'orders.saveKot': 'Save KOT',
    'orders.markReady': 'Mark ready',
    'orders.markCollected': 'Mark collected',
    'orders.reprint': 'Reprint',
    'orders.dineIn': 'Dine-in',
    'orders.takeaway': 'Takeaway',
    'nav.home': 'Home',
    'nav.pos': 'POS',
    'nav.orders': 'Orders',
    'nav.captain': 'Captain',
    'nav.reports': 'Reports',
    'nav.settings': 'Settings',
    'nav.kds': 'Kitchen',
  },
  'hi': {
    'common.save': 'सहेजें',
    'common.cancel': 'रद्द करें',
    'common.delete': 'हटाएँ',
    'common.yes': 'हाँ',
    'common.no': 'नहीं',
    'common.loading': 'लोड हो रहा है…',
    'common.search': 'खोजें',
    'common.total': 'कुल',
    'common.subtotal': 'उप-योग',
    'orders.newOrder': 'नया ऑर्डर',
    'orders.placeOrder': 'ऑर्डर दें',
    'orders.saveKot': 'KOT सहेजें',
    'orders.markReady': 'तैयार करें',
    'orders.markCollected': 'दे दिया',
    'orders.reprint': 'फिर से प्रिंट',
    'orders.dineIn': 'बैठ कर',
    'orders.takeaway': 'पैक करके',
    'nav.home': 'मुख्य',
    'nav.pos': 'POS',
    'nav.orders': 'ऑर्डर',
    'nav.captain': 'कैप्टन',
    'nav.reports': 'रिपोर्ट',
    'nav.settings': 'सेटिंग्स',
    'nav.kds': 'किचन',
  },
};

/// The one place we decide which locale is active. Owner override
/// (persisted in SharedPreferences) wins over device locale.
///
/// Sync-fix (2026-08-22): the header comment claimed the override was
/// persisted but the implementation kept it in a bare module variable
/// that reset on every app launch. Now `setLocaleOverride` writes to
/// SharedPreferences (async, fire-and-forget) and `loadLocaleOverride`
/// is called from `main()` before the first build so the choice
/// survives restarts. Kept `_override` as the fast read path so
/// `currentLocale()` doesn't have to await on every string lookup.
String _override = '';
const _prefsKey = 'ff_locale_override';

void setLocaleOverride(String code) {
  _override = code;
  // Persist async — no need to block callers. If the write fails
  // (uninitialised prefs in an edge case) we fall back to the runtime
  // override for the current session.
  SharedPreferences.getInstance().then((p) {
    if (code.isEmpty) {
      p.remove(_prefsKey);
    } else {
      p.setString(_prefsKey, code);
    }
  }).catchError((_) { /* swallow — non-fatal */ });
}

/// Restore the persisted override on app boot. Call this from `main()`
/// before `runApp` so the first frame uses the correct language.
Future<void> loadLocaleOverride() async {
  try {
    final p = await SharedPreferences.getInstance();
    final saved = p.getString(_prefsKey);
    if (saved != null && saved.isNotEmpty) _override = saved;
  } catch (_) { /* swallow */ }
}

String currentLocale() {
  if (_override.isNotEmpty) return _override;
  final device = PlatformDispatcher.instance.locale.languageCode;
  return _dict.containsKey(device) ? device : 'en';
}

/// Resolve a dotted key ("orders.placeOrder") to its localized string.
/// Falls back to the English string; then to the key itself so a
/// missed translation renders as `orders.placeOrder` instead of blank.
String tr(String key) {
  final loc = currentLocale();
  return _dict[loc]?[key] ?? _dict['en']?[key] ?? key;
}
