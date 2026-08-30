// NamastePOS - Orders state provider

import 'package:flutter/foundation.dart';

import '../models/cart_item.dart';
import '../models/menu_item.dart';
import '../models/order.dart';
import '../utils/formatters.dart';
import 'package:uuid/uuid.dart';
import 'package:dio/dio.dart';
import '../services/api_service.dart';
import '../services/repositories.dart';
import '../services/offline_outbox.dart';

class OrdersProvider extends ChangeNotifier {
  // Active cart for the POS screen
  final List<CartItem> _cart = [];
  // Recent orders (in-memory snapshot of today's queue)
  final List<Order> _orders = [];
  String? _businessId;
  bool _loading = false;

  List<CartItem> get cart => List.unmodifiable(_cart);
  List<Order> get orders => List.unmodifiable(_orders);
  bool get loading => _loading;

  double get cartSubtotal =>
      _cart.fold<double>(0, (sum, ci) => sum + ci.lineTotal);
  int get cartItemCount =>
      _cart.fold<int>(0, (sum, ci) => sum + ci.qty);

  List<Order> ofStatus(OrderStatus s) =>
      _orders.where((o) => o.status == s).toList();

  Future<void> load(String businessId, {DateTime? day}) async {
    _businessId = businessId;
    _loading = true; notifyListeners();
    // Backend is the source of truth — pull today's orders from the API.
    // Local SQLite is only used as an offline fallback.
    try {
      // groupBy=session collapses multi-KOT dine-in orders into one bill
      // per session. Takeaway / aggregator orders pass through unchanged.
      final api = await ApiService.instance.listOrders(businessId, groupBy: 'session');
      final list = api
          .cast<Map<String, dynamic>>()
          .map(Order.fromBackend)
          .toList();
      debugPrint('ORDERS load: backend returned ${list.length} orders for biz $businessId');
      // Push 13.7: backend succeeded → purge the local SQLite cache so
      // any ghost orders (created offline, never synced, or from old
      // businesses) can't keep haunting the UI. This is the automatic
      // version of the broom-button "Clean local cache" action.
      await OrderRepo.instance.purgeAll(businessId);
      // H3 fix (2026-08-23): repopulate the offline cache — purging
      // without re-caching left the offline fallback permanently empty.
      await OrderRepo.instance.cacheAll(businessId, list);
      _orders
        ..clear()
        ..addAll(list);
    } catch (e) {
      // Used to be `catch (_) {}` — silently masked auth/feature-gate
      // failures and showed stale local-only orders that the dashboard
      // never saw. Now we print the error so we can diagnose, and only
      // fall back to local cache if it's plausibly a network outage.
      debugPrint('ORDERS load failed for biz $businessId: $e');
      final cached = await OrderRepo.instance.list(businessId, day: day ?? DateTime.now());
      debugPrint('ORDERS load fallback: showing ${cached.length} cached orders');
      _orders
        ..clear()
        ..addAll(cached);
    }
    _loading = false; notifyListeners();
  }

  Future<void> refresh() async {
    if (_businessId != null) await load(_businessId!);
  }

  // ── Cart operations ─────────────────────────────────────────────────────
  /// Add a configured cart line. Dedupes by `lineKey` — same item + same
  /// variant + same modifiers + same note bumps qty instead of stacking.
  void addToCart(CartItem item) {
    final idx = _cart.indexWhere((c) => c.lineKey == item.lineKey);
    if (idx >= 0) {
      _cart[idx].qty += item.qty;
    } else {
      _cart.add(item);
    }
    notifyListeners();
  }

  /// "Quick add" — for items that have no variants/modifiers, the POS tile
  /// taps straight through. The first time it creates a base line; second
  /// tap on the same simple item bumps qty.
  void quickAdd(MenuItem menuItem) {
    final baseKey = '${menuItem.id}|||';
    final idx = _cart.indexWhere((c) => c.lineKey == baseKey);
    if (idx >= 0) {
      _cart[idx].qty += 1;
    } else {
      _cart.add(CartItem(item: menuItem, qty: 1));
    }
    notifyListeners();
  }

