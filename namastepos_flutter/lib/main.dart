// NamastePOS - Micro-food POS for Android & iOS
// Entry point for the application
//
// Author: Smart IT by Shiv (Founder: Arjun Mehta)
// License: Proprietary

import 'package:flutter/foundation.dart'
    show kReleaseMode, debugPrint, defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'providers/auth_provider.dart';
import 'providers/menu_provider.dart';
import 'providers/orders_provider.dart';
import 'providers/inventory_provider.dart';
import 'providers/expenses_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/subscription_provider.dart';
import 'providers/tables_provider.dart';
import 'services/api_service.dart';
import 'services/database_service.dart';
import 'services/notification_service.dart';
import 'services/offline_outbox.dart';
import 'services/telemetry.dart';
import 'utils/i18n.dart' show loadLocaleOverride;

Future<void> main() async {
  // FF-211b: wrap the whole app in a runZoned so any uncaught async
  // error inside `runApp` is captured by Telemetry.
  await Telemetry.runGuarded(() async {
    WidgetsFlutterBinding.ensureInitialized();

    // iOS Keychain scheme migration (2026-09-01, P0 sign-in fix).
    // The Strix I-2 hardening pinned Keychain items to
    // `first_unlock_this_device`. iOS keeps Keychain items across app
    // reinstalls, so items written by OLDER builds under the default
    // accessibility now COLLIDE on write → PlatformException
    // "The specified item already exists in the keychain." (OSStatus -25299),
    // which broke EVERY sign-in path (Google, password, staff PIN, owner MPIN):
    // pin-login succeeded server-side but the token write threw, surfacing as
    // "Sign-in failed". Clear the old items ONCE, under the SAME options the app
    // now uses, then mark the scheme migrated so this runs only on first launch
    // of a build that has this fix. MUST run before any storage access below.
    await _migrateKeychainScheme();

    // Bug fix (B37): loudly warn if the release build is missing the
    // API_URL dart-define. The fallback in ApiService points at a real
    // production host — silently routing debug traffic there would be
    // a very hard-to-diagnose regression.
    // Hardcode-audit fix (2026-08-24): the old "guard" printed the same
    // message in both branches and never failed — so debug/CI builds
    // silently sent real traffic to production. Non-release builds now
    // fail fast; release builds keep the production default (intended).
    const apiUrl = String.fromEnvironment('API_URL');
    if (apiUrl.isEmpty && !kReleaseMode) {
      throw StateError(
          'BOOT: --dart-define=API_URL was not set at build time. '
          'Refusing to run a non-release build against the hardcoded '
          'production fallback. Example:\n'
          '  flutter run --dart-define=API_URL=http://10.0.2.2:4000/v1');
    }

    // FF-211: hook framework + platform error handlers before anything
    // else so init crashes (DB / notifications) still land in telemetry.
    Telemetry.install();

    // Initialise sentry_flutter (no-op unless --dart-define SENTRY_DSN
    // is set at build time).
    await Telemetry.bootstrap();

    // Lock orientation to portrait for the POS use case
    await SystemChrome.setPreferredOrientations(const [
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
    ]);

    // Init local database & notifications
    await DatabaseService.instance.init();
    await NotificationService.instance.init();
    // Firebase Cloud Messaging (2026-08-26). Android-only: iOS push needs a
    // paid Apple Developer APNs key, so this is a guarded no-op on iOS and
    // never blocks boot. Token registration itself happens post-login.
    await NotificationService.instance.initPush();
    // Restore the owner's language choice (en/hi) before the first
    // frame so all runtime strings render in the right language on
    // relaunch. Non-blocking failure — if prefs aren't ready, we fall
    // back to device locale.
    await _restoreLocaleOverride();
    // Offline outbox — queues writes when connectivity is gone, drains
    // in the background on reconnect / every 30s. Idempotent at backend
    // via orderService.create's client_id uniqueness.
    await OfflineOutbox().init(api: ApiService.instance.dio);

    runApp(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => AuthProvider()),
          // NP-115: every provider holding tenant data is a ProxyProvider on
          // AuthProvider. `update` fires on every auth notifyListeners and
          // pushes the session's business id into the provider; when it
          // changes (logout, "use another account", DPDP erasure, restaurant
          // switch) the provider wipes its in-memory tenant state, so the
          // previous restaurant's orders/cart/menu/tables can never leak
          // into the next session. SettingsProvider is device-level, not
          // tenant-scoped, so it stays a plain provider.
          ChangeNotifierProxyProvider<AuthProvider, MenuProvider>(
            create: (_) => MenuProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
          ChangeNotifierProxyProvider<AuthProvider, OrdersProvider>(
            create: (_) => OrdersProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
          ChangeNotifierProxyProvider<AuthProvider, InventoryProvider>(
            create: (_) => InventoryProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
          ChangeNotifierProxyProvider<AuthProvider, ExpensesProvider>(
            create: (_) => ExpensesProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
          ChangeNotifierProvider(create: (_) => SettingsProvider()),
          ChangeNotifierProxyProvider<AuthProvider, SubscriptionProvider>(
            create: (_) => SubscriptionProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
          ChangeNotifierProxyProvider<AuthProvider, TablesProvider>(
            create: (_) => TablesProvider(),
            update: (_, auth, p) => p!..syncAuthSession(auth.business?.id),
          ),
        ],
        child: const NamastePOSApp(),
      ),
    );
  });
}

/// Wrapper so we can catch prefs failures on obscure devices without
/// crashing the app boot. If prefs isn't available (uninitialised
/// storage, disk full), the app falls back to device locale.
Future<void> _restoreLocaleOverride() async {
  try {
    await loadLocaleOverride();
  } catch (e) {
    debugPrint('[i18n] locale-override load failed: $e');
  }
}

/// iOS Keychain scheme migration (2026-09-01). See the call site in main() for
/// the full rationale. In short: older builds wrote Keychain items under the
/// default accessibility; the current build pins `first_unlock_this_device`,
/// and because iOS keeps Keychain items across reinstalls those legacy items
/// collide on write (OSStatus -25299), breaking sign-in. Clear them once under
/// the SAME options the app now uses, gated by a one-time scheme flag. Best
/// effort — never blocks boot. iOS-only (Android uses encrypted prefs, no clash).
Future<void> _migrateKeychainScheme() async {
  if (defaultTargetPlatform != TargetPlatform.iOS) return;
  const storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
      synchronizable: false,
    ),
  );
  const flag = 'ff_keychain_scheme_v2';
  try {
    if (await storage.read(key: flag) == '1') return; // already migrated
    await storage.deleteAll(); // drop legacy (old-accessibility) items once
    await storage.write(key: flag, value: '1');
    debugPrint('[keychain] migrated to scheme v2 (cleared legacy items)');
  } catch (e) {
    debugPrint('[keychain] scheme migration skipped: $e');
  }
}
