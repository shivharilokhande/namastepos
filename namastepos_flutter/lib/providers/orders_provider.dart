// NamastePOS - Orders state provider

import 'package:flutter/foundation.dart';

import '../models/cart_item.dart';
import '../models/menu_item.dart';
import '../models/order.dart';
import '../utils/formatters.dart';
import '../utils/gst.dart';
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
  // NP-115: the business id of the CURRENT auth session, synced from
  // AuthProvider via the ChangeNotifierProxyProvider in main.dart. Null when
  // signed out. Used to (a) wipe tenant state on logout/switch and (b) refuse
  // loads/fallbacks for a business that isn't the signed-in one.
  String? _authBusinessId;
  // NP-135: delta-poll watermark — the newest server `updated_at` we've
  // applied. Advance-only (a session bill's updatedAt can lag its KOTs', so
  // load() must never move it backwards past what pollDelta already saw).
  DateTime? _lastSyncTs;
  // NP-141: today's Revenue/Orders from /reports/daily — the same numbers the
  // web dashboard shows. The 500-capped list fold stays as offline fallback.
  double? _reportRevenue;
  int? _reportOrderCount;

  List<CartItem> get cart => List.unmodifiable(_cart);
  List<Order> get orders => List.unmodifiable(_orders);
  bool get loading => _loading;

  /// NP-115 — called from main.dart whenever AuthProvider notifies. When the
  /// session's business changes (logout, "use another account", restaurant
  /// switch) any state held for a different tenant is wiped so it can never
  /// leak into the next session.
  void syncAuthSession(String? authBusinessId) {
    if (_authBusinessId == authBusinessId) return;
    _authBusinessId = authBusinessId;
    if (_businessId != null && _businessId != authBusinessId) resetForLogout();
  }

  /// NP-115 — clears all tenant-scoped in-memory state.
  void resetForLogout() {
    _orders.clear();
    _cart.clear();
    _businessId = null;
    _loading = false;
    _lastSyncTs = null;
    _reportRevenue = null;
    _reportOrderCount = null;
    // May run during a ProxyProvider `update` (build phase) — defer the
    // notification so we don't markNeedsBuild mid-build.
    Future.microtask(notifyListeners);
  }

  double get cartSubtotal =>
      _cart.fold<double>(0, (sum, ci) => sum + ci.lineTotal);

  /// GST the SERVER will put on this cart (2026-09-05, review #2) — the same
  /// `computeGstBreakdown` it runs, over the same line amounts the app sends
  /// (unit price × [priceMultiplier], rounded to paise like the order body)
  /// and each item's own `gst_pct`. A composition dealer gets zero, because
  /// orderService refuses to tax their bills at all. This is an ESTIMATE for
  /// the confirm screen, split sizing and offline receipts; the persisted
  /// order row returned by the server is what gets printed when online.
  GstBreakdown cartGst({
    double priceMultiplier = 1.0,
    String? gstScheme,
    bool isInterState = false,
  }) {
    if (gstSchemeChargesNoGst(gstScheme)) return GstBreakdown.zero;
    final m = priceMultiplier <= 0 ? 1.0 : priceMultiplier;
    final fallbackPct = defaultGstPctForScheme(gstScheme);
    return computeGstBreakdown(
      _cart.map((c) => GstLine(
            price: round2(c.unitPrice * m),
            qty: c.qty.toDouble(),
            gstPct: c.item.gstPct ?? fallbackPct,
          )),
      isInterState: isInterState,
    );
  }
  int get cartItemCount =>
      _cart.fold<int>(0, (sum, ci) => sum + ci.qty);

  List<Order> ofStatus(OrderStatus s) =>
      _orders.where((o) => o.status == s).toList();

  Future<void> load(String businessId, {DateTime? day}) async {
    // NP-115: refuse to load a business that isn't the signed-in one — a
    // stale caller (screen unmounting during logout, queued microtask)
    // must not repopulate the store with another tenant's data.
    if (businessId != _authBusinessId) {
      debugPrint('ORDERS load skipped: $businessId != auth $_authBusinessId');
      return;
    }
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
      // NP-115: the session changed (logout / switch) while the fetch was in
      // flight — discard the result instead of repopulating the cleared store.
      if (businessId != _authBusinessId) { _loading = false; return; }
      // 2026-08-31 review fix: capture local orders that were created offline
      // and haven't synced yet BEFORE purging — otherwise purgeAll deletes them
      // and, because the outbox hasn't drained, they're not in the server list
      // either, so they vanish from the UI (inviting a duplicate re-ring).
      final unsynced = await OrderRepo.instance.unsynced(businessId);
      final serverIds = list.map((o) => o.id).toSet();
      final stillPending =
          unsynced.where((o) => !serverIds.contains(o.id)).toList();
      // FB-13 (2026-09-01): atomically replace the cache (purge + re-cache
      // server list + re-cache not-yet-synced locals) in ONE transaction, so an
      // app-kill mid-refresh can't leave the cache empty (blanking the offline
      // fallback and dropping pending orders). Replaces the old three-op
      // purgeAll → cacheAll(server) → cacheAll(pending) sequence.
      await OrderRepo.instance.replaceCache(businessId, list, stillPending);
      _orders
        ..clear()
        ..addAll(stillPending) // newest (just-created offline) first
        ..addAll(list);
      // NP-135: advance the delta watermark to the newest SERVER updatedAt
      // (never local pending rows — client clocks can run ahead of the
      // server and would make the next delta miss real changes). Advance-
      // only: a collapsed bill's updatedAt can lag one of its KOTs', and
      // pollDelta may already have seen a newer raw row.
      DateTime? maxUpd;
      for (final o in list) {
        if (maxUpd == null || o.updatedAt.isAfter(maxUpd)) maxUpd = o.updatedAt;
      }
      // Review fix: never seed the watermark from the CLIENT clock — a fast
      // device clock would make pollDelta miss other-device orders. With no
      // server rows the watermark stays null and pollDelta falls back to a
      // full load() until a real server updatedAt arrives.
      if (maxUpd != null &&
          (_lastSyncTs == null || maxUpd.isAfter(_lastSyncTs!))) {
        _lastSyncTs = maxUpd;
      }
      // NP-141: refresh the daily-report KPIs alongside (fire-and-forget).
      // ignore: unawaited_futures
      _refreshTodayReport(businessId);
    } catch (e) {
      // Used to be `catch (_) {}` — silently masked auth/feature-gate
      // failures and showed stale local-only orders that the dashboard
      // never saw. Now we print the error so we can diagnose, and only
      // fall back to local cache if it's plausibly a network outage.
      debugPrint('ORDERS load failed for biz $businessId: $e');
      // NP-115: never fall back to the local cache for a business that no
      // longer matches the session (e.g. a 403 after a restaurant switch) —
      // that would resurrect the OLD tenant's orders on screen.
      if (businessId != _authBusinessId) {
        _loading = false; notifyListeners();
        return;
      }
      final cached = await OrderRepo.instance.list(businessId, day: day ?? DateTime.now());
      debugPrint('ORDERS load fallback: showing ${cached.length} cached orders');
      _orders
        ..clear()
        ..addAll(cached);
    }
    _loading = false; notifyListeners();
  }

  Future<void> refresh() async {
    // NP-115: no-op when signed out or when the held data belongs to a
    // business other than the current session's.
    if (_businessId == null || _businessId != _authBusinessId) return;
    await load(_businessId!);
  }

  /// NP-135: cheap change-detection poll for the Orders tab. Asks the backend
  /// only for orders updated after the last watermark (raw KOT rows, no
  /// session grouping):
  ///   • empty delta   → nothing changed: no cache rewrite, no notifyListeners
  ///   • non-session Δ → upsert just those rows (cache + in-memory)
  ///   • session Δ     → full load(): a delta of one KOT would collapse into
  ///                     a PARTIAL bill (missing that session's other KOTs)
  /// Full refresh stays with [refresh] for pull-to-refresh / screen mount.
  Future<void> pollDelta() async {
    if (_businessId == null || _businessId != _authBusinessId) return;
    if (_loading) return; // a full load is already in flight
    final since = _lastSyncTs;
    if (since == null) { await load(_businessId!); return; }
    final businessId = _businessId!;
    try {
      // limit 500 (same cap as load()) — the server defaults to 100 and a
      // >100-row delta would silently drop rows the watermark then skips.
      final api = await ApiService.instance
          .listOrders(businessId, updatedSince: since, limit: 500);
      // NP-115: session changed mid-fetch — discard.
      if (businessId != _authBusinessId) return;
      if (api.isEmpty) return; // no changes — the whole point of the delta
      final changed =
          api.cast<Map<String, dynamic>>().map(Order.fromBackend).toList();
      // Advance the watermark FIRST (raw rows carry the true updated_at) so
      // a session-triggered full load can't leave it stale and re-loop.
      for (final o in changed) {
        if (_lastSyncTs == null || o.updatedAt.isAfter(_lastSyncTs!)) {
          _lastSyncTs = o.updatedAt;
        }
      }
      if (changed.any((o) => o.tableSessionId != null || o.isBill)) {
        await load(businessId); // dine-in KOT — rebuild the collapsed bills
        return;
      }
      await OrderRepo.instance.upsertOrders(businessId, changed);
      for (final o in changed) {
        final idx = _orders.indexWhere((e) => e.id == o.id);
        if (idx >= 0) {
          _orders[idx] = o;
        } else {
          _orders.insert(0, o);
        }
      }
      notifyListeners();
    } catch (e) {
      // Poll is best-effort — offline ticks just show the last-known list.
      debugPrint('ORDERS pollDelta failed for biz $businessId: $e');
    }
  }

  /// NP-141: pull today's Revenue/Orders from the daily report — the same
  /// endpoint (and numbers) the web dashboard and the Home Collections card
  /// use — so the Home KPIs stop undercounting once the day crosses the
  /// 500-order list cap. Silent on failure: the list-fold fallback keeps
  /// working offline.
  Future<void> _refreshTodayReport(String businessId) async {
    try {
      final r = await ApiService.instance.dailyReport(businessId, DateTime.now());
      if (businessId != _authBusinessId) return; // NP-115 guard
      final rev = ((r['revenue'] as Map?)?['total'] as num?)?.toDouble();
      final cnt = (r['orderCount'] as num?)?.toInt();
      if (rev != _reportRevenue || cnt != _reportOrderCount) {
        _reportRevenue = rev;
        _reportOrderCount = cnt;
        notifyListeners();
      }
    } catch (_) { /* offline — keep the list-fold fallback */ }
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
    // 2026-09-05 (review #2): the app's GST ESTIMATE for this cart (see
    // [cartGst]). It is NOT sent to the server — the create body omits `tax`
    // entirely so orderService computes GST from the menu's own slabs and the
    // returned order row carries the authoritative tax/cgst/sgst/total. The
    // estimate only feeds the LOCAL sqflite row, i.e. what an offline-queued
    // order shows and prints until the outbox drains.
    double tax = 0,
    double discount = 0,
    // Applied food-coupon code (2026-09-01) — forwarded so the server records
    // the redemption + enforces max_redemptions. Discount itself rides in
    // `discount`. Null when no coupon applied.
    String? couponCode,
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
    // Wallet-as-tender auto-apply (2026-08-30): server draws the customer's
    // wallet down for the residual due after membership/discounts, capped at
    // walletCapInr. Uses the online direct-post path (the server needs the live
    // balance), so it's not queued offline.
    bool autoWallet = false,
    double? walletCapInr,
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
    // FB-06 (2026-09-01): floor the stored/printed total at 0. An over-discount
    // (cashier typo where discount > subtotal+tax) previously produced a NEGATIVE
    // total on the offline OrderRepo path — the build() display clamps to ≥0 but
    // the value actually persisted and printed here did not. The online path is
    // corrected by the server recompute; this fixes the offline path to match.
    final total = (subtotal + tax - discount).clamp(0, double.infinity).toDouble();

    // Round-2 (2026-08-25): split payments v2 post DIRECTLY to the backend
    // instead of via OrderRepo/OfflineOutbox. WHY: the outbox body carries
    // the legacy `splits` key (no wallet, lenient sum) and lives in
    // repositories.dart which is shared by legacy callers; the new
    // `paymentBreakdown` contract needs the server live anyway (wallet
    // balance + strict leg-sum are validated server-side), so an offline
    // queue for it would only defer a guaranteed 400. Single-tender and
    // legacy-split orders keep the offline-tolerant repo path below.
    // 2026-08-31 review fix: loyalty-points redemption ALSO needs the live
    // server (it burns points against a balance the server must re-validate).
    // Queuing it offline would print a discounted bill + take cash, then the
    // server could reject the stale redeem on drain → silent loss. Force it
    // onto the online direct-post path alongside wallet/split, so offline it
    // fails loudly (cashier told) instead of queuing a phantom discount.
    // FB-05 (2026-09-01): a coupon must also be redeemed against the LIVE server
    // (max_redemptions + expiry are enforced server-side, 2026-09-01). Queuing a
    // coupon order offline would print a discounted bill + collect cash, then the
    // server could reject the stale coupon on drain → silent loss — the same
    // staleness risk already handled for wallet/points above. Force it online so
    // offline it fails loudly (cashier told) instead of queuing a phantom discount.
    if ((paymentBreakdown != null && paymentBreakdown.isNotEmpty)
        || autoWallet
        || pointsToRedeem > 0
        || (couponCode != null && couponCode.isNotEmpty)) {
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
        // `tax` deliberately OMITTED (2026-09-05, review #2): an absent field
        // tells the server "compute GST from the menu"; a literal 0 would be
        // read as "the client computed zero tax". Never send 0 here.
        'discount': discount,
        if (couponCode != null && couponCode.isNotEmpty) 'couponCode': couponCode,
        'paymentMethod': paymentMethod.name,
        'paymentBreakdown': paymentBreakdown,
        if (autoWallet) 'autoWallet': true,
        if (autoWallet && walletCapInr != null) 'walletCapInr': walletCapInr,
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
      couponCode: couponCode,
      // C1 fix (2026-08-23, review): pointsToRedeem was accepted here but
      // never forwarded — the POS showed a redeemed total while the
      // backend recorded full price and never burned the points.
      pointsToRedeem: pointsToRedeem,
    );
    _cart.clear();
    // The order id IS the clientId (offline-sync fix): the backend honours it
    // on insert, so status updates on the local row resolve server-side too.
    // We still re-pull below because the SERVER's row is the truth for
    // everything the app only estimated — tax/cgst/sgst/total, order number,
    // points burned, session grouping. When the POST went through just now,
    // OrderRepo.create already returned that server row; the re-pull covers
    // the offline-queued case and anything the outbox drains later. Failure
    // here is non-fatal (we still have the local copy in _orders).
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
    // NP-115: same tenant guard as load().
    if (businessId != _authBusinessId) return;
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

  // KPIs for today (for dashboard). NP-141: prefer the daily-report figures
  // (match the web dashboard; not capped at the 500-order list limit); the
  // IST-bucketed list fold remains ONLY as the offline fallback.
  // IST day-bucketing (2026-08-23): backend timestamps are UTC — raw day
  // comparison drops orders placed before 05:30 IST.
  double get todayRevenue => _reportRevenue ?? _foldTodayRevenue;

  int get todayOrderCount => _reportOrderCount ?? _foldTodayOrderCount;

  double get _foldTodayRevenue => _orders
      .where((o) =>
          AppFmt.isISTToday(o.createdAt) && o.status != OrderStatus.cancelled)
      .fold<double>(0, (sum, o) => sum + o.total);

  int get _foldTodayOrderCount => _orders
      .where((o) =>
          AppFmt.isISTToday(o.createdAt) && o.status != OrderStatus.cancelled)
      .length;
}
