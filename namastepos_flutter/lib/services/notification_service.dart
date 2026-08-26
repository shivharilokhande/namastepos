// NamastePOS - Notifications: local (low-stock, order ready) + FCM push.
//
// FCM (wired 2026-08-26): real firebase_messaging integration. Android uses
// android/app/google-services.json (Firebase project "namastepos"). iOS push
// needs a paid Apple Developer APNs key, so ALL Firebase calls are gated to
// Android — on iOS every FCM method is a safe no-op and the app builds/runs
// normally without a GoogleService-Info.plist.
//
// Flow: main() → initPush() (Firebase.initializeApp + foreground listener,
// Android only). After login AuthProvider calls registerFcmToken(businessId),
// which fetches the token and POSTs it to /businesses/:id/device-tokens so the
// backend's pushService can target this device.

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'api_service.dart';

/// Top-level background handler (required by firebase_messaging to be a
/// top-level or static function). Data-only messages arriving while the app
/// is backgrounded land here; notification-payload messages are shown by the
/// OS automatically, so we just log.
@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  debugPrint('[fcm] background message: ${message.messageId}');
}

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _pushReady = false;

  /// Android-only: only Android has a Firebase config in this build. Keeps the
  /// iOS build/runtime clean until a paid APNs key is provisioned.
  bool get _pushSupported => Platform.isAndroid;

  /// Initialise Firebase + FCM foreground handling. Called from main().
  /// Best-effort — any failure logs and leaves the app fully functional.
  Future<void> initPush() async {
    if (!_pushSupported) return;
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
      // Foreground messages don't show a system notification by default —
      // surface them through the local-notifications plugin.
      FirebaseMessaging.onMessage.listen((msg) {
        final n = msg.notification;
        if (n != null) {
          show(
            id: msg.hashCode,
            title: n.title ?? 'NamastePOS',
            body: n.body ?? '',
          );
        }
      });
      _pushReady = true;
      debugPrint('[fcm] initialised');
    } catch (e) {
      debugPrint('[fcm] init failed (push disabled this run): $e');
    }
  }

  /// Registers this device's FCM token with the backend so the owner receives
  /// real-time push (anomaly alerts, order-ready pings). Called after login.
  /// Idempotent server-side (upsert by user+token). No-op on iOS / if init
  /// failed, and never throws into the caller's login path.
  Future<void> registerFcmToken(String businessId) async {
    if (!_pushSupported) return;
    try {
      if (!_pushReady) await initPush();
      if (!_pushReady) return;
      // Ask permission (Android 13+ needs the runtime POST_NOTIFICATIONS grant).
      await FirebaseMessaging.instance.requestPermission();
      final token = await FirebaseMessaging.instance.getToken();
      if (token == null || token.isEmpty) {
        debugPrint('[fcm] no token yet — skipping registration');
        return;
      }
      await ApiService.instance.registerFcmToken(
        businessId: businessId,
        token: token,
        platform: 'android',
      );
      debugPrint('[fcm] token registered for business $businessId');
      // Re-register if FCM rotates the token mid-session.
      FirebaseMessaging.instance.onTokenRefresh.listen((t) {
        ApiService.instance.registerFcmToken(
          businessId: businessId, token: t, platform: 'android');
      });
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