  void incrementLine(String lineKey) {
    final idx = _cart.indexWhere((c) => c.lineKey == lineKey);
    if (idx >= 0) { _cart[idx].qty += 1; notifyListeners(); }
  }

  void decrementLine(String lineKey) {
    final idx = _cart.indexWhere((c) => c.lineKey == lineKey);
    if (idx >= 0) {
      _cart[idx].qty -= 1;
      if (_cart[idx].qty <= 0) _cart.removeAt(idx);
      notifyListeners();
    }
  }

  void removeLine(String lineKey) {
    _cart.removeWhere((c) => c.lineKey == lineKey);
    notifyListeners();
  }

  void setLineNote(String lineKey, String? note) {
    final idx = _cart.indexWhere((c) => c.lineKey == lineKey);
    if (idx >= 0) { _cart[idx].note = note; notifyListeners(); }
  }

  // Backwards-compatible helpers used by older screens.
  void incrementCart(String menuItemId) {
    final idx = _cart.indexWhere((c) => c.item.id == menuItemId);
    if (idx >= 0) { _cart[idx].qty += 1; notifyListeners(); }
  }
  void decrementCart(String menuItemId) {
    final idx = _cart.indexWhere((c) => c.item.id == menuItemId);
    if (idx >= 0) {
      _cart[idx].qty -= 1;
      if (_cart[idx].qty <= 0) _cart.removeAt(idx);
      notifyListeners();
    }
  }
  void setCartNote(String menuItemId, String? note) {
    final idx = _cart.indexWhere((c) => c.item.id == menuItemId);
    if (idx >= 0) { _cart[idx].note = note; notifyListeners(); }
  }

  /// Total qty across all lines for a menu item id — used by the POS tile
  /// "×N" badge to show total times that dish is in the cart.
  int qtyInCart(String menuItemId) {
    int n = 0;
    for (final c in _cart) {
      if (c.item.id == menuItemId) n += c.qty;
    }
    return n;
  }

  void clearCart() {
    _cart.clear();
    notifyListeners();
  }

