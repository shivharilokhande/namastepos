// NamastePOS — pure money/tender arithmetic shared by the two checkouts
// (2026-09-06, round 3 Bug 1 / 1b / 2).
//
// WHY a widget-free module: the founder's report ("wallet toggle was ON but
// ₹84 was not deducted; settle still showed ₹84 and stayed enabled") is a
// question about what the request body carries and what the running bill
// computes — both were buried inside build() methods and could only be
// checked by hand on a device. Everything here is plain Dart so
// `flutter test` pins the contract:
//
//   * [WalletTender]     — order/settle body fields for the wallet toggle +
//                          cap, the estimated wallet draw, and the explicit
//                          "cover shortfall" paymentBreakdown legs.
//   * [SessionDue]       — total / paid / due / isSettled for a table session,
//                          preferring the server's paise fields (backend
//                          round-3 contract) and falling back to the per-KOT
//                          paymentMethod sums for an older server.
//   * [MembershipStatus] — active-but-exhausted / expired detection plus the
//                          purchasable plan list, from either the new
//                          `activeMembership` / `availableMemberships` lookup
//                          shape or the legacy `membership` /
//                          `expiredMembership` one.
//
// Money rule (feedback_namastepos_money_billing_gst): integers in paise for
// comparisons; ₹ doubles only at the wire/display edge, rounded to 2dp.

int _paise(num? inr) => ((inr ?? 0) * 100).round();
double _inr2(num v) => double.parse(v.toStringAsFixed(2));

/// Methods the order/settle contracts accept as the residual tender after a
/// wallet leg. 'online' is kept for the captain's "Other / Online" tile.
const kResidualTenderMethods = ['cash', 'upi', 'card', 'online'];

class WalletTender {
  WalletTender._();

  /// Parse the optional "max wallet to use" field. Blank / unparsable /
  /// non-positive → null, which the server reads as "up to the full balance".
  static double? parseCap(String text) {
    final t = text.trim();
    if (t.isEmpty) return null;
    final v = double.tryParse(t);
    if (v == null || v <= 0) return null;
    return _inr2(v);
  }

  /// The two wallet fields the order-create / settle body carries. Mirrors
  /// the guards in confirm_order_screen: never on a KOT-only save, never
  /// while a manual split is active (the split's own wallet leg wins), never
  /// without a wallet-enabled customer. `walletCapInr` only rides along when
  /// autoWallet is true — the server ignores it otherwise and an older Joi
  /// schema could 400 on the stray key.
  static Map<String, dynamic> bodyFields({
    required bool useWallet,
    required bool walletAvailable,
    bool kotOnly = false,
    bool hasSplits = false,
    String capText = '',
  }) {
    final auto = !kotOnly && useWallet && walletAvailable && !hasSplits;
    final cap = auto ? parseCap(capText) : null;
    return {
      'autoWallet': auto,
      if (auto && cap != null) 'walletCapInr': cap,
    };
  }

  /// What the server will draw from the wallet: min(due, balance, cap), never
  /// negative. Same arithmetic as orderService's autoWallet translation, so
  /// the "Wallet −₹X / To collect ₹Y" rows on the confirm screen match the
  /// legs that come back on the order.
  static double plannedUse({
    required double due,
    required double balance,
    double? cap,
  }) {
    var usePaise = _paise(due);
    usePaise = usePaise < _paise(balance) ? usePaise : _paise(balance);
    if (cap != null) {
      final capPaise = _paise(cap);
      if (capPaise < usePaise) usePaise = capPaise;
    }
    if (usePaise < 0) usePaise = 0;
    return usePaise / 100;
  }

  /// True when the wallet cannot cover the whole due — the "Cover shortfall"
  /// / "Top up wallet" affordances only make sense then.
  static bool hasShortfall({required double due, required double balance}) =>
      _paise(due) > 0 && _paise(balance) < _paise(due);

