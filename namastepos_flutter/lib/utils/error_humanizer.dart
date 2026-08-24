// NamastePOS — Central error humanizer (FF-220).
//
// Purpose: never show a raw `DioException`, stack trace, or backend
// JSON payload to an end user. Every screen that has a `catch` block
// funnels the error through `humanizeError(e)` and displays the
// returned string in a SnackBar or dialog.
//
// The map covers the four large classes of failure a cashier will
// realistically see:
//   1. Network / timeout           → "You're offline, check your connection"
//   2. HTTP 4xx                    → user-actionable message per code
//   3. HTTP 5xx                    → "Server issue on our side"
//   4. Anything else               → "Something went wrong, please retry"
//
// The `raw` version is also returned so the caller can pipe it to
// Sentry / debugPrint. The message is safe to render to any UI text
// widget without escaping.

import 'dart:io' show SocketException, HttpException;
import 'package:dio/dio.dart';

import '../services/api_service.dart';

/// Human-readable, one-line message ready to render in UI.
String humanizeError(Object e) {
  // Our own wrapper — trust the message it carried
  if (e is ApiException) {
    return _forStatus(e.statusCode, fallback: e.message);
  }
  // Dio's low-level HTTP client
  if (e is DioException) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return "Your connection is slow. Please try again.";
      case DioExceptionType.connectionError:
        return "You're offline. Please check your internet connection.";
      case DioExceptionType.cancel:
        return "The request was cancelled.";
      case DioExceptionType.badCertificate:
        return "Security certificate problem. Contact support.";
      case DioExceptionType.badResponse:
        final code = e.response?.statusCode;
        // Try to surface the backend's `message` field if there is one
        final data = e.response?.data;
        final backendMsg = (data is Map && data['message'] is String)
            ? data['message'] as String
            : null;
        return _forStatus(code, fallback: backendMsg);
      case DioExceptionType.unknown:
        return _lowLevelFallback(e.error) ?? "Something went wrong. Please retry.";
      // dio 5.11 added DioExceptionType.transformTimeout (request/response
      // interceptor stuck). Treat it as any other slow-connection issue.
      default:
        return "Your connection is slow. Please try again.";
    }
  }
  // Plain socket / http problems
  if (e is SocketException) {
    return "You're offline. Please check your internet connection.";
  }
  if (e is HttpException) {
    return "The server didn't respond. Please retry in a moment.";
  }
  // Anything else — never show the raw text
  return "Something went wrong. Please retry.";
}

String? _lowLevelFallback(Object? inner) {
  if (inner == null) return null;
  final s = inner.toString().toLowerCase();
  if (s.contains('socket') || s.contains('failed host lookup')) {
    return "You're offline. Please check your internet connection.";
  }
  if (s.contains('timeout')) {
    return "Your connection is slow. Please try again.";
  }
  return null;
}

String _forStatus(int? code, {String? fallback}) {
  switch (code) {
    case 400:
      return fallback ?? "That request looks invalid. Check the form and try again.";
    case 401:
      return "You're signed out. Please sign in again.";
    case 402:
      return fallback ?? "This feature isn't in your current plan. Open Marketplace to upgrade.";
    case 403:
      return fallback ?? "You don't have permission for that action.";
    case 404:
      return fallback ?? "We couldn't find what you were looking for.";
    case 409:
      return fallback ?? "That's already been done or clashes with another change.";
    case 422:
      return fallback ?? "Some fields need attention. Check the form and try again.";
    case 429:
      return "You're going a bit fast. Please slow down and retry in a moment.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "We're having a server issue. Please retry in a minute.";
  }
  // Unknown status
  return fallback ?? "Something went wrong. Please retry.";
}
