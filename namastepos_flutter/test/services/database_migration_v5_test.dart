// NamastePOS — sqflite schema v4 → v5 (round 2, MOB #1, 2026-09-06).
//
// Runs the REAL `DatabaseService.migrateOrderItemsV5` step against an
// in-memory SQLite (sqflite_common_ffi) holding a v4-shaped order_items
// table with a row written by the previous app version, and proves:
//   • the old row is still readable through OrderItem.fromMap (nulls),
//   • a new row round-trips variantId / variantLabel / modifierLines,
//   • re-running the step is a no-op (no "duplicate column" crash).

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/order.dart';
import 'package:namastepos/services/database_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const _v4OrderItems = '''
  CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    menuItemId TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    note TEXT
  );
''';

Future<Set<String>> _columns(Database db) async =>
    (await db.rawQuery('PRAGMA table_info(order_items)'))
        .map((r) => r['name'].toString())
        .toSet();

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Database db;

  setUp(() async {
    db = await databaseFactory.openDatabase(inMemoryDatabasePath);
    await db.execute(_v4OrderItems);
    // A line the previous version wrote: the choice lives only in `name`.
    await db.insert('order_items', {
      'id': 'oi-old',
      'orderId': 'o-old',
      'menuItemId': 'mi-1',
      'name': 'Pizza (Large · Extra cheese)',
      'price': 390.0,
      'qty': 1.0,
      'note': 'less spicy',
    });
  });

  tearDown(() async => db.close());

  test('adds the three columns and keeps the old row readable', () async {
    expect(await _columns(db), isNot(contains('variantId')));

    await DatabaseService.migrateOrderItemsV5(db);

    final cols = await _columns(db);
    expect(cols, containsAll(['variantId', 'variantLabel', 'modifierLines']));

    final rows = await db.query('order_items', where: 'id = ?', whereArgs: ['oi-old']);
    expect(rows, hasLength(1));
    final old = OrderItem.fromMap(rows.first);
    expect(old.name, 'Pizza (Large · Extra cheese)');
    expect(old.price, 390.0);
    expect(old.note, 'less spicy');
    expect(old.variantId, isNull);
    expect(old.variantLabel, isNull);
    expect(old.modifierLines, isNull);
    expect(old.displayName, 'Pizza (Large · Extra cheese)');
  });

  test('a new row round-trips the structured fields through the DB', () async {
    await DatabaseService.migrateOrderItemsV5(db);
    final line = OrderItem(
      id: 'oi-new',
      orderId: 'o-new',
      menuItemId: 'mi-1',
      name: 'Pizza',
      price: 400,
      qty: 2,
      variantId: 'v-large',
      variantLabel: 'Large',
      modifierLines: const [
        {
          'groupId': 'g-1', 'groupLabel': 'Toppings',
          'optionId': 'm-cheese', 'optionLabel': 'Extra cheese', 'priceDelta': 40,
        },
      ],
    );
    await db.insert('order_items', line.toMap());
    final back = OrderItem.fromMap(
        (await db.query('order_items', where: 'id = ?', whereArgs: ['oi-new'])).first);
    expect(back.variantId, 'v-large');
    expect(back.variantLabel, 'Large');
    expect(back.modifierLines, hasLength(1));
    expect(back.modifierLines!.first['optionId'], 'm-cheese');
    expect(back.toOrderBody(), line.toOrderBody());
    // Both generations coexist in one table.
    expect(await db.query('order_items'), hasLength(2));
  });

  test('re-running the step is idempotent', () async {
    await DatabaseService.migrateOrderItemsV5(db);
    await expectLater(DatabaseService.migrateOrderItemsV5(db), completes);
    final cols = (await db.rawQuery('PRAGMA table_info(order_items)'))
        .map((r) => r['name'].toString())
        .toList();
    expect(cols.where((c) => c == 'variantId'), hasLength(1));
  });
}
