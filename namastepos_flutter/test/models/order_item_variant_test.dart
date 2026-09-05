// NamastePOS — order lines carry variantId / variantLabel / modifierLines
// (round 2, MOB #1, 2026-09-06).
//
// WHY: since NP-201 the server prices every line from menu_items.price plus
// the VALIDATED variant / modifier deltas. A line that reaches it without the
// ids is re-priced to the base menu price, so "Pizza Large" rung on the phone
// was billed as a plain Pizza. These tests pin the wire shape (identical to
// the web NewOrderDialog payload / orderController Joi schema), the sqflite
// round trip, old-row compatibility and the GST estimate on a variant line.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/cart_item.dart';
import 'package:namastepos/models/menu_item.dart';
import 'package:namastepos/models/order.dart';
import 'package:namastepos/providers/orders_provider.dart';

MenuItem _pizza({double? gstPct = 5}) => MenuItem.fromBackend({
      'id': '11111111-1111-4111-8111-111111111111',
      'businessId': 'b-1',
      'name': 'Pizza',
      'category': 'Food',
      'price': 200,
      'isActive': true,
      'isVeg': true,
      'gstPct': gstPct,
      'createdAt': '2026-09-06T00:00:00Z',
      'updatedAt': '2026-09-06T00:00:00Z',
    });

const _variantId = '22222222-2222-4222-8222-222222222222';
const _groupId = '33333333-3333-4333-8333-333333333333';
const _cheeseId = '44444444-4444-4444-8444-444444444444';
const _olivesId = '55555555-5555-4555-8555-555555555555';

CartItem _largeCheeseOlives() => CartItem(
      item: _pizza(),
      qty: 2,
      variantId: _variantId,
      variantLabel: 'Large',
      variantPrice: 350,
      modifiers: [
        ModifierLine(
          groupId: _groupId,
          groupLabel: 'Toppings',
          optionId: _cheeseId,
          optionLabel: 'Extra cheese',
          priceDelta: 40,
        ),
        ModifierLine(
          groupId: _groupId,
          groupLabel: 'Toppings',
          optionId: _olivesId,
          optionLabel: 'Olives',
          priceDelta: 10,
        ),
      ],
    );

OrderItem _lineFrom(CartItem c) => OrderItem(
      id: 'oi-1',
      orderId: 'o-1',
      menuItemId: c.item.id,
      name: c.item.name,
      price: c.unitPrice,
      qty: c.qty.toDouble(),
      note: c.note,
      variantId: c.variantId,
      variantLabel: c.variantLabelOrNull,
      modifierLines: c.modifierLinesJson,
    );