  /// Explicit `paymentBreakdown` for "Cover shortfall": the wallet pays what
  /// it has, the remainder goes to [method]. Legs are positive, ≤ 2, and sum
  /// to the due exactly (paise arithmetic), which is what the strict server
  /// contract (±₹0.01) requires. Wallet ≥ due → single wallet leg.
  static List<Map<String, dynamic>> shortfallLegs({
    required double due,
    required double balance,
    required String method,
  }) {
    final duePaise = _paise(due);
    final balPaise = _paise(balance);
    if (duePaise <= 0) return const [];
    final walletPaise = balPaise >= duePaise ? duePaise : (balPaise > 0 ? balPaise : 0);
    final restPaise = duePaise - walletPaise;
    final m = kResidualTenderMethods.contains(method) ? method : 'cash';
    return [
      if (walletPaise > 0) {'method': 'wallet', 'amountInr': walletPaise / 100},
      if (restPaise > 0) {'method': m, 'amountInr': restPaise / 100},
    ];
  }

  /// Sum of the wallet legs on an order's paymentBreakdown (₹).
  static double walletPaid(List<Map<String, dynamic>>? legs) {
    if (legs == null) return 0;
    var p = 0;
    for (final l in legs) {
      if ((l['method'] as String?) == 'wallet') p += _paise(l['amountInr'] as num?);
    }
    return p / 100;
  }

  /// Parse a wallet read/top-up reply into a ₹ balance. Accepts the round-3
  /// top-up shape `{ wallet: { balancePaise } }`, the legacy top-up shape
  /// `{ balance }` and the GET /wallet shape `{ balanceInr }`.
  static double? balanceFrom(Map<String, dynamic>? r) {
    if (r == null) return null;
    final w = r['wallet'];
    if (w is Map && w['balancePaise'] is num) {
      return (w['balancePaise'] as num) / 100;
    }
    if (r['balancePaise'] is num) return (r['balancePaise'] as num) / 100;
    if (r['balanceInr'] is num) return (r['balanceInr'] as num).toDouble();
    if (r['balance'] is num) return (r['balance'] as num).toDouble();
    return null;
  }
}

/// One tender leg on a running bill, aggregated per method.
class PaymentLeg {
  final String method;
  final int amountPaise;
  const PaymentLeg(this.method, this.amountPaise);
  double get amountInr => amountPaise / 100;

  @override
  String toString() => '$method:$amountPaise';
}

/// Money state of a table session for the running-bill sheet.
class SessionDue {
  final int totalPaise;
  final int paidPaise;
  final int duePaise;
  final bool isSettled;
  /// Tender legs already collected (wallet ₹84, cash ₹36 …), per method.
  final List<PaymentLeg> legs;
  /// True when the server supplied the paise fields (round-3 contract);
  /// false when they were derived from the per-KOT paymentMethod fallback.
  final bool fromServer;

  const SessionDue({
    required this.totalPaise,
    required this.paidPaise,
    required this.duePaise,
    required this.isSettled,
    required this.legs,
    required this.fromServer,
  });

  double get totalInr => totalPaise / 100;
  double get paidInr => paidPaise / 100;
  double get dueInr => duePaise / 100;
  bool get hasDue => duePaise > 0 && !isSettled;

