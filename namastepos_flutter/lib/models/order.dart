// NamastePOS - Order + OrderItem models

import 'dart:convert';

enum OrderStatus { pending, ready, collected, cancelled }
enum OrderSource { dineIn, takeaway, zomato, swiggy, other }
enum PaymentMethod { cash, upi, card, online, unpaid }

OrderStatus orderStatusFromString(String? s) {
  switch (s) {
    case 'ready': return OrderStatus.ready;
    case 'collected': return OrderStatus.collected;
    case 'cancelled': return OrderStatus.cancelled;
    case 'pending':
    default: return OrderStatus.pending;
  }
}

OrderSource orderSourceFromString(String? s) {
  switch (s) {
    case 'takeaway': return OrderSource.takeaway;
    case 'zomato': return OrderSource.zomato;
    case 'swiggy': return OrderSource.swiggy;
    case 'other': return OrderSource.other;
    case 'dineIn':
    case 'dine-in':
    default: return OrderSource.dineIn;
  }
}

PaymentMethod paymentMethodFromString(String? s) {
  switch (s) {
    case 'upi': return PaymentMethod.upi;
    case 'card': return PaymentMethod.card;
    case 'online': return PaymentMethod.online;
    case 'unpaid': return PaymentMethod.unpaid;
    case 'cash':
    default: return PaymentMethod.cash;
  }
}

class OrderItem {
  final String id;
  final String orderId;
  final String menuItemId;
  final String name;          // denormalized for offline display & receipts
  final double price;
  final double qty;
  final String? note;          // e.g. "extra spice", "no onion"
  // 2026-09-06 (round 2, MOB #1): the picked variant + modifiers travel as
  // STRUCTURED fields, exactly as the web NewOrderDialog sends them. Since
  // NP-201 the server prices every line from menu_items.price (+ the
  // validated variant / modifier deltas) and only knows about a "Large" or
  // "+extra cheese" when the ids are on the wire — a line without them was
  // re-priced to the base price and logged as a priceAdjustments entry.
  // `variantLabel` and the modifier labels are advisory (the server
  // re-derives them from the DB, NP-202); they are kept here so offline
  // receipts and KOTs can name the choice before the row syncs.
  // `modifierLines` entries carry the mobile shape the Joi schema admits:
  // {groupId, groupLabel, optionId, optionLabel, priceDelta} (server rows
  // additionally carry modifierId/name/priceDeltaInr — see [modifierNames]).
  final String? variantId;
  final String? variantLabel;
  final List<Map<String, dynamic>>? modifierLines;

  const OrderItem({
    required this.id,
    required this.orderId,
    required this.menuItemId,
    required this.name,
    required this.price,
    required this.qty,
    this.note,
    this.variantId,
    this.variantLabel,
    this.modifierLines,
  });

  double get lineTotal => price * qty;

  bool get hasModifiers => modifierLines != null && modifierLines!.isNotEmpty;

  /// Modifier names for display — accepts both spellings in production
  /// (mobile `optionLabel`, web `name`); the server persists both.
  List<String> get modifierNames => (modifierLines ?? const [])
      .map((m) => (m['optionLabel'] ?? m['name'])?.toString() ?? '')
      .where((s) => s.isNotEmpty)
      .toList();

  /// "Large · extra cheese" — null when the line has no variant/modifiers.
  String? get configLabel {
    final parts = <String>[];
    if (variantLabel != null && variantLabel!.trim().isNotEmpty) {
      parts.add(variantLabel!.trim());
    }
    parts.addAll(modifierNames);
    return parts.isEmpty ? null : parts.join(' · ');
  }

  /// Name + configuration for one-line UI rows ("Pizza (Large · extra
  /// cheese)"). Rows created before 2026-09-06 already embed the summary in
  /// `name` and carry no structured fields, so they render unchanged.
  String get displayName =>
      configLabel == null ? name : '$name ($configLabel)';

