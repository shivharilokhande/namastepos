// Round 3 (2026-09-06) — wallet tender body, session due/settled state and
// membership exhaustion, as used by confirm_order_screen + captain settle.

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/utils/checkout_money.dart';

void main() {
  group('WalletTender.bodyFields (Bug 1: what the request carries)', () {
    test('toggle ON, no cap → autoWallet:true and NO walletCapInr key', () {
      final b = WalletTender.bodyFields(useWallet: true, walletAvailable: true);
      expect(b['autoWallet'], isTrue);
      expect(b.containsKey('walletCapInr'), isFalse);
    });

    test('toggle ON + typed cap → walletCapInr reflects the typed amount', () {
      final b = WalletTender.bodyFields(
          useWallet: true, walletAvailable: true, capText: '84');
      expect(b['autoWallet'], isTrue);
      expect(b['walletCapInr'], 84.0);
      // 2dp rounding, same as the wire value.
      expect(
        WalletTender.bodyFields(
            useWallet: true, walletAvailable: true, capText: '50.005')['walletCapInr'],
        50.01,
      );
    });

    test('toggle OFF / no wallet / KOT-only / manual split → autoWallet:false, no cap', () {
      for (final b in [
        WalletTender.bodyFields(useWallet: false, walletAvailable: true, capText: '84'),
        WalletTender.bodyFields(useWallet: true, walletAvailable: false, capText: '84'),
        WalletTender.bodyFields(
            useWallet: true, walletAvailable: true, kotOnly: true, capText: '84'),
        WalletTender.bodyFields(
            useWallet: true, walletAvailable: true, hasSplits: true, capText: '84'),
      ]) {
        expect(b['autoWallet'], isFalse);
        expect(b.containsKey('walletCapInr'), isFalse);
      }
    });

    test('parseCap: blank / junk / zero / negative → null', () {
      expect(WalletTender.parseCap(''), isNull);
      expect(WalletTender.parseCap('  '), isNull);
      expect(WalletTender.parseCap('abc'), isNull);
      expect(WalletTender.parseCap('0'), isNull);
      expect(WalletTender.parseCap('-5'), isNull);
      expect(WalletTender.parseCap(' 12.5 '), 12.5);
    });
  });

  group('WalletTender.plannedUse (due shown = total − points − wallet)', () {
    test('founder flow: ₹120 − 36 pts = ₹84 due, wallet ₹135.37 → wallet pays 84', () {
      expect(WalletTender.plannedUse(due: 84, balance: 135.37), 84.0);
    });
    test('cap limits the draw; balance limits the draw', () {
      expect(WalletTender.plannedUse(due: 84, balance: 135.37, cap: 50), 50.0);
      expect(WalletTender.plannedUse(due: 84, balance: 30), 30.0);
      expect(WalletTender.plannedUse(due: 0, balance: 30), 0.0);
      expect(WalletTender.plannedUse(due: 84, balance: 0), 0.0);
    });
  });

  group('WalletTender shortfall (Bug 1b)', () {
    test('hasShortfall only when balance < due (paise compare)', () {
      expect(WalletTender.hasShortfall(due: 84, balance: 50), isTrue);
      expect(WalletTender.hasShortfall(due: 84, balance: 84), isFalse);
      expect(WalletTender.hasShortfall(due: 84, balance: 84.004), isFalse);
      expect(WalletTender.hasShortfall(due: 0, balance: 0), isFalse);
    });

    test('shortfallLegs: wallet = balance, rest via chosen method, sums to due', () {
      final legs = WalletTender.shortfallLegs(due: 84, balance: 50, method: 'upi');
      expect(legs, [
        {'method': 'wallet', 'amountInr': 50.0},
        {'method': 'upi', 'amountInr': 34.0},
      ]);
      final sum = legs.fold<double>(0, (s, l) => s + (l['amountInr'] as double));
      expect(sum, 84.0);
    });

    test('shortfallLegs: paise-exact on awkward decimals', () {
      final legs = WalletTender.shortfallLegs(due: 84.10, balance: 33.33, method: 'cash');
      expect(legs[0]['amountInr'], 33.33);
      expect(legs[1]['amountInr'], 50.77);
    });

    test('shortfallLegs: wallet covers it → single wallet leg; zero wallet → single method leg', () {
      expect(WalletTender.shortfallLegs(due: 84, balance: 135.37, method: 'cash'),
          [{'method': 'wallet', 'amountInr': 84.0}]);
      expect(WalletTender.shortfallLegs(due: 84, balance: 0, method: 'card'),
          [{'method': 'card', 'amountInr': 84.0}]);
      expect(WalletTender.shortfallLegs(due: 0, balance: 10, method: 'cash'), isEmpty);
    });

    test('shortfallLegs: unknown residual method falls back to cash', () {
      final legs = WalletTender.shortfallLegs(due: 84, balance: 50, method: 'wallet');
      expect(legs[1]['method'], 'cash');
    });
  });

  group('WalletTender.walletPaid / balanceFrom (refresh after Pay & place)', () {
    test('sums only wallet legs', () {
      expect(
        WalletTender.walletPaid([
          {'method': 'wallet', 'amountInr': 84},
          {'method': 'cash', 'amountInr': 36},
        ]),
        84.0,
      );
      expect(WalletTender.walletPaid(null), 0);
    });

    test('balanceFrom reads round-3, legacy top-up and GET /wallet shapes', () {
      expect(WalletTender.balanceFrom({'wallet': {'balancePaise': 5137}, 'transaction': {'id': 't'}}), 51.37);
      expect(WalletTender.balanceFrom({'balance': 51.37}), 51.37);
      expect(WalletTender.balanceFrom({'balanceInr': 51.37, 'transactions': []}), 51.37);
      expect(WalletTender.balanceFrom({}), isNull);
      expect(WalletTender.balanceFrom(null), isNull);
    });
  });

  group('SessionDue (settle screen: Paid + disabled when nothing is due)', () {
    test('server fields win: duePaise 0 / isSettled → settled, no due', () {
      final d = SessionDue.fromSession({
        'totalInr': 84.0,
        'totalPaise': 8400,
        'paidPaise': 8400,
        'duePaise': 0,
        'isSettled': true,
        'orders': [
          {'id': 'o1', 'total': 84.0, 'status': 'placed', 'paymentMethod': 'wallet',
           'paymentBreakdown': [{'method': 'wallet', 'amountInr': 84}]},
        ],
      });
      expect(d.fromServer, isTrue);
      expect(d.isSettled, isTrue);
      expect(d.hasDue, isFalse);
      expect(d.dueInr, 0);
      expect(d.paidInr, 84.0);
      expect(d.legs.map((l) => l.toString()), ['wallet:8400']);
    });

    test('server fields: part paid → due = duePaise, still has due', () {
      final d = SessionDue.fromSession({
        'totalPaise': 20000,
        'paidPaise': 8400,
        'duePaise': 11600,
        'isSettled': false,
        'orders': [],
      });
      expect(d.hasDue, isTrue);
      expect(d.dueInr, 116.0);
      expect(d.paidInr, 84.0);
      expect(d.totalInr, 200.0);
    });

    test('server sends duePaise only → paid derived from total − due', () {
      final d = SessionDue.fromSession({
        'totalInr': 200.0,
        'duePaise': 11600,
      });
      expect(d.fromServer, isTrue);
      expect(d.paidPaise, 8400);
      expect(d.isSettled, isFalse);
    });

    test('older server (no paise fields): due = Σ unpaid KOTs, paid = Σ tendered KOTs', () {
      final d = SessionDue.fromSession({
        'totalInr': 200.0,
        'status': 'open',
        'orders': [
          {'id': 'a', 'total': 84.0, 'status': 'placed', 'paymentMethod': 'wallet'},
          {'id': 'b', 'total': 116.0, 'status': 'placed', 'paymentMethod': 'unpaid'},
          {'id': 'c', 'total': 999.0, 'status': 'cancelled', 'paymentMethod': 'unpaid'},
        ],
      });
      expect(d.fromServer, isFalse);
      expect(d.paidInr, 84.0);
      expect(d.dueInr, 116.0);
      expect(d.hasDue, isTrue);
      expect(d.isSettled, isFalse);
      // Paid KOT without a breakdown → its paymentMethod becomes the leg.
      expect(d.legs.map((l) => l.toString()), ['wallet:8400']);
    });

    test('older server: every KOT paid at Pay & place → Paid, settle disabled', () {
      final d = SessionDue.fromSession({
        'totalInr': 84.0,
        'orders': [
          {'id': 'a', 'total': 84.0, 'status': 'placed', 'paymentMethod': 'wallet',
           'paymentBreakdown': [
             {'method': 'wallet', 'amountInr': 50},
             {'method': 'cash', 'amountInr': 34},
           ]},
        ],
      });
      expect(d.isSettled, isTrue);
      expect(d.hasDue, isFalse);
      expect(d.legs.map((l) => l.toString()), ['wallet:5000', 'cash:3400']);
    });

    test('legs aggregate per method across KOTs; session-level payments win', () {
      final byOrders = SessionDue.fromSession({
        'totalInr': 300.0,
        'orders': [
          {'id': 'a', 'total': 100.0, 'status': 'placed', 'paymentMethod': 'cash'},
          {'id': 'b', 'total': 200.0, 'status': 'placed', 'paymentMethod': 'cash',
           'paymentBreakdown': [
             {'method': 'wallet', 'amountInr': 150},
             {'method': 'cash', 'amountInr': 50},
           ]},
        ],
      });
      expect(byOrders.legs.map((l) => l.toString()), ['cash:15000', 'wallet:15000']);

      final bySession = SessionDue.fromSession({
        'totalPaise': 30000, 'paidPaise': 30000, 'duePaise': 0, 'isSettled': true,
        'payments': [{'method': 'upi', 'amountPaise': 30000}],
        'orders': [
          {'id': 'a', 'total': 300.0, 'status': 'placed', 'paymentMethod': 'cash'},
        ],
      });
      expect(bySession.legs.map((l) => l.toString()), ['upi:30000']);
    });

    test('empty session (seated, nothing ordered) → no due, not "settled"', () {
      final d = SessionDue.fromSession({'totalInr': 0.0, 'orders': []});
      expect(d.hasDue, isFalse);
      expect(d.isSettled, isFalse);
    });
  });

  group('MembershipStatus (Bug 2: exhausted → renew card)', () {
    test('round-3 shape: exhausted active membership + available plans', () {
      final s = MembershipStatus.fromLookup({
        'customer': {'id': 'c1'},
        'activeMembership': {
          'id': 'sub1', 'membershipId': 'm1', 'name': 'Gold',
          'remaining': [{'menuItemId': 'i1', 'name': 'Pav Bhaji', 'qty': 0}],
          'exhausted': true, 'expired': false,
          'expiresAt': '2026-10-01T00:00:00.000Z', 'renewPricePaise': 49900,
        },
        'availableMemberships': [
          {'id': 'm1', 'name': 'Gold', 'pricePaise': 49900, 'validityDays': 30, 'includes': []},
          {'id': 'm2', 'name': 'Silver', 'pricePaise': 29900, 'validityDays': 30, 'includes': []},
        ],
      });
      expect(s.hasActive, isTrue);
      expect(s.exhausted, isTrue);
      expect(s.needsRenewal, isTrue);
      expect(s.usable, isFalse);
      expect(s.name, 'Gold');
      expect(s.renewPricePaise, 49900);
      expect(s.renewOffer!['membership_id'], 'm1');
      expect(s.renewOffer!['price_paise'], 49900);
      expect(s.available.length, 2);
      expect(s.availableAsPlans[1], {
        'id': 'm2', 'name': 'Silver', 'price_paise': 29900, 'validity_days': 30,
      });
    });

    test('round-3 shape: expired flag → needsRenewal; healthy → usable', () {
      final expired = MembershipStatus.fromLookup({
        'activeMembership': {'id': 's', 'membershipId': 'm', 'name': 'Gold',
          'remaining': [], 'exhausted': false, 'expired': true, 'renewPricePaise': 100},
        'availableMemberships': [],
      });
      expect(expired.needsRenewal, isTrue);
      expect(expired.expired, isTrue);

      final ok = MembershipStatus.fromLookup({
        'activeMembership': {'id': 's', 'membershipId': 'm', 'name': 'Gold',
          'remaining': [{'menuItemId': 'i', 'qty': 3}], 'exhausted': false, 'expired': false},
      });
      expect(ok.usable, isTrue);
      expect(ok.needsRenewal, isFalse);
    });

    test('round-3 shape: activeMembership null + plans → offer chip case', () {
      final s = MembershipStatus.fromLookup({
        'activeMembership': null,
        'availableMemberships': [{'id': 'm2', 'name': 'Silver', 'pricePaise': 29900, 'validityDays': 30}],
      });
      expect(s.hasActive, isFalse);
      expect(s.needsRenewal, isFalse);
      expect(s.available.length, 1);
    });

    test('legacy shape: active with every bundle qty at 0 → exhausted', () {
      final s = MembershipStatus.fromLookup({
        'membership': {
          'subscription_id': 'sub1', 'membership_id': 'm1', 'name': 'Gold',
          'price_paise': 49900, 'validity_days': 30, 'expires_at': '2026-10-01T00:00:00Z',
          'remaining': [{'menuItemId': 'i1', 'qty': 0}, {'menuItemId': 'i2', 'qty': 0}],
        },
        'expiredMembership': null,
      });
      expect(s.exhausted, isTrue);
      expect(s.needsRenewal, isTrue);
      expect(s.renewPricePaise, 49900);
      expect(s.available, isEmpty); // legacy lookup carries no plan list
    });

    test('legacy shape: bundle left / perk-only plan → usable; expired row → expired', () {
      expect(
        MembershipStatus.fromLookup({
          'membership': {'membership_id': 'm1', 'name': 'Gold',
            'remaining': [{'menuItemId': 'i1', 'qty': 2}]},
        }).usable,
        isTrue,
      );
      expect(
        MembershipStatus.fromLookup({
          'membership': {'membership_id': 'm1', 'name': 'Gold', 'remaining': null},
        }).usable,
        isTrue,
      );
      final ex = MembershipStatus.fromLookup({
        'membership': null,
        'expiredMembership': {'membership_id': 'm1', 'name': 'Gold',
          'price_paise': 49900, 'validity_days': 30, 'expires_at': '2026-08-01T00:00:00Z'},
      });
      expect(ex.expired, isTrue);
      expect(ex.needsRenewal, isTrue);
      expect(ex.renewOffer!['expires_at'], '2026-08-01T00:00:00Z');
    });

    test('null / no customer → empty', () {
      expect(MembershipStatus.fromLookup(null).hasActive, isFalse);
      expect(MembershipStatus.fromLookup({'customer': null}).hasActive, isFalse);
    });
  });
}
