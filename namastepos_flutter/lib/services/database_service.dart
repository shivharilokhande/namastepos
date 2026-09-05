// NamastePOS - Local SQLite store (offline-first)
//
// Schema mirrors the spec's 11 PostgreSQL tables. We use sqflite locally
// and sync to backend when online (see api_service.dart).

import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

class DatabaseService {
  DatabaseService._();
  static final DatabaseService instance = DatabaseService._();

  static const String _dbName = 'namastepos.db';
  // Bumped from 1 → 2 to wipe the polluted local "demo" rows that the old
  // MenuProvider seeded (Masala Dosa / Idli etc.). The new architecture
  // makes the backend the source of truth and MenuProvider.replaceAll
  // mirrors backend into local on every refresh.
  // v3 (NP-137, 2026-09-03): expenses.clientKey — idempotency tag sent with
  // the create POST so offline-queued expenses can be retried/reconciled
  // without ghost duplicates.
  // v4 (2026-09-05, review #2): menu_items.gstPct — the item's GST slab, so
  // the offline menu cache can estimate tax on a queued order the same way
  // the server will. Additive; old rows read back null → scheme default.
  static const int _dbVersion = 4;

  Database? _db;

  Future<Database> get db async {
    _db ??= await _open();
    return _db!;
  }

  Future<void> init() async {
    await db;
  }

  Future<Database> _open() async {
    final path = join(await getDatabasesPath(), _dbName);
    return openDatabase(
      path,
      version: _dbVersion,
      onCreate: _onCreate,
      onUpgrade: _onUpgrade,
    );
  }

  Future<void> _onCreate(Database db, int version) async {
    final batch = db.batch();

    // 1. businesses
    batch.execute('''
      CREATE TABLE businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        city TEXT,
        category TEXT,
        gstin TEXT,
        logoUrl TEXT,
        bankAccount TEXT,
        bankIfsc TEXT,
        upiId TEXT,
        address TEXT,
        createdAt TEXT NOT NULL
      );
    ''');

    // 2. menu_items
    batch.execute('''
      CREATE TABLE menu_items (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'Food',
        price REAL NOT NULL,
        costPrice REAL,
        sku TEXT,
        unit TEXT NOT NULL DEFAULT 'piece',
        stock REAL NOT NULL DEFAULT 0,
        reorderLevel REAL NOT NULL DEFAULT 10,
        isActive INTEGER NOT NULL DEFAULT 1,
        isVeg INTEGER NOT NULL DEFAULT 1,
        imageUrl TEXT,
        gstPct REAL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    ''');
    batch.execute('CREATE INDEX idx_menu_business ON menu_items(businessId);');
    batch.execute('CREATE INDEX idx_menu_category ON menu_items(category);');

    // 3. orders
    batch.execute('''
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        orderNo INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'dineIn',
        tableNo TEXT,
        customerPhone TEXT,
        customerName TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        tax REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        paymentMethod TEXT NOT NULL DEFAULT 'cash',
        status TEXT NOT NULL DEFAULT 'pending',
        cancelReason TEXT,
        printed INTEGER NOT NULL DEFAULT 0,
        synced INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        readyAt TEXT,
        collectedAt TEXT
      );
    ''');
    batch.execute('CREATE INDEX idx_orders_business ON orders(businessId);');
    batch.execute('CREATE INDEX idx_orders_status ON orders(status);');
    batch.execute('CREATE INDEX idx_orders_date ON orders(createdAt);');

    // 4. order_items
    batch.execute('''
      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        menuItemId TEXT NOT NULL,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        note TEXT,
        FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE
      );
    ''');
    batch.execute('CREATE INDEX idx_orderitems_order ON order_items(orderId);');

    // 5. expenses
    batch.execute('''
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        amount REAL NOT NULL,
        description TEXT,
        date TEXT NOT NULL,
        receiptUrl TEXT,
        synced INTEGER NOT NULL DEFAULT 0,
        clientKey TEXT,
        createdAt TEXT NOT NULL
      );
    ''');
    batch.execute('CREATE INDEX idx_expenses_business ON expenses(businessId);');
    batch.execute('CREATE INDEX idx_expenses_date ON expenses(date);');

    // 6. inventory_transactions
    batch.execute('''
      CREATE TABLE inventory_transactions (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        menuItemId TEXT NOT NULL,
        qtyChange REAL NOT NULL,
        balanceAfter REAL NOT NULL,
        reason TEXT NOT NULL DEFAULT 'adjustment',
        orderId TEXT,
        note TEXT,
        createdAt TEXT NOT NULL
      );
    ''');
    batch.execute('CREATE INDEX idx_inv_item ON inventory_transactions(menuItemId);');

    // 7. customers
    batch.execute('''
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        totalOrders INTEGER NOT NULL DEFAULT 0,
        totalSpent REAL NOT NULL DEFAULT 0,
        lastOrderAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(businessId, phone)
      );
    ''');

    // 8. report_cache
    batch.execute('''
      CREATE TABLE report_cache (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        type TEXT NOT NULL,
        keyDate TEXT NOT NULL,
        payload TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
    ''');

    // 9. settings (kv store)
    batch.execute('''
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    ''');

    // 10. notifications (in-app)
    batch.execute('''
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        businessId TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        readAt TEXT,
        createdAt TEXT NOT NULL
      );
    ''');

    // 11. sync_queue (offline writes pending push)
    batch.execute('''
      CREATE TABLE sync_queue (
        id TEXT PRIMARY KEY,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );
    ''');

    await batch.commit(noResult: true);
  }

  Future<void> _onUpgrade(Database db, int oldV, int newV) async {
    // v2 — Wipe local caches polluted by the old demo-seeder. The next
    // MenuProvider.load() will re-fill these from the backend.
    if (oldV < 2) {
      final b = db.batch();
      for (final t in ['menu_items', 'orders', 'order_items', 'inventory_transactions', 'sync_queue']) {
        b.delete(t);
      }
      await b.commit(noResult: true);
    }
    // v3 (NP-137): additive column — the idempotency key the expense create
    // POST carries so offline-queued rows can be re-posted/reconciled safely.
    if (oldV < 3) {
      await db.execute('ALTER TABLE expenses ADD COLUMN clientKey TEXT');
    }
    // v4 (review #2, 2026-09-05): additive column — the GST slab of each
    // cached menu item. The next MenuProvider.load() refills it from the
    // backend; until then a null slab falls back to the scheme default.
    if (oldV < 4) {
      await db.execute('ALTER TABLE menu_items ADD COLUMN gstPct REAL');
    }
  }

  Future<void> clearAll() async {
    final d = await db;
    final batch = d.batch();
    for (final t in [
      'businesses', 'menu_items', 'orders', 'order_items', 'expenses',
      'inventory_transactions', 'customers', 'report_cache', 'settings',
      'notifications', 'sync_queue',
    ]) {
      batch.delete(t);
    }
    await batch.commit(noResult: true);
  }
}