  /// Parses `modifierLines` from either a sqflite TEXT (JSON) column or a
  /// backend JSON array. Anything unreadable → null, never a throw.
  static List<Map<String, dynamic>>? parseModifierLines(Object? raw) {
    Object? v = raw;
    if (v is String) {
      if (v.trim().isEmpty) return null;
      try { v = jsonDecode(v); } catch (_) { return null; }
    }
    if (v is! List) return null;
    final out = <Map<String, dynamic>>[];
    for (final e in v) {
      if (e is Map) out.add(e.cast<String, dynamic>());
    }
    return out.isEmpty ? null : out;
  }

  factory OrderItem.fromMap(Map<String, dynamic> m) => OrderItem(
        // Null-safe (2026-08-22): merged bill items / unmapped aggregator
        // items must never crash the parse.
        id: m['id']?.toString() ?? '',
        orderId: m['orderId'] as String? ?? '',
        menuItemId: m['menuItemId'] as String? ?? '',
        name: m['name'] as String? ?? '',
        price: (m['price'] as num?)?.toDouble() ?? 0,
        qty: (m['qty'] as num?)?.toDouble() ?? 1,
        note: m['note'] as String?,
        // Old sqflite rows (schema < v5) have no such columns → null.
        variantId: m['variantId']?.toString(),
        variantLabel: m['variantLabel']?.toString(),
        modifierLines: parseModifierLines(m['modifierLines']),
      );

  /// sqflite row. `modifierLines` is stored as a JSON TEXT column.
  Map<String, dynamic> toMap() => {
        'id': id,
        'orderId': orderId,
        'menuItemId': menuItemId,
        'name': name,
        'price': price,
        'qty': qty,
        'note': note,
        'variantId': variantId,
        'variantLabel': variantLabel,
        'modifierLines': hasModifiers ? jsonEncode(modifierLines) : null,
      };

  /// The item entry of the POST /orders body — the ONE place both create
  /// paths (direct post + offline outbox) build it from, so they cannot
  /// drift. Mirrors the web dashboard's payload field-for-field.
  Map<String, dynamic> toOrderBody() => {
        'menuItemId': menuItemId,
        'name': name,
        'price': price,
        'qty': qty,
        if (note != null) 'note': note,
        if (variantId != null) 'variantId': variantId,
        if (variantLabel != null) 'variantLabel': variantLabel,
        if (hasModifiers) 'modifierLines': modifierLines,
      };
}

class Order {
  final String id;
  final String businessId;
  final int orderNo;            // human-readable per business
  final List<OrderItem> items;
  final OrderSource source;
  final String? tableNo;
  final String? customerPhone;
  final String? customerName;
  final double subtotal;
  final double tax;
  final double discount;
  final double total;
  final PaymentMethod paymentMethod;
  final OrderStatus status;
  final String? cancelReason;
  final bool printed;
  final bool synced;            // false if created offline
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? readyAt;
  final DateTime? collectedAt;
  // Total refunded so far (2026-08-23) — populated by GET /orders/:id.
  final double refundedInr;
  // Bill breakup (2026-08-26) — for the order receipt/detail. All ₹.
  final double cgst;
  final double sgst;
  final double igst;
  final double loyaltyDiscountInr;
  final double serviceChargeInr;
  final double roundOffInr;
  final int pointsRedeemed;
  // Split-payment tenders: [{method, amountInr}] or null (single tender).
  final List<Map<String, dynamic>>? paymentBreakdown;

  // ── Bill-mode fields (set when backend was called with groupBy=session) ──
  // The order represents an entire table session's bill, not a single KOT.
  // `kots` holds the sub-tickets (labeled 5, 5.1, 5.2 …) so the UI can
  // show drill-down. Plain per-KOT orders leave these empty/null.
  final bool isBill;
  final String? tableSessionId;
  final int? displayNo;
  final List<Map<String, dynamic>> kots;

