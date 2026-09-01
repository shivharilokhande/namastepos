// NamastePOS - DAO/Repository layer wrapping sqflite.
//
// All write operations go to the local DB first (so the app works offline),
// then attempt a sync via ApiService. The sync_queue table stores deltas
// that failed to push so they get retried on next connectivity.

import 'package:dio/dio.dart' show DioException;
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import '../models/expense.dart';
import '../models/inventory_transaction.dart';
import '../models/menu_item.dart';
import '../models/order.dart';
import 'api_service.dart';
import 'database_service.dart';
import 'offline_outbox.dart';

class MenuRepo {
  MenuRepo._();
  static final MenuRepo instance = MenuRepo._();

  Future<List<MenuItem>> listForBusiness(String businessId,
      {String? category, bool onlyActive = true}) async {
    final db = await DatabaseService.instance.db;
    final where = <String>['businessId = ?'];
    final args = <Object?>[businessId];
    if (category != null) {
      where.add('category = ?');
      args.add(category);
    }
    if (onlyActive) {
      where.add('isActive = 1');
    }
    final rows = await db.query(
      'menu_items',
      where: where.join(' AND '),
      whereArgs: args,
      orderBy: 'category ASC, name ASC',
    );
    return rows.map(MenuItem.fromMap).toList();
  }