  // ── Order operations ────────────────────────────────────────────────────
  Future<Order> createOrderFromCart({
    required String businessId,
    required OrderSource source,
    String? tableNo,
    String? customerPhone,
    String? customerName,
    PaymentMethod paymentMethod = PaymentMethod.cash,
    double tax = 0,
    double discount = 0,
    int pointsToRedeem = 0,
    // FF-322 mobile split-tender — [{method:'cash', amountInr: 200},
    // {method:'upi', amountInr: 300}]. When set, paymentMethod is
    // interpreted as the label to show in the KOT header.
    List<Map<String, dynamic>>? splits,
    // Round-2 split payments v2 (2026-08-25): strict 1-3 leg breakdown
    // [{method: cash|upi|card|online|wallet, amountInr}] that must sum to
    // the order total ±₹0.01 (server 400s otherwise). Supersedes `splits`
    // — wallet legs and the strict sum check only exist on this key.
    List<Map<String, dynamic>>? paymentBreakdown,
    // Idempotency (2026-08-30 review): the caller can supply a stable clientId
    // generated ONCE per checkout attempt and reused across retries, so a
    // committed-but-timed-out split order isn't duplicated when the cashier
    // re-taps. If omitted we mint one (single call), but retries must reuse.
    String? clientId,
    // Surge pricing (2026-08-23): >1 multiplies every line price. The
    // confirm screen fetches /surge/current and passes it through so
    // "Sun 1-2pm ×2" rules actually change the bill.
    double priceMultiplier = 1.0,
    // Captain add-items binding (2026-08-23): explicit session/table ids
    // beat the backend's table-label lookup.
    String? tableSessionId,
    String? tableId,
  }) async {
    // Each cart line becomes an order_item. Effective unit price already
    // bakes in variant override + modifier deltas via `unitPrice`.
    final m = priceMultiplier <= 0 ? 1.0 : priceMultiplier;
    final items = _cart
        .map((c) => OrderItem(
              id: '', // replaced inside repo
              orderId: '',
              menuItemId: c.item.id,
              name: c.configSummary.isEmpty ? c.item.name : '${c.item.name} (${c.configSummary})',
              price: double.parse((c.unitPrice * m).toStringAsFixed(2)),
              qty: c.qty.toDouble(),
              note: c.note,
            ))
        .toList();
    final subtotal = double.parse((cartSubtotal * m).toStringAsFixed(2));
    final total = subtotal + tax - discount;

    // Round-2 (2026-08-25): split payments v2 post DIRECTLY to the backend
    // instead of via OrderRepo/OfflineOutbox. WHY: the outbox body carries
    // the legacy `splits` key (no wallet, lenient sum) and lives in
    // repositories.dart which is shared by legacy callers; the new
    // `paymentBreakdown` contract needs the server live anyway (wallet
    // balance + strict leg-sum are validated server-side), so an offline
    // queue for it would only defer a guaranteed 400. Single-tender and
    // legacy-split orders keep the offline-tolerant repo path below.
    if (paymentBreakdown != null && paymentBreakdown.isNotEmpty) {
      // Review fix (2026-08-25, 🔴): this direct-post path had NO clientId,
      // so a request the server committed but that timed out client-side
      // (flaky café network, 20s timeout) would be retried → DUPLICATE
      // order + double wallet debit + double loyalty burn. The backend
      // dedupes on client_id (same as the legacy OrderRepo path), so we
      // mint one here to make split-tender orders idempotent on retry.
      // Reuse the caller-supplied id across retries; only mint if absent.
      final effectiveClientId = clientId ?? const Uuid().v4();
      final resp = await ApiService.instance.createOrder(businessId, {
        'clientId': effectiveClientId,
        // Same body shape OrderRepo posts — backend Joi requires name +
        // price on every item, not just menuItemId.
        'items': items
            .map((i) => {
                  'menuItemId': i.menuItemId,
                  'name': i.name,
                  'price': i.price,
                  'qty': i.qty,
                  if (i.note != null) 'note': i.note,
                })
            .toList(),
        'source': source.name,
        'tableNo': tableNo,
        if (tableSessionId != null) 'tableSessionId': tableSessionId,
        if (tableId != null) 'tableId': tableId,
        if (pointsToRedeem > 0) 'pointsToRedeem': pointsToRedeem,
        'customerPhone': customerPhone,
        'customerName': customerName,
        'tax': tax,
        'discount': discount,
        'paymentMethod': paymentMethod.name,
        'paymentBreakdown': paymentBreakdown,
      });
      final created = Order.fromBackend(
          ((resp['order'] ?? resp) as Map).cast<String, dynamic>());
      _cart.clear();
      _orders.insert(0, created);
      notifyListeners();
      // Re-pull so the in-memory list reflects backend truth (points burned,
      // wallet debited, session grouping) — same pattern as the repo path.
      Future.microtask(() async {
        try { await load(businessId); } catch (_) {}
      });
      return created;
    }

    final order = await OrderRepo.instance.create(
      businessId: businessId,
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
      splits: splits,
      tableSessionId: tableSessionId,
      tableId: tableId,
      // C1 fix (2026-08-23, review): pointsToRedeem was accepted here but
      // never forwarded — the POS showed a redeemed total while the
      // backend recorded full price and never burned the points.
      pointsToRedeem: pointsToRedeem,
    );
    _cart.clear();
    // Push 13.8: mobile generates the local UUID, backend mints a new one
    // on insert. If we just push the locally-created order into _orders
    // and never re-sync, every later updateStatus on it 404s because
    // backend's ID is different. Re-pull from backend so the in-memory
    // list reflects the backend's UUID for the new row. Failure here is
    // non-fatal (we still have the local copy in _orders).
    _orders.insert(0, order);
    notifyListeners();
    // Fire-and-forget refresh — UI shows the optimistic row immediately,
    // then the real backend version takes over a moment later.
    Future.microtask(() async {
      try { await load(businessId); } catch (_) {}
    });
    return order;
  }

