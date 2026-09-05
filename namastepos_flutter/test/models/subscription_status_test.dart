// NamastePOS — /billing row parsing for CONTRACTS round 2 §6 (MOB #2).
//
// status 'suspended' (and anything unknown) must never throw; pendingPlan,
// reactivationPending and suspension are read; the resume offer follows the
// server's own rules (paused or active+cancelAtPeriodEnd; never suspended).

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/subscription.dart';

Map<String, dynamic> _row({
  String status = 'active',
  Map<String, dynamic>? extra,
}) =>
    {
      'id': 's-1',
      'status': status,
      'currentPeriodEnd': '2026-10-01T00:00:00.000Z',
      'cancelAtPeriodEnd': false,
      'billingPeriod': 'monthly',
      'plan': {
        'id': 'p-1', 'tier': 'basic', 'name': 'Growth', 'priceInr': 299,
        'limits': {'staff': '3'}, 'features': {},
      },
      ...?extra,
    };

void main() {
  group('status parsing never throws', () {
    test('suspended', () {
      final s = Subscription.fromMap(_row(status: 'suspended', extra: {
        'suspendedAt': '2026-09-01T10:00:00.000Z',
        'suspension': {
          'suspended': true,
          'suspendedAt': '2026-09-01T10:00:00.000Z',
          'message': 'Account suspended — contact support.',
        },
      }));
      expect(s.isSuspended, isTrue);
      expect(s.isActive, isFalse);
      expect(s.isPaused, isFalse);
      expect(s.canOfferResume, isFalse);
      expect(s.suspension!.since, DateTime.utc(2026, 9, 1, 10));
      expect(s.suspension!.message, SuspensionInfo.defaultMessage);
    });

    test('suspended by status alone (older serialiser) still builds the block', () {
      final s = Subscription.fromMap(_row(status: 'suspended'));
      expect(s.isSuspended, isTrue);
      expect(s.suspension, isNotNull);
      expect(s.suspension!.message, SuspensionInfo.defaultMessage);
    });

    test('a status this build has never seen', () {
      final s = Subscription.fromMap(_row(status: 'quantum_flux'));
      expect(s.status, 'quantum_flux');
      expect(s.isActive, isFalse);
      expect(s.isPaused, isFalse);
      expect(s.isSuspended, isFalse);
      expect(s.isTrialing, isFalse);
      expect(s.canOfferResume, isFalse);
      expect(s.trialExpired, isFalse);
    });

    test('missing / null status defaults and odd field shapes are tolerated', () {
      final s = Subscription.fromMap({
        'id': null, 'status': null, 'plan': 'not-a-map',
        'pendingPlan': 'garbage', 'suspension': 42, 'reactivationPending': 'yes',
      });
      expect(s.status, 'trialing');
      expect(s.plan, isNull);
      expect(s.pendingPlan, isNull);
      expect(s.suspension, isNull);
      expect(s.reactivationPending, isFalse);
    });
  });

  group('pendingPlan', () {
    test('reads the server plan card and falls back to currentPeriodEnd', () {
      final s = Subscription.fromMap(_row(extra: {
        'pendingPlan': {'id': 'p-0', 'tier': 'free', 'code': 'free', 'name': 'Starter'},
      }));
      expect(s.pendingPlan!.name, 'Starter');
      expect(s.pendingPlan!.code, 'free');
      expect(s.pendingPlan!.effectiveAt, isNull);
      expect(s.pendingPlanEffectiveAt, DateTime.utc(2026, 10, 1));
    });

    test('honours an explicit effectiveAt', () {
      final s = Subscription.fromMap(_row(extra: {
        'pendingPlan': {'code': 'free', 'name': 'Starter', 'effectiveAt': '2026-11-15T00:00:00.000Z'},
      }));
      expect(s.pendingPlanEffectiveAt, DateTime.utc(2026, 11, 15));
    });

    test('null pendingPlan (the normal case)', () {
      final s = Subscription.fromMap(_row(extra: {'pendingPlan': null}));
      expect(s.pendingPlan, isNull);
      expect(s.pendingPlanEffectiveAt, isNull);
    });
  });

  group('reactivationPending + resume offer', () {
    test('paused → offer resume', () {
      expect(Subscription.fromMap(_row(status: 'paused')).canOfferResume, isTrue);
    });
    test('active + cancelAtPeriodEnd → offer resume (undo cancel)', () {
      expect(
        Subscription.fromMap(_row(extra: {'cancelAtPeriodEnd': true})).canOfferResume,
        isTrue,
      );
    });
    test('plain active → no resume', () {
      expect(Subscription.fromMap(_row()).canOfferResume, isFalse);
    });
    test('past_due / cancelled / trialing → 409 server-side, so not offered', () {
      for (final st in ['past_due', 'cancelled', 'trialing']) {
        expect(Subscription.fromMap(_row(status: st, extra: {'cancelAtPeriodEnd': true}))
            .canOfferResume, isFalse, reason: st);
      }
    });
    test('reactivationPending suppresses the resume button', () {
      final s = Subscription.fromMap(_row(status: 'paused', extra: {'reactivationPending': true}));
      expect(s.reactivationPending, isTrue);
      expect(s.canOfferResume, isFalse);
    });
  });
}
