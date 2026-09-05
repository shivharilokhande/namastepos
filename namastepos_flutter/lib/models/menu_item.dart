// NamastePOS - Menu Item model

enum MenuUnit { piece, kg, gram, liter, ml, plate }

extension MenuUnitX on MenuUnit {
  String get short {
    switch (this) {
      case MenuUnit.piece: return 'pcs';
      case MenuUnit.kg: return 'kg';
      case MenuUnit.gram: return 'g';
      case MenuUnit.liter: return 'L';
      case MenuUnit.ml: return 'ml';
      case MenuUnit.plate: return 'plt';
    }
  }
}

MenuUnit menuUnitFromString(String? s) {
  switch (s) {
    case 'kg': return MenuUnit.kg;
    case 'gram':
    case 'g': return MenuUnit.gram;
    case 'liter':
    case 'L': return MenuUnit.liter;
    case 'ml': return MenuUnit.ml;
    case 'plate': return MenuUnit.plate;
    case 'piece':
    default: return MenuUnit.piece;
  }
}

class MenuItem {
  final String id;
  final String businessId;
  final String name;
  final String? description;
  final String category;       // e.g., Food, Beverage, Dessert
  final double price;
  final double? costPrice;
  final String? sku;
  final MenuUnit unit;
  final double stock;
  // NP-205 (migration 084) — is [stock] a real count?
  //   false → unlimited: sales never reduce it and it can never be "out".
  //   true  → finite: sales deduct it and <= 0 means SOLD OUT.
  // Before this flag, 0 meant either thing and every screen guessed
  // differently — the QR menu told diners "only 0 left" for dishes the POS
  // was happily selling. NOT cached in sqflite (like soldOutUntil) so the
  // local schema is untouched; an offline read defaults to false = unlimited,
  // which fails OPEN — the server still enforces the real count on create.
  final bool trackStock;
  final double reorderLevel;
  final bool isActive;
  final bool isVeg;
  final String? imageUrl;
  // 86'd (sold-out) until this time; null = available. Far-future value
  // means "sold out until restocked". Transient (backend-only) — not
  // persisted into the local sqflite cache.
  final DateTime? soldOutUntil;
  // GST slab from `menu_items.gst_pct` (0 / 5 / 12 / 18 / 28), 2026-09-05
  // (review #2). The server prices and taxes every order from ITS menu; this
  // copy exists so the confirm screen can show the cashier the same tax the
  // server is about to compute, split legs can be sized against the real
  // total, and an offline-queued order can print an estimate. Null only on a
  // sqflite row cached before the column existed (or an older backend) —
  // callers fall back to `defaultGstPctForScheme(business.gstScheme)`.
  final double? gstPct;
  final DateTime createdAt;
  final DateTime updatedAt;

  MenuItem({
    required this.id,
    required this.businessId,
    required this.name,
    this.description,
    required this.category,
    required this.price,
    this.costPrice,
    this.sku,
    this.unit = MenuUnit.piece,
    this.stock = 0,
    this.trackStock = false,
    this.reorderLevel = 10,
    this.isActive = true,
    this.isVeg = true,
    this.imageUrl,
    this.soldOutUntil,
    this.gstPct,
    required this.createdAt,
    required this.updatedAt,
  });

  // NP-205: only a TRACKED item can be low or out. Every untracked dish sits
  // at 0 forever, so an unguarded `stock <= reorderLevel` marked a whole menu
  // "LOW" and the inventory list was a wall of amber.
  bool get isLowStock => trackStock && stock <= reorderLevel;
  // Deliberately NOT folded into [isSoldOut]: for a dish WITH variants the
  // parent's stock is no longer deducted at all (each size owns its own), so
  // a stale parent 0 must not grey the dish out in the POS grid while Large
  // is sitting in the fridge. Sold-out-by-count is decided per variant in
  // item_config_sheet, and server-side under a row lock either way.
  bool get isOutOfStock => trackStock && stock <= 0;
  bool get isSoldOut =>
      soldOutUntil != null && soldOutUntil!.isAfter(DateTime.now());
  double get margin => costPrice == null ? 0 : (price - costPrice!);
  double get marginPct => (costPrice == null || costPrice == 0)
      ? 0
      : ((price - costPrice!) / price) * 100;

