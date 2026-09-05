// NamastePOS — what the two checkouts may do with a customer (2026-09-05,
// review #1).
//
// Pay & Place (confirm_order_screen) and the captain settle sheet
// (captain_screen) both look a customer up by phone and then decide whether
// to offer points, wallet and a membership. Until today the POS keyed all of
// that on `SubscriptionProvider.hasAddon('loyalty')` — a MARKETPLACE ADDON
// SLUG, i.e. "did this tenant buy the loyalty addon" — while `loyalty` is a
// PLAN feature on Growth and up. A Growth tenant who never bought the addon
// got no customer attach, no points, no wallet tender at the till, and the
// captain settle disagreed because it never checked anything. Same slug≠key
// class of bug as the 2026-09-03 addon audit.
//
// Feature keys are the one vocabulary (see feature_keys.dart); an addon that
// grants a key shows up in `/auth/me` → plan.features like any plan does, so
// asking `auth.has(...)` covers both routes to the entitlement. Both
// checkouts read THIS class so they cannot drift apart again.

import '../constants/feature_keys.dart';
import '../providers/auth_provider.dart';

class CheckoutGates {
  /// May attach a customer to the bill (phone lookup, customerId on the
  /// order). `customers_basic` is the baseline customers key.
  final bool customers;

  /// Points redemption, loyalty rules and the prepaid wallet tender — all
  /// server-side under the `loyalty` key (the wallet endpoints 402 without it).
  final bool loyalty;

  /// The buy/renew membership offer at payment time.
  final bool memberships;

  const CheckoutGates({
    required this.customers,
    required this.loyalty,
    required this.memberships,
  });

  /// Fail-closed like everything else: an unloaded plan denies all three.
  factory CheckoutGates.of(AuthProvider auth) => CheckoutGates(
        customers: auth.has(Features.customersBasic),
        loyalty: auth.has(Features.loyalty),
        memberships: auth.has(Features.memberships),
      );
}