  Order({
    required this.id,
    required this.businessId,
    required this.orderNo,
    required this.items,
    this.source = OrderSource.dineIn,
    this.tableNo,
    this.customerPhone,
    this.customerName,
    required this.subtotal,
    this.tax = 0,
    this.discount = 0,
    required this.total,
    this.paymentMethod = PaymentMethod.cash,
    this.status = OrderStatus.pending,
    this.cancelReason,
    this.printed = false,
    this.synced = false,
    required this.createdAt,
    required this.updatedAt,
    this.readyAt,
    this.collectedAt,
    this.refundedInr = 0,
    this.cgst = 0,
    this.sgst = 0,
    this.igst = 0,
    this.loyaltyDiscountInr = 0,
    this.serviceChargeInr = 0,
    this.roundOffInr = 0,
    this.pointsRedeemed = 0,
    this.paymentBreakdown,
    this.isBill = false,
    this.tableSessionId,
    this.displayNo,
    this.kots = const [],
  });

  // FB-15 (2026-09-01): round, don't truncate. qty is a double (weight-priced
  // items), so `.toInt()` turned a 0.5 kg line into 0 in item-count displays.
  int get totalQty => items.fold<double>(0, (a, b) => a + b.qty).round();

  Order copyWith({
    OrderStatus? status,
    bool? printed,
    bool? synced,
    String? cancelReason,
    DateTime? readyAt,
    DateTime? collectedAt,
  }) {
    return Order(
      id: id,
      businessId: businessId,
      orderNo: orderNo,
      items: items,
      source: source,
      tableNo: tableNo,
      customerPhone: customerPhone,
      customerName: customerName,
      subtotal: subtotal,
      tax: tax,
      discount: discount,
      total: total,
      paymentMethod: paymentMethod,
      status: status ?? this.status,
      cancelReason: cancelReason ?? this.cancelReason,
      printed: printed ?? this.printed,
      synced: synced ?? this.synced,
      createdAt: createdAt,
      updatedAt: DateTime.now(),
      readyAt: readyAt ?? this.readyAt,
      collectedAt: collectedAt ?? this.collectedAt,
      // Preserve every remaining field (2026-08-31 review fix): copyWith used
      // to drop these, so advancing a session-bill row's status/print reset
      // isBill→false, emptied kots/tableSessionId, and wiped the tax breakup +
      // paymentBreakdown from the in-memory list until the next full load().
      refundedInr: refundedInr,
      cgst: cgst,
      sgst: sgst,
      igst: igst,
      loyaltyDiscountInr: loyaltyDiscountInr,
      serviceChargeInr: serviceChargeInr,
      roundOffInr: roundOffInr,
      pointsRedeemed: pointsRedeemed,
      paymentBreakdown: paymentBreakdown,
      isBill: isBill,
      tableSessionId: tableSessionId,
      displayNo: displayNo,
      kots: kots,
    );
  }

