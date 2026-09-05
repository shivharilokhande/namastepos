// NamastePOS — the billing / addon reply helpers behind BillingScreen and
// MarketplaceScreen (CONTRACTS round 2 §6, MOB #2).

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/subscription.dart';
import 'package:namastepos/screens/billing/billing_screen.dart';
import 'package:namastepos/screens/marketplace/marketplace_screen.dart';
import 'package:namastepos/services/api_service.dart';

void main() {
  group('POST /billing/resume', () {
    test('requiresCheckout → opens checkout.checkoutOptions (change-plan shape)', () {
      final co = BillingReplies.resumeCheckoutOptions({
        'success': true,
        'resumed': false,
        'requiresCheckout': true,
        'checkout': {
          'subscriptionId': 'sub_123',
          'razorpayKeyId': 'rzp_live_x',
          'checkoutOptions': {
            'key': 'rzp_live_x',
            'subscription_id': 'sub_123',
            'name': 'NamastePOS',
            'description': 'Growth (monthly)',
          },
        },
        'message': 'Set up the payment mandate to bring Growth back.',
      });
      expect(co, isNotNull);
      expect(co!['key'], 'rzp_live_x');
      expect(co['subscription_id'], 'sub_123');
      expect(co['description'], 'Growth (monthly)'); // passed through unchanged
    });

    test('{ subscription } / resumed:true → no checkout', () {
      expect(BillingReplies.resumeCheckoutOptions({'resumed': true, 'status': 'active'}), isNull);
      expect(BillingReplies.resumeCheckoutOptions({'requiresCheckout': false}), isNull);
    });

    test('requiresCheckout with an unusable payload → null (caller errors, never opens)', () {
      expect(BillingReplies.resumeCheckoutOptions({'requiresCheckout': true}), isNull);
      expect(BillingReplies.resumeCheckoutOptions({
        'requiresCheckout': true,
        'checkout': {'checkoutOptions': {'key': 'k'}}, // no subscription_id
      }), isNull);
    });

    test('409 RESUME_NOT_ALLOWED and 403 ACCOUNT_SUSPENDED are humanised', () {
      expect(
        BillingReplies.resumeErrorMessage(
            ApiException('Resume is only for paused rows', 409, 'RESUME_NOT_ALLOWED')),
        contains('choose a plan'),
      );
      expect(
        BillingReplies.resumeErrorMessage(
            ApiException('Account suspended', 403, 'ACCOUNT_SUSPENDED')),
        'Account suspended — contact support.',
      );
      // Status-only fallbacks (a proxy that strips the body).
      expect(BillingReplies.resumeErrorMessage(ApiException('x', 409)), contains('choose a plan'));
      expect(BillingReplies.resumeErrorMessage(ApiException('x', 403)), contains('suspended'));
      // Anything else keeps the server text.
      expect(BillingReplies.resumeErrorMessage(ApiException('Boom', 500)), contains('Boom'));
    });

    test('ApiException carries the server error code', () {
      final e = ApiException('m', 409, 'RESUME_NOT_ALLOWED');
      expect(e.code, 'RESUME_NOT_ALLOWED');
      expect(e.toString(), contains('RESUME_NOT_ALLOWED'));
      expect(ApiException('m', 500).code, isNull);
    });
  });

  group('GET /billing banner copy', () {
    test('pendingPlan → "Moves to <name> on <date>"', () {
      final s = Subscription.fromMap({
        'id': 's', 'status': 'active',
        'currentPeriodEnd': '2026-10-01T00:00:00.000Z',
        'pendingPlan': {'code': 'free', 'name': 'Starter'},
      });
      expect(BillingReplies.pendingPlanLine(s), startsWith('Moves to Starter on 2026-'));
      expect(BillingReplies.pendingPlanLine(s), contains('-0'));
    });
    test('no pendingPlan → null', () {
      final s = Subscription.fromMap({'id': 's', 'status': 'active',
          'currentPeriodEnd': '2026-10-01T00:00:00.000Z'});
      expect(BillingReplies.pendingPlanLine(s), isNull);
    });
  });

  group('POST /addons/:slug/resume', () {
    test('requiresPayment → same checkout options as subscribe', () {
      final co = AddonReplies.checkoutOptions({
        'requiresPayment': true,
        'razorpayOrder': {'id': 'order_1', 'amount': 49900, 'currency': 'INR'},
        'keyId': 'rzp_live_x',
      }, description: 'Loyalty', contact: '9876543210');
      expect(co, {
        'key': 'rzp_live_x',
        'order_id': 'order_1',
        'amount': 49900,
        'currency': 'INR',
        'name': 'NamastePOS Add-on',
        'description': 'Loyalty',
        'prefill': {'contact': '9876543210'},
      });
    });

    test('{ activation } → no payment; broken payload → null', () {
      expect(AddonReplies.checkoutOptions({'activation': {'status': 'active'}},
          description: 'x'), isNull);
      expect(AddonReplies.checkoutOptions({'requiresPayment': true},
          description: 'x'), isNull);
      expect(AddonReplies.checkoutOptions({'requiresPayment': true,
          'razorpayOrder': {'id': 'o'}}, description: 'x'), isNull); // no key
    });

    test('409 ADDON_EXPIRED_REBUY is recognised (code, then message fallback)', () {
      expect(AddonReplies.isExpiredRebuy(
          ApiException('This add-on\'s paid period has ended.', 409, 'ADDON_EXPIRED_REBUY')),
          isTrue);
      expect(AddonReplies.isExpiredRebuy(
          ApiException('Paid period ended. Subscribe again to switch it back on.', 409)),
          isTrue);
      expect(AddonReplies.isExpiredRebuy(ApiException('Already subscribed', 409)), isFalse);
      expect(AddonReplies.isExpiredRebuy(ApiException('Needs Pro', 403)), isFalse);
    });

    test('cancel-at-period-end row → "Ends <date>", else null', () {
      final ending = AddonActivation.fromMap({
        'addon': {'slug': 'loyalty', 'name': 'Loyalty'},
        'status': 'active',
        'cancelAtPeriodEnd': true,
        'currentPeriodEnd': '2026-10-01T00:00:00.000Z',
      });
      expect(AddonReplies.endsLine(ending), startsWith('Ends 2026-'));
      final live = AddonActivation.fromMap({
        'addon': {'slug': 'loyalty'}, 'status': 'active',
        'cancelAtPeriodEnd': false, 'currentPeriodEnd': '2026-10-01T00:00:00.000Z',
      });
      expect(AddonReplies.endsLine(live), isNull);
      final gone = AddonActivation.fromMap({
        'addon': {'slug': 'loyalty'}, 'status': 'cancelled',
        'cancelAtPeriodEnd': true, 'currentPeriodEnd': '2026-09-01T00:00:00.000Z',
      });
      expect(AddonReplies.endsLine(gone), isNull); // free addon: ended now
      expect(AddonReplies.endsLine(null), isNull);
    });
  });
}
