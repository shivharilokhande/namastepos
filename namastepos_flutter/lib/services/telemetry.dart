// NamastePOS mobile — crash telemetry (FF-211 + FF-211b).
//
// Catches every uncaught error the app can throw and routes it through
// one sink. `sentry_flutter` is now installed; when the user sets
// SENTRY_DSN in the build environment we forward to Sentry.io. Absent
// DSN we still log a scrubbed line via `debugPrint` so field bug
// reports have breadcrumbs.
//
// Surfaces covered:
//   1. Widget build / paint errors      → FlutterError.onError
//   2. Platform / async errors          → PlatformDispatcher.onError
//   3. Anything from runZonedGuarded    → Telemetry.runGuarded
//
// Call `Telemetry.install()` FIRST in main(); it primes the framework
// hooks synchronously. Then call `Telemetry.bootstrap()` — this is
// awaitable and performs the SDK init when a DSN is present.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

class Telemetry {
  static bool _framework = false;
  static bool _sdk = false;

  /// Wire the Flutter framework error hooks. Safe to call before Sentry
  /// SDK is ready — errors caught before init just fall through to
  /// debugPrint + the scrubber.
  static void install() {
    if (_framework) return;
    _framework = true;

    // 1. Framework build/paint/layout errors.
    FlutterError.onError = (FlutterErrorDetails details) {
      _report(details.exception, details.stack,
          context: details.context?.toDescription() ?? 'FlutterError');
      FlutterError.presentError(details);
    };

    // 2. Platform channel / async gap errors.
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      _report(error, stack, context: 'PlatformDispatcher');
      return true;
    };
  }

  /// Initialise the Sentry SDK if `SENTRY_DSN` is provided at build
  /// time via `--dart-define SENTRY_DSN=<url>` (or absent → no-op).
  /// Returns once the SDK is ready. Safe to call more than once.
  static Future<void> bootstrap() async {
    if (_sdk) return;
    const dsn = String.fromEnvironment('SENTRY_DSN', defaultValue: '');
    const environment = String.fromEnvironment('SENTRY_ENV', defaultValue: 'development');
    const release = String.fromEnvironment('SENTRY_RELEASE', defaultValue: '');
    if (dsn.isEmpty) {
      _sdk = true;
      return;
    }
    await SentryFlutter.init((options) {
      options.dsn = dsn;
      options.environment = environment;
      if (release.isNotEmpty) options.release = release;
      // FF-215: strip PII from every event before it leaves the device.
      options.beforeSend = (event, hint) async {
        return _scrubSentryEvent(event);
      };
      options.tracesSampleRate = environment == 'production' ? 0.10 : 1.0;
      options.attachScreenshot = false;                 // PII risk
      options.attachViewHierarchy = false;              // same
      options.sendDefaultPii = false;
    });
    _sdk = true;
  }

  /// Wrap `runApp` so anything a widget throws asynchronously is captured.
  static Future<void> runGuarded(Future<void> Function() body) async {
    await runZonedGuarded<Future<void>>(
      body,
      (Object error, StackTrace stack) {
        _report(error, stack, context: 'runZonedGuarded');
      },
    );
  }

  /// Manual reporter — screens can call this from inside catch blocks
  /// alongside `humanizeError` for the user-facing message.
  static void capture(Object error, {StackTrace? stack, String? context}) {
    _report(error, stack, context: context ?? 'manual');
  }

  // ---- sink -----------------------------------------------------------
  static void _report(Object error, StackTrace? stack, {required String context}) {
    final scrubbed = _scrub(error.toString());
    debugPrint('╭─ TELEMETRY[$context] ────────────');
    debugPrint('│ $scrubbed');
    if (stack != null) {
      final s = _scrub(stack.toString());
      final trimmed = s.split('\n').take(12).join('\n');
      debugPrint(trimmed);
    }
    debugPrint('╰──────────────────────────────');
    if (_sdk) {
      // Sentry is initialised → forward. The SDK's own beforeSend runs
      // through _scrubSentryEvent below for another PII pass.
      Sentry.captureException(error, stackTrace: stack, hint: Hint()..set('context', context));
    }
  }

  // ---- PII scrubber ---------------------------------------------------
  static final _reEmail   = RegExp(r'[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}',
      caseSensitive: false);
  static final _rePhone   = RegExp(r'(?:\+?91[- ]?)?[6-9]\d{9}\b');
  static final _reJwt     = RegExp(
      r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b');
  static final _reBearer  = RegExp(r'Bearer\s+[A-Za-z0-9._-]+',
      caseSensitive: false);

  static String _scrub(String s) {
    return s
        .replaceAll(_reBearer, 'Bearer <redacted:token>')
        .replaceAll(_reJwt, '<redacted:token>')
        .replaceAll(_reEmail, '<redacted:email>')
        .replaceAll(_rePhone, '<redacted:phone>');
  }

  /// Sentry event mutator — runs the same scrub over exception messages
  /// and breadcrumb text before the event is uploaded. Returns `null`
  /// to drop an event entirely if scrubbing itself fails.
  static SentryEvent? _scrubSentryEvent(SentryEvent event) {
    try {
      // Drop user identifiers wholesale.
      if (event.user != null) {
        event = event.copyWith(
          user: SentryUser(id: event.user!.id),
        );
      }
      // Rewrite exception messages via the string scrubber.
      final ex = event.exceptions;
      if (ex != null && ex.isNotEmpty) {
        final scrubbed = ex.map((e) {
          final v = e.value;
          if (v == null || v.isEmpty) return e;
          return e.copyWith(value: _scrub(v));
        }).toList();
        event = event.copyWith(exceptions: scrubbed);
      }
      // Message + breadcrumbs.
      if (event.message?.formatted != null) {
        event = event.copyWith(
          message: SentryMessage(_scrub(event.message!.formatted)),
        );
      }
      final bcs = event.breadcrumbs;
      if (bcs != null && bcs.isNotEmpty) {
        final scrubbed = bcs.map((bc) {
          if (bc.message == null) return bc;
          return bc.copyWith(message: _scrub(bc.message!));
        }).toList();
        event = event.copyWith(breadcrumbs: scrubbed);
      }
      return event;
    } catch (_) {
      return null;
    }
  }
}