  Future<MenuItem?> byId(String id) async {
    final db = await DatabaseService.instance.db;
    final rows = await db.query('menu_items', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return MenuItem.fromMap(rows.first);
  }

  Future<MenuItem> create(MenuItem item) async {
    final db = await DatabaseService.instance.db;
    await db.insert('menu_items', item.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
    return item;
  }

  Future<MenuItem> update(MenuItem item) async {
    final db = await DatabaseService.instance.db;
    await db.update('menu_items', item.toMap(),
        where: 'id = ?', whereArgs: [item.id]);
    return item;
  }

  Future<void> softDelete(String id) async {
    final db = await DatabaseService.instance.db;
    await db.update('menu_items', {'isActive': 0},
        where: 'id = ?', whereArgs: [id]);
  }

  /// Wipe local cache for [businessId] and insert all of [items]. Used by
  /// MenuProvider to mirror the backend's current state, so deletions on
  /// the dashboard reflect on mobile without orphaning rows.
  Future<void> replaceAll(String businessId, List<MenuItem> items) async {
    final db = await DatabaseService.instance.db;
    await db.transaction((txn) async {
      await txn.delete('menu_items', where: 'businessId = ?', whereArgs: [businessId]);
      for (final m in items) {
        await txn.insert('menu_items', m.toMap(),
            conflictAlgorithm: ConflictAlgorithm.replace);
      }
    });
  }

  Future<List<String>> categories(String businessId) async {
    final db = await DatabaseService.instance.db;
    final rows = await db.rawQuery(
      'SELECT DISTINCT category FROM menu_items WHERE businessId = ? AND isActive = 1 ORDER BY category',
      [businessId],
    );
    return rows.map((r) => r['category'] as String).toList();
  }
}

class OrderRepo {
  OrderRepo._();
  static final OrderRepo instance = OrderRepo._();

  Future<int> _nextOrderNo(Transaction txn, String businessId) async {
    final rows = await txn.rawQuery(
      'SELECT MAX(orderNo) AS maxNo FROM orders WHERE businessId = ?',
      [businessId],
    );
    final max = rows.first['maxNo'];
    if (max == null) return 1;
    return ((max as int)) + 1;
  }

  /// Creates an order and order_items in a single transaction.
  /// Deducts inventory and logs inventory_transactions.
  Future<Order> create({
    required String businessId,
    required List<OrderItem> items,
    required OrderSource source,
    String? tableNo,
    String? customerPhone,
    String? customerName,
    required double subtotal,
    double tax = 0,
    double discount = 0,
    required double total,
    PaymentMethod paymentMethod = PaymentMethod.cash,
    // FF-322 mobile split-tender — array of {method, amountInr}. When
    // set, backend records every leg into `payments` and marks
    // `is_split_tender=true`. Kept optional so legacy single-tender
    // callers don't need to change.
    List<Map<String, dynamic>>? splits,
    // Captain add-items binding (2026-08-23)
    String? tableSessionId,
    String? tableId,
    // Loyalty redemption (2026-08-23): server recomputes caps/balance and
    // burns the points — client just declares intent.
    int pointsToRedeem = 0,
    // Applied food-coupon code (2026-09-01) — server records use + enforces cap.
    String? couponCode,
  }) async {
    final db = await DatabaseService.instance.db;
    final uuid = const Uuid();
    final orderId = uuid.v4();
    final now = DateTime.now();

    late Order order;

    await db.transaction((txn) async {
      final orderNo = await _nextOrderNo(txn, businessId);
      final filledItems = items
          .map((i) => OrderItem(
                id: uuid.v4(),
                orderId: orderId,
                menuItemId: i.menuItemId,
                name: i.name,
                price: i.price,
                qty: i.qty,
                note: i.note,
              ))
          .toList();

      order = Order(
        id: orderId,
        businessId: businessId,
        orderNo: orderNo,
        items: filledItems,
        source: source,
        tableNo: tableNo,
        customerPhone: customerPhone,
        customerName: customerName,
        subtotal: subtotal,
        tax: tax,
        discount: discount,
        total: total,
        paymentMethod: paymentMethod,
        status: OrderStatus.pending,
        createdAt: now,
        updatedAt: now,
      );

      await txn.insert('orders', order.toMap());

      for (final it in filledItems) {
        await txn.insert('order_items', it.toMap());

        // deduct inventory (best effort)
        final rows = await txn.query('menu_items',
            columns: ['stock'],
            where: 'id = ?', whereArgs: [it.menuItemId], limit: 1);
        if (rows.isNotEmpty) {
          final current = (rows.first['stock'] as num?)?.toDouble() ?? 0;
          final nextStock = current - it.qty;
          await txn.update(
              'menu_items', {'stock': nextStock, 'updatedAt': now.toIso8601String()},
              where: 'id = ?', whereArgs: [it.menuItemId]);
          await txn.insert('inventory_transactions', InventoryTransaction(
            id: uuid.v4(),
            businessId: businessId,
            menuItemId: it.menuItemId,
            qtyChange: -it.qty,
            balanceAfter: nextStock,
            reason: InventoryReason.sale,
            orderId: orderId,
            createdAt: now,
          ).toMap());
        }
      }

      // 2026-08-31 review fix: the `sync_queue` table was written on every
      // order but NEVER drained — the real replay engine is OfflineOutbox
      // (below), so this row just grew the DB one row per order forever with
      // no effect. Removed. (OfflineOutbox is idempotent via clientId=orderId.)
    });

    // Also push through the connectivity-aware OfflineOutbox so we attempt
    // the network call right now if online (better latency than waiting for
    // the next sync_queue drain), and otherwise queue. Idempotency is keyed
    // by orderId, which the backend's orderService.create() honors as clientId.
    try {
      await OfflineOutbox().sendOrQueue(
        endpoint: '/businesses/$businessId/orders',
        method: 'POST',
        body: {
          'clientId': orderId,
          // Backend Joi schema requires name + price in addition to menuItemId,
          // so we send the whole order_item row. Failing to include these
          // produces "BAD_REQUEST: Validation failed" on submit.
          'items': order.items.map((i) => {
            'menuItemId': i.menuItemId,
            'name': i.name,
            'price': i.price,
            'qty': i.qty,
            if (i.note != null) 'note': i.note,
          }).toList(),
          'source': source.name,
          'tableNo': tableNo,
          if (tableSessionId != null) 'tableSessionId': tableSessionId,
          if (tableId != null) 'tableId': tableId,
          if (pointsToRedeem > 0) 'pointsToRedeem': pointsToRedeem,
          'customerPhone': customerPhone,
          'customerName': customerName,
          'tax': tax,
          'discount': discount,
          if (couponCode != null && couponCode.isNotEmpty) 'couponCode': couponCode,
          'paymentMethod': paymentMethod.name,
          if (splits != null && splits.isNotEmpty) 'splits': splits,
        },
      );
    } catch (e) {
      // H4 fix (2026-08-23): 4xx rejections now rethrow from the outbox —
      // surface them so the cashier KNOWS the order didn't reach the
      // kitchen dashboard (5xx/offline are still queued silently).
      if (e is DioException && (e.response?.statusCode ?? 0) >= 400
          && (e.response?.statusCode ?? 0) < 500) {
        rethrow;
      }
      /* outbox already queues network failures — silent */
    }

    return order;
  }

  Future<List<Order>> list(String businessId,
      {OrderStatus? status, DateTime? day}) async {
    final db = await DatabaseService.instance.db;
    final where = <String>['businessId = ?'];
    final args = <Object?>[businessId];
    if (status != null) {
      where.add('status = ?');
      args.add(status.name);
    }
    if (day != null) {
      final from = DateTime(day.year, day.month, day.day).toIso8601String();
      final to = DateTime(day.year, day.month, day.day, 23, 59, 59).toIso8601String();
      where.add('createdAt >= ? AND createdAt <= ?');
      args.add(from);
      args.add(to);
    }
    final ords = await db.query(
      'orders',
      where: where.join(' AND '),
      whereArgs: args,
      orderBy: 'createdAt DESC',
    );

    final result = <Order>[];
    for (final o in ords) {
      final itRows = await db.query('order_items',
          where: 'orderId = ?', whereArgs: [o['id']]);
      result.add(Order.fromMap(o, items: itRows.map(OrderItem.fromMap).toList()));
    }
    return result;
  }

  /// 2026-08-31 review fix: local orders created offline that haven't synced
  /// yet (synced=0). load() must preserve these across a server-list refresh so
  /// an offline order doesn't disappear from the UI before the outbox drains
  /// (a disappearance invites a re-ring → a true duplicate with a new clientId).
  Future<List<Order>> unsynced(String businessId) async {
    final db = await DatabaseService.instance.db;
    final ords = await db.query('orders',
        where: 'businessId = ? AND synced = 0', whereArgs: [businessId],
        orderBy: 'createdAt DESC');
    final result = <Order>[];
    for (final o in ords) {
      final itRows = await db.query('order_items',
          where: 'orderId = ?', whereArgs: [o['id']]);
      result.add(Order.fromMap(o, items: itRows.map(OrderItem.fromMap).toList()));
    }
    return result;
  }

  Future<Order?> byId(String orderId) async {
    final db = await DatabaseService.instance.db;
    final ords = await db.query('orders',
        where: 'id = ?', whereArgs: [orderId], limit: 1);
    if (ords.isEmpty) return null;
    final itRows = await db.query('order_items',
        where: 'orderId = ?', whereArgs: [orderId]);
    return Order.fromMap(ords.first,
        items: itRows.map(OrderItem.fromMap).toList());
  }

  Future<void> updateStatus(String orderId, OrderStatus status, {String? reason}) async {
    final db = await DatabaseService.instance.db;
    final now = DateTime.now().toIso8601String();
    final patch = <String, Object?>{
      'status': status.name,
      'updatedAt': now,
    };
    if (status == OrderStatus.ready) patch['readyAt'] = now;
    if (status == OrderStatus.collected) patch['collectedAt'] = now;
    if (reason != null) patch['cancelReason'] = reason;
    await db.update('orders', patch, where: 'id = ?', whereArgs: [orderId]);
  }

  Future<void> markPrinted(String orderId) async {
    final db = await DatabaseService.instance.db;
    await db.update('orders', {'printed': 1}, where: 'id = ?', whereArgs: [orderId]);
  }

  /// Remove a single order from the local cache. Called when the backend
  /// returns 404 for an order ID — means it's a ghost that was only ever
  /// in SQLite and shouldn't keep appearing in the UI.
  Future<void> removeById(String orderId) async {
    final db = await DatabaseService.instance.db;
    await db.delete('order_items', where: 'orderId = ?', whereArgs: [orderId]);
    await db.delete('orders', where: 'id = ?', whereArgs: [orderId]);
  }

  /// Nuclear option — wipe ALL local orders + items for a business so the
  /// next backend fetch is the only source of truth. Used by the "Clean
  /// local cache" recovery action when offline state has drifted.
  Future<void> purgeAll(String businessId) async {
    final db = await DatabaseService.instance.db;
    final ids = await db.query('orders',
        columns: ['id'], where: 'businessId = ?', whereArgs: [businessId]);
    for (final row in ids) {
      await db.delete('order_items',
          where: 'orderId = ?', whereArgs: [row['id']]);
    }
    await db.delete('orders', where: 'businessId = ?', whereArgs: [businessId]);
  }

  /// H3 fix (2026-08-23, review): after a successful backend fetch the
  /// cache was purged but never repopulated, so the offline fallback was
  /// always empty. Re-cache the fetched orders (best-effort, batched).
  Future<void> cacheAll(String businessId, List<Order> orders) async {
    try {
      final db = await DatabaseService.instance.db;
      await db.transaction((txn) async {
        final batch = txn.batch();
        for (final o in orders) {
          batch.insert('orders', o.toMap(),
              conflictAlgorithm: ConflictAlgorithm.replace);
          for (final it in o.items) {
            if (it.id.isEmpty) continue;
            batch.insert('order_items', it.toMap(),
                conflictAlgorithm: ConflictAlgorithm.replace);
          }
        }
        await batch.commit(noResult: true);
      });
    } catch (_) { /* cache is a nicety — never fail the fetch over it */ }
  }
}

class ExpenseRepo {
  ExpenseRepo._();
  static final ExpenseRepo instance = ExpenseRepo._();

  // SYNC FIX (2026-08-23, founder): expenses were LOCAL-ONLY (sqflite).
  // Backend-created expenses — wastage cost mirrors, refund COGS,
  // anything entered on the dashboard — never appeared on the Home
  // card or the Expenses screen, and mobile-entered expenses never
  // reached the backend reports. Now: backend is the source of truth;
  // sqflite is the offline cache/fallback.

  Future<Expense> create(Expense e) async {
    try {
      await ApiService.instance.createExpense(e.businessId, {
        'category': e.category.name,
        'amount': e.amount,
        if (e.description != null && e.description!.isNotEmpty)
          'description': e.description,
        'date': e.date.toIso8601String().substring(0, 10),
      });
    } catch (_) {
      // Offline — keep the local copy; it still shows in the app.
    }
    final db = await DatabaseService.instance.db;
    await db.insert('expenses', e.toMap());
    return e;
  }

  Future<List<Expense>> list(String businessId,
      {DateTime? start, DateTime? end, ExpenseCategory? category}) async {
    // Backend first (includes wastage/refund/dashboard entries).
    try {
      final raw = await ApiService.instance
          .listExpenses(businessId, start: start, end: end);
      var out = raw
          .map((m) => Expense.fromMap((m as Map).cast<String, dynamic>()))
          .toList();
      if (category != null) {
        out = out.where((e) => e.category == category).toList();
      }
      return out;
    } catch (_) {
      // Offline fallback — local cache below.
    }
    final db = await DatabaseService.instance.db;
    final where = <String>['businessId = ?'];
    final args = <Object?>[businessId];
    if (start != null) {
      where.add('date >= ?');
      args.add(DateTime(start.year, start.month, start.day).toIso8601String());
    }
    if (end != null) {
      where.add('date <= ?');
      args.add(DateTime(end.year, end.month, end.day, 23, 59, 59).toIso8601String());
    }
    if (category != null) {
      where.add('category = ?');
      args.add(category.name);
    }
    final rows = await db.query(
      'expenses',
      where: where.join(' AND '),
      whereArgs: args,
      orderBy: 'date DESC, createdAt DESC',
    );
    return rows.map(Expense.fromMap).toList();
  }

  Future<void> delete(String id) async {
    final db = await DatabaseService.instance.db;
    await db.delete('expenses', where: 'id = ?', whereArgs: [id]);
  }
}

class InventoryRepo {
  InventoryRepo._();
  static final InventoryRepo instance = InventoryRepo._();

  Future<void> adjust({
    required String businessId,
    required String menuItemId,
    required double delta,
    required InventoryReason reason,
    String? note,
  }) async {
    // Bug fix (2026-08-22): this used to only write to the local
    // SQLite cache — on next app launch the client re-fetched menu
    // items from the backend which never received the update, so the
    // owner saw their stock revert to 0. Now we POST the delta to
    // the backend first; on success we update the local cache with
    // the server's authoritative `stock` value.
    final now = DateTime.now();
    final resp = await ApiService.instance.adjustStock(
      businessId: businessId,
      menuItemId: menuItemId,
      delta: delta,
      reason: reason.name,
      note: note,
    );
    // Backend returns { item: {...} } with the updated row. Prefer its
    // `stock` value (authoritative — resolves concurrent adjustments
    // correctly) over our locally-computed delta.
    final serverStock =
        ((resp['item'] as Map?)?['stock'] as num?)?.toDouble() ??
            (resp['stock'] as num?)?.toDouble();

    final db = await DatabaseService.instance.db;
    await db.transaction((txn) async {
      final rows = await txn.query('menu_items',
          columns: ['stock'],
          where: 'id = ?', whereArgs: [menuItemId], limit: 1);
      final currentLocal = rows.isEmpty
          ? 0.0
          : ((rows.first['stock'] as num?)?.toDouble() ?? 0);
      final next = serverStock ?? (currentLocal + delta);
      if (rows.isNotEmpty) {
        await txn.update(
          'menu_items',
          {'stock': next, 'updatedAt': now.toIso8601String()},
          where: 'id = ?', whereArgs: [menuItemId],
        );
      }
      await txn.insert('inventory_transactions', InventoryTransaction(
        id: const Uuid().v4(),
        businessId: businessId,
        menuItemId: menuItemId,
        qtyChange: delta,
        balanceAfter: next,
        reason: reason,
        note: note,
        createdAt: now,
      ).toMap());
    });
  }

  Future<List<InventoryTransaction>> history(String menuItemId, {int limit = 50}) async {
    final db = await DatabaseService.instance.db;
    final rows = await db.query(
      'inventory_transactions',
      where: 'menuItemId = ?',
      whereArgs: [menuItemId],
      orderBy: 'createdAt DESC',
      limit: limit,
    );
    return rows.map(InventoryTransaction.fromMap).toList();
  }
}