  /// Parse the JSON shape returned by GET /v1/businesses/:id/orders.
  /// Differs from `fromMap` in that backend uses real bools (not 0/1) and
  /// `items` is an embedded array on the same row.
  factory Order.fromBackend(Map<String, dynamic> m) {
    final rawItems = (m['items'] as List?) ?? const [];
    final items = rawItems.cast<Map<String, dynamic>>().map((it) => OrderItem(
          id: (it['id'] as String?) ?? '',
          orderId: (m['id'] as String?) ?? '',
          menuItemId: it['menuItemId'] as String? ?? '',
          name: it['name'] as String? ?? '',
          price: (it['price'] as num?)?.toDouble() ?? 0,
          qty: (it['qty'] as num?)?.toDouble() ?? 0,
          note: it['note'] as String?,
          variantId: it['variantId']?.toString(),
          variantLabel: it['variantLabel']?.toString(),
          modifierLines: OrderItem.parseModifierLines(it['modifierLines']),
        )).toList();
    return Order(
      id: m['id'] as String,
      businessId: m['businessId'] as String? ?? '',
      orderNo: (m['orderNo'] as num?)?.toInt() ?? 0,
      items: items,
      source: orderSourceFromString(m['source'] as String?),
      tableNo: m['tableNo'] as String?,
      customerPhone: m['customerPhone'] as String?,
      customerName: m['customerName'] as String?,
      subtotal: (m['subtotal'] as num?)?.toDouble() ?? 0,
      tax: (m['tax'] as num?)?.toDouble() ?? 0,
      discount: (m['discount'] as num?)?.toDouble() ?? 0,
      total: (m['total'] as num?)?.toDouble() ?? 0,
      paymentMethod: paymentMethodFromString(m['paymentMethod'] as String?),
      status: orderStatusFromString(m['status'] as String?),
      cancelReason: m['cancelReason'] as String?,
      printed: (m['printed'] as bool?) ?? false,
      synced: true, // came from server
      createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ?? DateTime.now(),
      updatedAt: DateTime.tryParse(m['updatedAt']?.toString() ?? '') ?? DateTime.now(),
      readyAt: m['readyAt'] != null ? DateTime.tryParse(m['readyAt'].toString()) : null,
      collectedAt: m['collectedAt'] != null ? DateTime.tryParse(m['collectedAt'].toString()) : null,
      refundedInr: (m['refundedInr'] as num?)?.toDouble() ?? 0,
      cgst: (m['cgst'] as num?)?.toDouble() ?? 0,
      sgst: (m['sgst'] as num?)?.toDouble() ?? 0,
      igst: (m['igst'] as num?)?.toDouble() ?? 0,
      loyaltyDiscountInr: (m['loyaltyDiscountInr'] as num?)?.toDouble() ?? 0,
      serviceChargeInr: (m['serviceChargeInr'] as num?)?.toDouble() ?? 0,
      roundOffInr: (m['roundOffInr'] as num?)?.toDouble() ?? 0,
      pointsRedeemed: (m['pointsRedeemed'] as num?)?.toInt() ?? 0,
      paymentBreakdown: (m['paymentBreakdown'] as List?)
          ?.cast<Map>().map((e) => e.cast<String, dynamic>()).toList(),
      isBill: (m['isBill'] as bool?) ?? false,
      tableSessionId: m['tableSessionId'] as String?,
      displayNo: (m['displayNo'] as num?)?.toInt(),
      kots: ((m['kots'] as List?) ?? const [])
          .cast<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList(),
    );
  }

  factory Order.fromMap(Map<String, dynamic> m, {List<OrderItem>? items}) => Order(
        id: m['id'] as String,
        businessId: m['businessId'] as String? ?? '',
        orderNo: m['orderNo'] as int? ?? 0,
        items: items ?? const [],
        source: orderSourceFromString(m['source'] as String?),
        tableNo: m['tableNo'] as String?,
        customerPhone: m['customerPhone'] as String?,
        customerName: m['customerName'] as String?,
        subtotal: (m['subtotal'] as num?)?.toDouble() ?? 0,
        tax: (m['tax'] as num?)?.toDouble() ?? 0,
        discount: (m['discount'] as num?)?.toDouble() ?? 0,
        total: (m['total'] as num?)?.toDouble() ?? 0,
        paymentMethod: paymentMethodFromString(m['paymentMethod'] as String?),
        status: orderStatusFromString(m['status'] as String?),
        cancelReason: m['cancelReason'] as String?,
        printed: (m['printed'] as int? ?? 0) == 1,
        synced: (m['synced'] as int? ?? 0) == 1,
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
        updatedAt: DateTime.tryParse(m['updatedAt']?.toString() ?? '') ??
            DateTime.now(),
        readyAt: m['readyAt'] != null
            ? DateTime.tryParse(m['readyAt'].toString())
            : null,
        collectedAt: m['collectedAt'] != null
            ? DateTime.tryParse(m['collectedAt'].toString())
            : null,
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'businessId': businessId,
        'orderNo': orderNo,
        'source': source.name,
        'tableNo': tableNo,
        'customerPhone': customerPhone,
        'customerName': customerName,
        'subtotal': subtotal,
        'tax': tax,
        'discount': discount,
        'total': total,
        'paymentMethod': paymentMethod.name,
        'status': status.name,
        'cancelReason': cancelReason,
        'printed': printed ? 1 : 0,
        'synced': synced ? 1 : 0,
        'createdAt': createdAt.toIso8601String(),
        'updatedAt': updatedAt.toIso8601String(),
        'readyAt': readyAt?.toIso8601String(),
        'collectedAt': collectedAt?.toIso8601String(),
      };
}