  /// Build from GET /ops/sessions/:id → `session`.
  ///
  /// Server fields win when present (`totalPaise`, `paidPaise`, `duePaise`,
  /// `isSettled`). Otherwise: every non-cancelled KOT whose paymentMethod is a
  /// real tender counts as paid (the "Pay & place" flow), the rest is due —
  /// the rule the sheet has used since 2026-08-25.
  factory SessionDue.fromSession(Map<String, dynamic> s) {
    final orders = ((s['orders'] as List?) ?? const [])
        .whereType<Map>()
        .where((o) => o['status'] != 'cancelled')
        .toList();

    // ── legs (either shape) ────────────────────────────────────────────
    final byMethod = <String, int>{};
    void addLeg(String? method, int paise) {
      if (method == null || method.isEmpty || method == 'unpaid' || paise <= 0) return;
      byMethod[method] = (byMethod[method] ?? 0) + paise;
    }
    int legPaise(Map l) {
      if (l['amountPaise'] is num) return (l['amountPaise'] as num).round();
      return _paise(l['amountInr'] as num?);
    }
    final sessionLegs = (s['payments'] ?? s['paymentLegs']) as List?;
    if (sessionLegs != null && sessionLegs.isNotEmpty) {
      for (final l in sessionLegs.whereType<Map>()) {
        addLeg(l['method']?.toString(), legPaise(l));
      }
    } else {
      for (final o in orders) {
        final pm = (o['paymentMethod'] as String?) ?? '';
        final ob = (o['paymentBreakdown'] ?? o['payments']) as List?;
        if (ob != null && ob.isNotEmpty) {
          for (final l in ob.whereType<Map>()) {
            addLeg(l['method']?.toString(), legPaise(l));
          }
        } else if (pm.isNotEmpty && pm != 'unpaid') {
          addLeg(pm, _paise(o['total'] as num?));
        }
      }
    }
    final legs = [for (final e in byMethod.entries) PaymentLeg(e.key, e.value)];

    // ── server paise fields (round-3 contract) ─────────────────────────
    final hasServer = s['duePaise'] is num || s['isSettled'] is bool;
    if (hasServer) {
      final total = s['totalPaise'] is num
          ? (s['totalPaise'] as num).round()
          : _paise(s['totalInr'] as num?);
      final due = s['duePaise'] is num ? (s['duePaise'] as num).round() : 0;
      final paid = s['paidPaise'] is num
          ? (s['paidPaise'] as num).round()
          : (total - due).clamp(0, total);
      final settled = s['isSettled'] == true || due <= 0;
      return SessionDue(
        totalPaise: total,
        paidPaise: paid,
        duePaise: due < 0 ? 0 : due,
        isSettled: settled,
        legs: legs,
        fromServer: true,
      );
    }

    // ── fallback: per-KOT paymentMethod sums ───────────────────────────
    var paid = 0, due = 0;
    for (final o in orders) {
      final pm = (o['paymentMethod'] as String?) ?? '';
      final t = _paise(o['total'] as num?);
      if (pm.isNotEmpty && pm != 'unpaid') {
        paid += t;
      } else {
        due += t;
      }
    }
    final total = s['totalInr'] is num ? _paise(s['totalInr'] as num) : paid + due;
    return SessionDue(
      totalPaise: total,
      paidPaise: paid,
      duePaise: due,
      isSettled: s['status'] == 'closed' || (total > 0 && due <= 0),
      legs: legs,
      fromServer: false,
    );
  }
}

/// Membership context from the customer lookup, normalised for the checkout.
class MembershipStatus {
  /// Active subscription (may be exhausted/expired), or null when the
  /// customer has none. Keys: id, membershipId, name, remaining (List),
  /// exhausted, expired, expiresAt, renewPricePaise, validityDays.
  final Map<String, dynamic>? active;
  /// Plans the customer could buy, normalised to
  /// {id, name, pricePaise, validityDays}.
  final List<Map<String, dynamic>> available;

  const MembershipStatus({this.active, this.available = const []});

  static const empty = MembershipStatus();

  bool get hasActive => active != null;
  bool get exhausted => active?['exhausted'] == true;
  bool get expired => active?['expired'] == true;
  /// The card/dialog case: a membership exists but is used up or lapsed.
  bool get needsRenewal => hasActive && (exhausted || expired);
  /// A bundle that still covers items on this bill.
  bool get usable => hasActive && !needsRenewal;
  String get name => (active?['name'] as String?) ?? 'Membership';
  int get renewPricePaise => (active?['renewPricePaise'] as num?)?.round() ?? 0;

