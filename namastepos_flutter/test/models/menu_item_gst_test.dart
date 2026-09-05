// NamastePOS — MenuItem carries the GST slab (2026-09-05, review #2).

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/menu_item.dart';

Map<String, dynamic> _row({Object? gstPct, bool include = true}) => {
      'id': 'mi-1',
      'businessId': 'b-1',
      'name': 'Masala Dosa',
      'category': 'Food',
      'price': 100,
      'isActive': true,
      'isVeg': true,
      if (include) 'gstPct': gstPct,
      'createdAt': '2026-09-05T00:00:00Z',
      'updatedAt': '2026-09-05T00:00:00Z',
    };

void main() {
  group('MenuItem.fromBackend gstPct', () {
    test('reads a numeric slab', () {
      expect(MenuItem.fromBackend(_row(gstPct: 5)).gstPct, 5.0);
      expect(MenuItem.fromBackend(_row(gstPct: 18.0)).gstPct, 18.0);
    });
    test('tolerates a numeric string', () {
      expect(MenuItem.fromBackend(_row(gstPct: '12')).gstPct, 12.0);
    });
    test('absent or null stays null (caller applies the scheme default)', () {
      expect(MenuItem.fromBackend(_row(include: false)).gstPct, isNull);
      expect(MenuItem.fromBackend(_row(gstPct: null)).gstPct, isNull);
    });
    test('survives the sqflite round trip and copyWith', () {
      final item = MenuItem.fromBackend(_row(gstPct: 5));
      final back = MenuItem.fromMap({
        ...item.toMap(),
        'isActive': 1,
        'isVeg': 1,
      });
      expect(back.gstPct, 5.0);
      expect(item.copyWith(price: 120).gstPct, 5.0);
      expect(item.copyWith(gstPct: 18).gstPct, 18.0);
    });
  });
}