  Future<void> updateStatus(String orderId, OrderStatus status, {String? reason}) async {
    // BUG FIX: OrderRepo.updateStatus only touches local SQLite. Without
    // also calling the backend, a hard refresh wipes the optimistic update
    // and the order reappears in 'pending'. Push the status to the backend
    // FIRST, then update the local cache + in-memory list on success.
    // H1 fix (2026-08-23, review): the old `orElse: () => _orders.first`
    // threw a StateError on an empty list and could silently borrow
    // ANOTHER order's businessId (wrong-tenant 404). Resolve explicitly.
    String businessId = _businessId ?? '';
    if (businessId.isEmpty) {
      for (final o in _orders) {
        if (o.id == orderId) { businessId = o.businessId; break; }
      }
    }
    if (businessId.isNotEmpty) {
      try {
        // Offline-tolerant status change (2026-08-25): the old code called
        // ApiService.updateOrderStatus directly and RETHREW on any error —
        // so with no internet, "Mark ready / Next" threw and the ticket
        // never advanced. Route through the OfflineOutbox instead (same
        // path the offline order-create uses): when offline it QUEUES the
        // PUT and replays it on reconnect, returning null (no throw), so
        // the kitchen keeps moving tickets. A real 4xx (e.g. 404 ghost)
        // still rethrows via sendOrQueue so we can clean it up below.
        await OfflineOutbox().sendOrQueue(
          endpoint: '/businesses/$businessId/orders/$orderId/status',
          method: 'PUT',
          body: {'status': status.name, if (reason != null) 'reason': reason},
        );
      } on DioException catch (e) {
        debugPrint('updateStatus($orderId → ${status.name}) failed: $e');
        if (e.response?.statusCode == 404) {
          // Ghost order — exists only in local cache, never reached the
          // backend (or was wiped server-side). Remove it from the in-mem
          // list AND local SQLite so the UI is no longer broken.
          await OrderRepo.instance.removeById(orderId);
          _orders.removeWhere((o) => o.id == orderId);
          notifyListeners();
        }
        rethrow;
      } catch (e) {
        debugPrint('updateStatus($orderId → ${status.name}) failed: $e');
        rethrow;
      }
    }
    // Optimistic local update — applies whether the PUT was sent live or
    // queued for later sync, so the UI reflects the new status immediately.
    await OrderRepo.instance.updateStatus(orderId, status, reason: reason);
    final idx = _orders.indexWhere((o) => o.id == orderId);
    if (idx >= 0) {
      _orders[idx] = _orders[idx].copyWith(
        status: status,
        cancelReason: reason,
        readyAt: status == OrderStatus.ready ? DateTime.now() : null,
        collectedAt: status == OrderStatus.collected ? DateTime.now() : null,
      );
      notifyListeners();
    }
  }

  /// Wipes the local SQLite orders cache and re-pulls from backend. Use
  /// when the user has ghost / stale orders that no longer exist in the
  /// backend (e.g. created offline and never synced). Exposed via the
  /// Orders tab's "Clean local cache" action.
  Future<void> rebuildFromBackend(String businessId) async {
    _loading = true; notifyListeners();
    try {
      await OrderRepo.instance.purgeAll(businessId);
      // groupBy=session collapses multi-KOT dine-in orders into one bill
      // per session. Takeaway / aggregator orders pass through unchanged.
      final api = await ApiService.instance.listOrders(businessId, groupBy: 'session');
      final list = api
          .cast<Map<String, dynamic>>()
          .map(Order.fromBackend)
          .toList();
      _orders
        ..clear()
        ..addAll(list);
    } catch (e) {
      debugPrint('rebuildFromBackend failed: $e');
    }
    _loading = false; notifyListeners();
  }

  Future<void> markPrinted(String orderId) async {
    await OrderRepo.instance.markPrinted(orderId);
    final idx = _orders.indexWhere((o) => o.id == orderId);
    if (idx >= 0) {
      _orders[idx] = _orders[idx].copyWith(printed: true);
      notifyListeners();
    }
  }

  // KPIs for today (for dashboard). IST day-bucketing (2026-08-23):
  // backend timestamps are UTC — raw day comparison drops orders placed
  // before 05:30 IST and Postgres-DATE values entirely.
  double get todayRevenue => _orders
      .where((o) =>
          AppFmt.isISTToday(o.createdAt) && o.status != OrderStatus.cancelled)
      .fold<double>(0, (sum, o) => sum + o.total);

  int get todayOrderCount => _orders
      .where((o) =>
          AppFmt.isISTToday(o.createdAt) && o.status != OrderStatus.cancelled)
      .length;
}