  MenuItem copyWith({
    String? name,
    String? description,
    String? category,
    double? price,
    double? costPrice,
    String? sku,
    MenuUnit? unit,
    double? stock,
    bool? trackStock,
    double? reorderLevel,
    bool? isActive,
    bool? isVeg,
    String? imageUrl,
    double? gstPct,
  }) {
    return MenuItem(
      id: id,
      businessId: businessId,
      name: name ?? this.name,
      description: description ?? this.description,
      category: category ?? this.category,
      price: price ?? this.price,
      costPrice: costPrice ?? this.costPrice,
      sku: sku ?? this.sku,
      unit: unit ?? this.unit,
      stock: stock ?? this.stock,
      trackStock: trackStock ?? this.trackStock,
      reorderLevel: reorderLevel ?? this.reorderLevel,
      isActive: isActive ?? this.isActive,
      isVeg: isVeg ?? this.isVeg,
      imageUrl: imageUrl ?? this.imageUrl,
      // Local-only field, not persisted in sqflite — keep it across copies.
      soldOutUntil: soldOutUntil,
      gstPct: gstPct ?? this.gstPct,
      createdAt: createdAt,
      updatedAt: DateTime.now(),
    );
  }

  factory MenuItem.fromMap(Map<String, dynamic> m) => MenuItem(
        id: m['id'] as String,
        businessId: m['businessId'] as String? ?? '',
        name: m['name'] as String? ?? '',
        description: m['description'] as String?,
        category: m['category'] as String? ?? 'Food',
        price: (m['price'] as num?)?.toDouble() ?? 0,
        costPrice: (m['costPrice'] as num?)?.toDouble(),
        sku: m['sku'] as String?,
        unit: menuUnitFromString(m['unit'] as String?),
        stock: (m['stock'] as num?)?.toDouble() ?? 0,
        // Not a column in the local cache (see the field's doc) — an offline
        // read is "unlimited", and the server re-checks on order create.
        trackStock: false,
        reorderLevel: (m['reorderLevel'] as num?)?.toDouble() ?? 10,
        isActive: (m['isActive'] as int? ?? 1) == 1,
        isVeg: (m['isVeg'] as int? ?? 1) == 1,
        imageUrl: m['imageUrl'] as String?,
        // sqflite column added in DB v4 — null on rows cached before that.
        gstPct: (m['gstPct'] as num?)?.toDouble(),
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
        updatedAt: DateTime.tryParse(m['updatedAt']?.toString() ?? '') ??
            DateTime.now(),
      );

  /// Backend's /v1/businesses/:id/menu returns rows where booleans are real
  /// `bool`s (not sqflite's 0/1), `businessId` is set, and `stock`/`price`
  /// may come back as JSON numbers. This factory handles all that without
  /// crashing on the type mismatch the sqflite fromMap would hit.
  factory MenuItem.fromBackend(Map<String, dynamic> m) => MenuItem(
        id: m['id'] as String,
        businessId: m['businessId'] as String? ?? '',
        name: m['name'] as String? ?? '',
        description: m['description'] as String?,
        category: m['category'] as String? ?? 'Food',
        price: (m['price'] as num?)?.toDouble() ?? 0,
        costPrice: (m['costPrice'] as num?)?.toDouble(),
        sku: m['sku'] as String?,
        unit: menuUnitFromString(m['unit'] as String?),
        stock: (m['stock'] as num?)?.toDouble() ?? 0,
        // NP-205 (migration 084). Absent on an older backend ⇒ false ⇒
        // unlimited, i.e. the pre-084 behaviour of never blocking a sale.
        trackStock: m['trackStock'] == true,
        reorderLevel: (m['reorderLevel'] as num?)?.toDouble() ?? 10,
        isActive: m['isActive'] is bool ? m['isActive'] as bool
                : ((m['isActive'] as int?) ?? 1) == 1,
        isVeg:    m['isVeg']    is bool ? m['isVeg']    as bool
                : ((m['isVeg']    as int?) ?? 1) == 1,
        imageUrl: m['imageUrl'] as String?,
        soldOutUntil: m['soldOutUntil'] != null
            ? DateTime.tryParse(m['soldOutUntil'].toString())
            : null,
        // menuService serialises `gstPct` as a number (or null when the row's
        // column is somehow null). Tolerate a numeric string from older
        // builds too; anything unparseable stays null → scheme default.
        gstPct: m['gstPct'] is num
            ? (m['gstPct'] as num).toDouble()
            : double.tryParse(m['gstPct']?.toString() ?? ''),
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
        updatedAt: DateTime.tryParse(m['updatedAt']?.toString() ?? '') ??
            DateTime.now(),
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'businessId': businessId,
        'name': name,
        'description': description,
        'category': category,
        'price': price,
        'costPrice': costPrice,
        'sku': sku,
        'unit': unit.name,
        'stock': stock,
        'reorderLevel': reorderLevel,
        'isActive': isActive ? 1 : 0,
        'isVeg': isVeg ? 1 : 0,
        'imageUrl': imageUrl,
        'gstPct': gstPct,
        'createdAt': createdAt.toIso8601String(),
        'updatedAt': updatedAt.toIso8601String(),
      };
}