  /// Shape the existing membership offer dialog takes for its renew branch.
  Map<String, dynamic>? get renewOffer => active == null
      ? null
      : {
          'membership_id': active!['membershipId'],
          'name': active!['name'],
          'price_paise': active!['renewPricePaise'],
          'validity_days': active!['validityDays'],
          'expires_at': active!['expiresAt'],
        };

  /// Plans in the snake_case shape `/memberships` returns (what the offer
  /// dialog and customer-detail picker already render).
  List<Map<String, dynamic>> get availableAsPlans => [
        for (final p in available)
          {
            'id': p['id'],
            'name': p['name'],
            'price_paise': p['pricePaise'],
            'validity_days': p['validityDays'],
          },
      ];

  /// Accepts the round-3 lookup (`activeMembership`, `availableMemberships`)
  /// and the legacy one (`membership`, `expiredMembership`, snake_case rows).
  factory MembershipStatus.fromLookup(Map<String, dynamic>? data) {
    if (data == null) return empty;

    final avail = <Map<String, dynamic>>[];
    final rawAvail = data['availableMemberships'];
    if (rawAvail is List) {
      for (final p in rawAvail.whereType<Map>()) {
        avail.add({
          'id': p['id']?.toString(),
          'name': p['name']?.toString() ?? 'Plan',
          'pricePaise': (p['pricePaise'] as num?)?.round() ??
              (p['price_paise'] as num?)?.round() ?? 0,
          'validityDays': (p['validityDays'] as num?)?.round() ??
              (p['validity_days'] as num?)?.round() ?? 30,
        });
      }
    }

    Map<String, dynamic>? active;
    final am = data['activeMembership'];
    if (am is Map) {
      final remaining = (am['remaining'] as List?)?.whereType<Map>()
          .map((e) => e.cast<String, dynamic>()).toList() ?? const <Map<String, dynamic>>[];
      active = {
        'id': am['id']?.toString(),
        'membershipId': am['membershipId']?.toString(),
        'name': am['name']?.toString() ?? 'Membership',
        'remaining': remaining,
        'exhausted': am['exhausted'] == true,
        'expired': am['expired'] == true,
        'expiresAt': am['expiresAt']?.toString(),
        'renewPricePaise': (am['renewPricePaise'] as num?)?.round() ?? 0,
        'validityDays': (am['validityDays'] as num?)?.round() ?? 30,
      };
    } else if (data.containsKey('activeMembership')) {
      active = null; // explicit null from the round-3 server
    } else {
      // Legacy shape.
      final m = data['membership'];
      final ex = data['expiredMembership'];
      if (m is Map) {
        final rem = m['remaining'];
        final remaining = rem is List
            ? rem.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList()
            : const <Map<String, dynamic>>[];
        // Exhausted = had a bundle and every line is at 0. A perk-only plan
        // (no bundle) is never "used up".
        final exhausted = rem is List && rem.isNotEmpty &&
            remaining.every((r) => ((r['qty'] as num?) ?? 0) <= 0);
        active = {
          'id': m['subscription_id']?.toString() ?? m['id']?.toString(),
          'membershipId': m['membership_id']?.toString(),
          'name': m['name']?.toString() ?? 'Membership',
          'remaining': remaining,
          'exhausted': exhausted,
          'expired': false,
          'expiresAt': m['expires_at']?.toString(),
          'renewPricePaise': (m['price_paise'] as num?)?.round() ?? 0,
          'validityDays': (m['validity_days'] as num?)?.round() ?? 30,
        };
      } else if (ex is Map) {
        active = {
          'id': ex['subscription_id']?.toString(),
          'membershipId': ex['membership_id']?.toString(),
          'name': ex['name']?.toString() ?? 'Membership',
          'remaining': const <Map<String, dynamic>>[],
          'exhausted': false,
          'expired': true,
          'expiresAt': ex['expires_at']?.toString(),
          'renewPricePaise': (ex['price_paise'] as num?)?.round() ?? 0,
          'validityDays': (ex['validity_days'] as num?)?.round() ?? 30,
        };
      }
    }
    return MembershipStatus(active: active, available: avail);
  }
}
