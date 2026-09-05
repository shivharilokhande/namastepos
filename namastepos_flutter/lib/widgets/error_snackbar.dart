// NamastePOS — one SnackBar for API failures (2026-09-05, review #11).
//
// `humanizeError` already turns every failure into a sentence; what it cannot
// do is offer the fix. A 402 FEATURE_LOCKED is the one error the owner can
// resolve on the spot — by opening Plans & billing — yet each screen rendered
// it as a dead-end string. Route 402s through here and the SnackBar grows a
// "View plans" action; every other status stays a plain message. Screens keep
// their own prefix ("Could not place order: …") via [prefix].

import 'package:dio/dio.dart' show DioException;
import 'package:flutter/material.dart';

import '../constants/colors.dart';
import '../screens/billing/billing_screen.dart';
import '../services/api_service.dart';
import '../utils/error_humanizer.dart';

/// HTTP status carried by [e], if it is one of the two error types the app
/// throws for API calls; null for anything else.
int? apiStatusOf(Object e) {
  if (e is ApiException) return e.statusCode;
  if (e is DioException) return e.response?.statusCode;
  return null;
}

/// Show [e] humanised. On a 402 the bar carries a "View plans" action that
/// pushes [BillingScreen]. [messenger] lets callers that captured a
/// ScaffoldMessenger before an `await` keep using it; [context] is only needed
/// to navigate on tap (the action does nothing if it is gone).
void showApiErrorSnackBar(
  BuildContext context,
  Object e, {
  String? prefix,
  ScaffoldMessengerState? messenger,
  Color? backgroundColor,
}) {
  final m = messenger ?? ScaffoldMessenger.maybeOf(context);
  if (m == null) return;
  final text = humanizeError(e);
  final locked = apiStatusOf(e) == 402;
  m.showSnackBar(SnackBar(
    content: Text(prefix == null ? text : '$prefix$text'),
    backgroundColor: backgroundColor ?? (locked ? AppColors.warning : AppColors.error),
    duration: locked ? const Duration(seconds: 6) : const Duration(seconds: 4),
    action: locked
        ? SnackBarAction(
            label: 'View plans',
            textColor: Colors.white,
            onPressed: () {
              if (!context.mounted) return;
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const BillingScreen(),
              ));
            },
          )
        : null,
  ));
}
