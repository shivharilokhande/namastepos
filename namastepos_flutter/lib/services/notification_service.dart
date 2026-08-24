// NamastePOS - Local notifications (low-stock, order ready, daily summary)
//
// P0 fix (2026-08-22): FCM push (FF-330 server-side) had zero client
// wiring — no `firebase_messaging` package, no token registration,
// so `sendToBusinessOwners` on the backend always logged `0 devices`.
// The `registerFcmToken` hook below calls the backend endpoint once
// we have a token. To activate real push:
//   1. Add to pubspec.yaml (dev owner responsibility):
//        firebase_core: ^2.24.0
//        firebase_messaging: ^14.7.0
//   2. Add android/app/google-services.json from Firebase console
//   3. Uncomment the FirebaseMessaging.instance.getToken() line below
//   4. Call `NotificationService.instance.registerFcmToken(businessId)`
//      from AuthProvider.signInWithGoogle / loginWithPassword / pinLogin
//      after the token is issued
// Until then, `registerFcmToken` is a no-op and the app still builds
// without the Firebase config.

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'api_service.dart';

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();

  /// Registers this device's FCM token with the backend so the owner
  /// receives real-time push (anomaly alerts, order-ready pings). Call
  /// after login. Idempotent server-side (INSERT ON CONFLICT).
  ///
  /// This function is intentionally soft — if `firebase_messaging` is
  /// not yet on the classpath (owner hasn't run through step 1-3
  /// above), it logs and returns without throwing so the app boot
  /// path stays intact.
  Future<void> registerFcmToken(String businessId) async {
    try {
      // Placeholder for the FCM call. Once firebase_messaging is
      // added, replace this block with:
      //   final token = await FirebaseMessaging.instance.getToken();
      //   if (token == null) return;
      //   await ApiService.instance.registerFcmToken(
      //     businessId: businessId, token: token,
      //   );
      // For now: no-op that clearly signals the wire-up.
      debugPrint('[fcm] firebase_messaging not configured — token registration skipped');
      // Reference kept so the linter doesn't drop the import.
      // ignore: unused_local_variable
      final _api = ApiService.instance;
      return;
    } catch (e) {
      debugPrint('[fcm] token registration failed: $e');
    }
  }

  Future<void> init() async {
    // Notification status-bar icon — uses the same placeholder
    // launcher drawable until real PNG icons are added in res/mipmap-*.
    const androidInit = AndroidInitializationSettings('@drawable/ic_launcher');
    const darwinInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    // macOS uses the same Darwin settings as iOS; the plugin requires
    // them to be passed explicitly under `macOS:` or it throws at init.
    const settings = InitializationSettings(
      android: androidInit,
      iOS: darwinInit,
      macOS: darwinInit,
    );
    await _plugin.initialize(settings);
  }

  Future<void> show({
    required int id,
    required String title,
    required String body,
    String channelId = 'namastepos_general',
    String channelName = 'General',
  }) async {
    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        channelId, channelName,
        importance: Importance.high,
        priority: Priority.high,
        showWhen: true,
      ),
      iOS: const DarwinNotificationDetails(presentSound: true),
    );
    await _plugin.show(id, title, body, details);
  }

  Future<void> lowStock(String itemName, double qty) async {
    await show(
      id: itemName.hashCode,
      title: 'Low stock alert',
      body: '$itemName is low: $qty left. Reorder soon.',
      channelId: 'namastepos_stock',
      channelName: 'Stock alerts',
    );
  }

  Future<void> orderReady(int orderNo) async {
    await show(
      id: orderNo,
      title: 'Order #$orderNo ready',
      body: 'Mark as ready and notify the customer.',
      channelId: 'namastepos_orders',
      channelName: 'Order updates',
    );
  }
}