void main() {
  group('POST /orders item body (mirrors web NewOrderDialog)', () {
    test('carries variantId, variantLabel and modifierLines with ids', () {
      final body = _lineFrom(_largeCheeseOlives()).toOrderBody();
      expect(body['menuItemId'], _pizza().id);
      expect(body['name'], 'Pizza'); // plain dish name, like the web
      expect(body['price'], 400); // 350 + 40 + 10
      expect(body['qty'], 2);
      expect(body['variantId'], _variantId);
      expect(body['variantLabel'], 'Large');
      final mods = body['modifierLines'] as List;
      expect(mods, hasLength(2));
      // The mobile shape the backend Joi schema admits — the SERVICE reads the
      // id from `optionId ?? modifierId`, so optionId must be present.
      expect(mods.first, {
        'groupId': _groupId,
        'groupLabel': 'Toppings',
        'optionId': _cheeseId,
        'optionLabel': 'Extra cheese',
        'priceDelta': 40,
      });
      // Must survive JSON encoding (the offline outbox stores the body as text).
      expect(() => jsonEncode(body), returnsNormally);
      expect(body.containsKey('note'), isFalse);
    });

    test('a plain line omits the optional fields (Joi: absent is fine)', () {
      final body = _lineFrom(CartItem(item: _pizza(), qty: 1)).toOrderBody();
      expect(body.containsKey('variantId'), isFalse);
      expect(body.containsKey('variantLabel'), isFalse);
      expect(body.containsKey('modifierLines'), isFalse);
      expect(body['price'], 200);
    });

    test('an empty variant label is not sent as ""', () {
      final c = CartItem(
          item: _pizza(), variantId: _variantId, variantLabel: '', variantPrice: 350);
      final body = _lineFrom(c).toOrderBody();
      expect(body['variantId'], _variantId);
      expect(body.containsKey('variantLabel'), isFalse);
    });
  });

  group('OrderItem sqflite round trip', () {
    test('toMap → fromMap keeps variant + modifiers (JSON TEXT column)', () {
      final line = _lineFrom(_largeCheeseOlives());
      final row = line.toMap();
      expect(row['variantId'], _variantId);
      expect(row['variantLabel'], 'Large');
      expect(row['modifierLines'], isA<String>()); // sqflite has no JSON type
      final back = OrderItem.fromMap(row);
      expect(back.variantId, _variantId);
      expect(back.variantLabel, 'Large');
      expect(back.modifierLines, hasLength(2));
      expect(back.modifierLines!.first['optionId'], _cheeseId);
      expect(back.modifierNames, ['Extra cheese', 'Olives']);
      expect(back.configLabel, 'Large · Extra cheese · Olives');
      expect(back.displayName, 'Pizza (Large · Extra cheese · Olives)');
      // Same wire body after the round trip — a queued offline order replays
      // exactly what an online one posts.
      expect(back.toOrderBody(), line.toOrderBody());
    });

    test('a pre-v5 row (no such columns) is still readable', () {
      final old = OrderItem.fromMap({
        'id': 'oi-old',
        'orderId': 'o-old',
        'menuItemId': 'mi-1',
        'name': 'Pizza (Large · Extra cheese)',
        'price': 390.0,
        'qty': 1.0,
        'note': null,
      });
      expect(old.variantId, isNull);
      expect(old.variantLabel, isNull);
      expect(old.modifierLines, isNull);
      expect(old.hasModifiers, isFalse);
      expect(old.configLabel, isNull);
      // The composed name it was saved with is what the UI shows — unchanged.
      expect(old.displayName, 'Pizza (Large · Extra cheese)');
      expect(old.toMap()['modifierLines'], isNull);
    });

    test('garbage in the JSON column never throws', () {
      expect(OrderItem.parseModifierLines('not json'), isNull);
      expect(OrderItem.parseModifierLines(''), isNull);
      expect(OrderItem.parseModifierLines(42), isNull);
      expect(OrderItem.parseModifierLines('[]'), isNull);
      expect(OrderItem.parseModifierLines('[1, "x"]'), isNull);
    });
  });

  group('Order.fromBackend items', () {
    test('reads the server row incl. both modifier spellings', () {
      final o = Order.fromBackend({
        'id': 'o-1',
        'businessId': 'b-1',
        'orderNo': 7,
        'items': [
          {
            'id': 'oi-1',
            'menuItemId': 'mi-1',
            'name': 'Pizza',
            'price': 400,
            'qty': 2,
            'variantId': _variantId,
            'variantLabel': 'Large',
            // What orderService persists: mobile AND web spellings together.
            'modifierLines': [
              {
                'groupId': _groupId, 'groupLabel': 'Toppings',
                'optionId': _cheeseId, 'optionLabel': 'Extra cheese',
                'priceDelta': 40,
                'modifierId': _cheeseId, 'name': 'Extra cheese',
                'priceDeltaInr': 40, 'qty': 1,
              },
              // A web-only shaped row (older dashboard order).
              {'modifierId': _olivesId, 'name': 'Olives', 'priceDeltaInr': 10, 'qty': 1},
            ],
          },
          // Aggregator / merged-bill line with nothing structured.
          {'id': 'oi-2', 'menuItemId': 'mi-2', 'name': 'Coke', 'price': 40, 'qty': 1},
        ],
        'subtotal': 840, 'tax': 42, 'total': 882,
        'createdAt': '2026-09-06T10:00:00Z', 'updatedAt': '2026-09-06T10:00:00Z',
      });
      final pizza = o.items.first;
      expect(pizza.variantId, _variantId);
      expect(pizza.variantLabel, 'Large');
      expect(pizza.modifierNames, ['Extra cheese', 'Olives']);
      expect(pizza.displayName, 'Pizza (Large · Extra cheese · Olives)');
      final coke = o.items[1];
      expect(coke.variantLabel, isNull);
      expect(coke.modifierLines, isNull);
      expect(coke.displayName, 'Coke');
      // ModifierLine.fromJson accepts either spelling too.
      final olives = ModifierLine.fromJson(pizza.modifierLines![1]);
      expect(olives.optionId, _olivesId);
      expect(olives.optionLabel, 'Olives');
      expect(olives.priceDelta, 10);
    });
  });

  group('GST estimate on a variant/modifier line', () {
    test('uses the variant + modifier adjusted price and the PARENT slab', () {
      final p = OrdersProvider();
      p.addToCart(_largeCheeseOlives()); // 2 × ₹400 @ 5% (parent Pizza slab)
      expect(p.cartSubtotal, 800);
      final gst = p.cartGst();
      // Same numbers gstService2.computeGstBreakdown gives for 2×400@5%.
      expect(gst.totalGst, 40.0);
      expect(gst.cgst, 20.0);
      expect(gst.sgst, 20.0);
      // A base-priced line would have been 2×200@5% = ₹20 — the bug this
      // batch fixes on the server side would have shown that instead.
      expect(gst.totalGst, isNot(20.0));
    });

    test('surge multiplier applies on top of the adjusted unit price', () {
      final p = OrdersProvider();
      p.addToCart(_largeCheeseOlives());
      // 2 × round2(400 × 1.5) = 2 × 600 @ 5% → 60.
      expect(p.cartGst(priceMultiplier: 1.5).totalGst, 60.0);
    });

    test('variant line with no parent slab falls back to the scheme default', () {
      final p = OrdersProvider();
      final c = _largeCheeseOlives();
      p.addToCart(CartItem(
        item: _pizza(gstPct: null),
        qty: c.qty,
        variantId: c.variantId,
        variantLabel: c.variantLabel,
        variantPrice: c.variantPrice,
        modifiers: c.modifiers,
      ));
      // regular scheme default 5% → 2×400 → 40; composition → 0.
      expect(p.cartGst(gstScheme: 'regular').totalGst, 40.0);
      expect(p.cartGst(gstScheme: 'composition').totalGst, 0.0);
    });
  });
}
