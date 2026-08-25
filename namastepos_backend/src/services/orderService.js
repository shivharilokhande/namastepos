// NamastePOS backend - order service
//
// Order creation is atomic: insert order → insert order_items →
// decrement menu_items.stock → log inventory_transactions, all in a single txn.
// Supports idempotency via client_id (so a mobile retry never duplicates).

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');
const sub = require('./subscriptionService');
const customers = require('./customerService');
const loyalty = require('./loyaltyService');
const addons = require('./addonService');
const kot = require('./kotService');
const recipes = require('./recipeService');
const { computeGstBreakdown } = require('./gstService2');

function serializeOrder(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    orderNo: row.order_no,
    source: row.source,
    tableNo: row.table_no,
    // Surfaced so the orders list / detail can branch on
    // "is-part-of-a-table-session" and collapse multi-KOT bills.
    tableSessionId: row.table_session_id,
    customerPhone: row.customer_phone,
    customerName: row.customer_name,
    subtotal: parseFloat(row.subtotal),
    tax: parseFloat(row.tax),
    discount: parseFloat(row.discount),
    total: parseFloat(row.total),
    paymentMethod: row.payment_method,
    status: row.status,
    cancelReason: row.cancel_reason,
    cancelReasonCode: row.cancel_reason_code,
    printed: row.printed,
    clientId: row.client_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
    collectedAt: row.collected_at,
    customerId: row.customer_id,
    pointsEarned: row.points_earned,
    pointsRedeemed: row.points_redeemed,
    loyaltyDiscountInr: (row.loyalty_discount_paise || 0) / 100,
    // Sprint 1 fields
    serviceChargeInr: (row.service_charge_paise || 0) / 100,
    roundOffInr: (row.round_off_paise || 0) / 100,
    discountIsPreTax: row.discount_is_pre_tax !== false,
    tokenNo: row.token_no,
    reprintCount: row.reprint_count || 0,
    lastReprintAt: row.last_reprint_at,
    items: items.map((it) => ({
      id: it.id,
      orderId: it.order_id,
      menuItemId: it.menu_item_id,
      name: it.name,
      price: parseFloat(it.price),
      qty: parseFloat(it.qty),
      note: it.note,
      variantId: it.variant_id,
      variantLabel: it.variant_label,
      modifierLines: it.modifier_lines || null,
    })),
  };
}

// FF-305 reprint — bumps counter + timestamp, used by audit + the printed
// receipt header ("DUPLICATE — printed 2× on 2026-05-20 13:42").
async function markReprint(businessId, orderId) {
  const r = await query(
    `UPDATE orders
        SET reprint_count = reprint_count + 1,
            last_reprint_at = NOW()
      WHERE business_id = $1 AND id = $2
      RETURNING reprint_count, last_reprint_at`,
    [businessId, orderId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found');
  return r.rows[0];
}

// P0-2 fix: atomic per-business counter. The previous version did
// SELECT MAX(order_no)+1 outside any row lock — under concurrent POSTs the
// uq_orders_no constraint would catch the race but one client always got a
// hard 23505 error. The counters table makes the allocation atomic.
async function nextOrderNo(client, businessId) {
  const r = await client.query(
    `INSERT INTO business_counters (business_id, last_order_no)
     VALUES ($1, 1)
     ON CONFLICT (business_id) DO UPDATE
       SET last_order_no = business_counters.last_order_no + 1,
           updated_at = NOW()
     RETURNING last_order_no`,
    [businessId],
  );
  return r.rows[0].last_order_no;
}

async function create(businessId, body) {
  // P0 fix (2026-08-22): destructured `tax` was `const`; line 289 tried
  // to reassign it when item-level GST was passed → TypeError on any
  // order that used per-item GST but omitted `body.tax`. Split into
  // let-binding.
  const {
    clientId = null, source = 'dineIn', tableNo = null, customerPhone = null,
    customerName = null, items, discount = 0,
    paymentMethod = 'cash',
    pointsToRedeem = 0, // ← Loyalty: redeem points at checkout
    // Dine-in running bill: when set, link this order (KOT) to an open
    // table session so the bill accumulates across multiple orders until
    // settle-and-pay. If `tableId` is set but `tableSessionId` is not,
    // and source = 'dineIn', we auto-open a session.
    tableSessionId = null,
    tableId = null,
    // Sprint 1 — bill polish + tokens
    serviceChargePct = null, // overrides tenant default if set
    discountIsPreTax = true, // FF-303: false = post-tax (instant cashback)
    roundOffEnabled = true, // FF-302: enabled at order level; settings drive default
    // FF-903 — server assignment + tip (post-tax). Both optional; if
    // `serverUserId` is missing the order is unattributed.
    serverUserId = null,
    tipInr = 0,
    // FF-312 — split-tender. If `splits` is a non-empty array of
    // {method, amountInr} we record every leg into `payments` and set
    // orders.is_split_tender=true. `paymentMethod` above becomes the
    // largest leg's method (for the KOT header + Overview donut).
    splits = null,
    // FF-1005 gift card / wallet redemption applied to this order.
    // {giftCardCode?, customerId?, amountInr}. Deducted BEFORE splits.
    walletRedeem = null,
    // Aggregator channel ('zomato'|'swiggy'|...) — set by aggregatorService.
    channel = null,
  } = body;
  // P0: `tax` is mutable — item-GST branch below may replace it.
  let tax = body.tax || 0;

  if (!items || items.length === 0) throw new BadRequest('Order must have at least one item');

  // Push 13.4: the mobile POS only knows the table LABEL (e.g. "1", "A1"),
  // not its UUID. Resolve tableNo → tableId so the auto-session logic
  // below kicks in and the table actually flips to 'occupied'. Without
  // this, POS orders left tables stuck at 'available' and the Captain
  // tap-to-add-items flow could never fire.
  let resolvedTableId = tableId;
  if (!resolvedTableId && tableNo && source === 'dineIn') {
    const tableLookup = await query(
      `SELECT id FROM tables
        WHERE business_id = $1 AND label = $2
        LIMIT 1`,
      [businessId, tableNo],
    );
    if (tableLookup.rowCount > 0) {
      resolvedTableId = tableLookup.rows[0].id;
    }
  }

  // Auto-open a session if dine-in + table + no session
  let resolvedSessionId = tableSessionId;
  if (!resolvedSessionId && resolvedTableId && source === 'dineIn') {
    const existing = await query(
      'SELECT id FROM table_sessions WHERE table_id = $1 AND status = \'open\' LIMIT 1',
      [resolvedTableId],
    );
    if (existing.rowCount > 0) {
      resolvedSessionId = existing.rows[0].id;
    } else {
      const opened = await query(
        `INSERT INTO table_sessions
           (business_id, table_id, guest_count, customer_phone, customer_name)
         VALUES ($1, $2, 2, $3, $4) RETURNING id`,
        [businessId, resolvedTableId, customerPhone, customerName],
      );
      resolvedSessionId = opened.rows[0].id;
      // Flip the table to occupied
      await query(
        `UPDATE tables SET status = 'occupied'::table_status,
                            current_session_id = $1
          WHERE business_id = $2 AND id = $3`,
        [resolvedSessionId, businessId, resolvedTableId],
      );
    }
  }

  // Resolve loyalty addon + customer + redemption discount BEFORE the order txn
  let loyaltyActive = false;
  let loyaltySettings = null;
  let customerRow = null;
  let loyaltyDiscountPaise = 0;

  if (customerPhone) {
    // Fix (2026-08-22): gate on the resolved plan feature (plan OR addon),
    // not the paid addon alone — Pro-plan businesses never earned points.
    loyaltyActive = await require('./featureService')
      .hasFeature(businessId, 'loyalty');
    if (loyaltyActive) {
      loyaltySettings = await loyalty.getSettings(businessId);
    }
  }

  // Idempotency: same client_id within the same business → return the existing order.
  if (clientId) {
    const existing = await query(
      'SELECT * FROM orders WHERE business_id = $1 AND client_id = $2 LIMIT 1',
      [businessId, clientId],
    );
    if (existing.rowCount > 0) {
      const its = await query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [existing.rows[0].id],
      );
      return serializeOrder(existing.rows[0], its.rows);
    }
  }

  return withTransaction(async (client) => {
    // P0-13 partial fix: bulk-lock all menu rows in one query at the start
    // of the txn. This both (a) avoids N+1 SELECTs for stock check, and
    // (b) acquires all row locks in a deterministic order to avoid
    // deadlocks between concurrent multi-item orders.
    const menuIds = [...new Set(items.map((i) => i.menuItemId).filter(Boolean))].sort();
    if (menuIds.length > 0) {
      await client.query(
        `SELECT id FROM menu_items
          WHERE business_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id FOR UPDATE`,
        [businessId, menuIds],
      );
    }

    // Compute totals from items (server is source of truth).
    // Modifier price deltas are folded into the line price during checkout
    // (POS sums them up so price already includes modifier deltas).
    // P0 fix (2026-08-22): aggregator orders (zomato/swiggy/other) may
    // carry unmapped items with menuItemId=null — requiring menuItemId
    // here dropped the entire webhook order over a single unmapped SKU.
    // POS/guest sources still require a mapped menu item.
    const allowUnmappedItems = ['zomato', 'swiggy', 'other'].includes(source);
    let subtotal = 0;
    for (const it of items) {
      if ((!it.menuItemId && !allowUnmappedItems) || !it.name || it.price == null || it.qty == null) {
        throw new BadRequest('Each item needs menuItemId, name, price, qty');
      }
      subtotal += Number(it.price) * Number(it.qty);
    }

    // ── Membership bundle auto-redeem (2026-08-23, founder) ─────────────
    // If the customer holds an active membership with an item bundle
    // (e.g. 20 cold coffees + 20 pizzas), covered items in THIS order are
    // discounted automatically and the bundle balance counts down.
    // Runs inside the txn with the subscription row locked.
    let membershipDiscount = 0; // INR
    let _membershipRedeem = null; // { subId, lines: [{menuItemId, qty, valueInr}] }
    if (customerPhone) {
      try {
        const custQ = await client.query(
          `SELECT id FROM customers
            WHERE business_id = $1 AND phone = $2 LIMIT 1`,
          [businessId, customerPhone],
        );
        if (custQ.rowCount > 0) {
          const subQ = await client.query(
            `SELECT ms.id, ms.remaining
               FROM membership_subscriptions ms
              WHERE ms.business_id = $1 AND ms.customer_id = $2
                AND ms.status = 'active' AND ms.expires_at > NOW()
                AND ms.remaining IS NOT NULL
              ORDER BY ms.expires_at DESC LIMIT 1
              FOR UPDATE`,
            [businessId, custQ.rows[0].id],
          );
          if (subQ.rowCount > 0) {
            const subRow = subQ.rows[0];
            const remaining = Array.isArray(subRow.remaining)
              ? subRow.remaining.map((e) => ({ ...e })) : [];
            const lines = [];
            for (const it of items) {
              if (!it.menuItemId) continue;
              const ent = remaining.find(
                (e) => e.menuItemId === it.menuItemId && Number(e.qty) > 0,
              );
              if (!ent) continue;
              const covered = Math.min(Number(it.qty), Number(ent.qty));
              if (covered <= 0) continue;
              ent.qty = Number(ent.qty) - covered;
              const valueInr = covered * Number(it.price);
              membershipDiscount += valueInr;
              lines.push({ menuItemId: it.menuItemId, qty: covered, valueInr });
            }
            if (lines.length > 0) {
              await client.query(
                `UPDATE membership_subscriptions
                    SET remaining = $1::jsonb WHERE id = $2`,
                [JSON.stringify(remaining), subRow.id],
              );
              _membershipRedeem = { subId: subRow.id, lines };
            }
          }
        }
      } catch (e) {
        // Membership tables may predate migrations 020/055 — never block
        // an order over the bundle feature.
        require('../config/logger').warn(
          `[order] membership redeem skipped: ${e?.message}`,
        );
      }
    }

    // Sprint 1 (FF-301/302/303): tenant-level defaults from platform settings
    // (cheap fetch — small table). Per-order overrides win when supplied.
    let serviceChargePctEff = serviceChargePct;
    let roundOffMode = 'nearest_rupee';
    if (serviceChargePctEff == null || roundOffEnabled == null) {
      const cfg = await client.query(
        `SELECT key, value FROM platform_settings
          WHERE key = ANY(ARRAY[
            'order.service_charge_pct',
            'order.service_charge_dine_in_only',
            'order.round_off'
          ]::text[])`,
      );
      const bag = Object.fromEntries(cfg.rows.map((r) => [r.key, r.value]));
      if (serviceChargePctEff == null) {
        const onlyDineIn = bag['order.service_charge_dine_in_only'] !== false;
        if (!onlyDineIn || source === 'dineIn') {
          serviceChargePctEff = bag['order.service_charge_pct'] || 0;
        } else {
          serviceChargePctEff = 0;
        }
      }
      roundOffMode = bag['order.round_off'] || 'nearest_rupee';
    }
    const serviceCharge = Math.max(
      0,
      Math.round((subtotal * Number(serviceChargePctEff || 0)) / 100 * 100) / 100,
    );

    // Discount math: pre-tax shrinks subtotal before tax; post-tax shrinks
    // the final total. Membership-covered items fold in as a pre-tax
    // discount (customer already paid for them via the bundle).
    const discountEff = Number(discount) + membershipDiscount;
    // null/undefined = default pre-tax (only an explicit false means
    // post-tax "instant cashback" mode).
    const preTax = discountIsPreTax !== false;
    let taxableBase = subtotal + serviceCharge;
    let total;
    if (preTax || membershipDiscount > 0) {
      taxableBase = Math.max(0, taxableBase - discountEff);
      total = Math.max(0, taxableBase + Number(tax));
    } else {
      total = Math.max(0, subtotal + serviceCharge + Number(tax) - discountEff);
    }

    // Item-level GST breakdown (FF-901). If any item carries a gst_pct, we
    // compute CGST/SGST (or IGST) per the business's state vs the customer's
    // and persist the breakdown on the order. Otherwise we leave the legacy
    // bill-level `tax` alone for back-compat.
    let gstBreakdown = null;
    let cgst = 0; let sgst = 0; let
      igst = 0;
    const itemsWithGst = items.filter((it) => it.gst_pct || it.gstPct);
    if (itemsWithGst.length > 0) {
      const normalised = items.map((it) => ({
        price: it.price, qty: it.qty, gst_pct: it.gst_pct || it.gstPct || 0,
      }));
      // For now treat all as intra-state (CGST+SGST). Inter-state would need
      // the customer's state code; default is safe & matches restaurant case.
      const r = computeGstBreakdown({ orderItems: normalised, isInterState: false });
      gstBreakdown = r.breakdown;
      cgst = r.cgst; sgst = r.sgst; igst = r.igst;
      // If body.tax was 0 and item-GST was passed, replace it
      if (!Number(tax)) tax = r.totalGst;
    }

    // FF-302 round-off (paise → INR)
    let roundOff = 0;
    if (roundOffEnabled !== false && roundOffMode !== 'none') {
      const rounded = roundOffMode === 'down'
        ? Math.floor(total)
        : Math.round(total);
      roundOff = rounded - total; // can be negative (e.g. -0.30)
      total = rounded;
    }

    // ── Loyalty: link customer and apply redemption ───────────────────────
    if (customerPhone) {
      customerRow = await customers.linkToOrder(client, {
        businessId,
        phone: customerPhone,
        name: customerName,
        orderId: null,
        orderTotal: total,
      });
    }

    let redeemedPoints = 0;
    if (loyaltyActive && loyaltySettings?.isActive && customerRow && pointsToRedeem > 0) {
      const curBal = await client.query(
        'SELECT points_balance FROM customers WHERE id = $1 FOR UPDATE',
        [customerRow.id],
      );
      const balance = curBal.rows[0].points_balance;
      const maxRedeem = loyalty.maxRedeemablePoints(balance, total * 100, loyaltySettings);
      redeemedPoints = Math.min(Number(pointsToRedeem), maxRedeem);
      if (redeemedPoints > 0) {
        loyaltyDiscountPaise = redeemedPoints * loyaltySettings.redemptionValuePaise;
        const discountInr = loyaltyDiscountPaise / 100;
        total = Math.max(0, total - discountInr);
      }
    }

    const orderNo = await nextOrderNo(client, businessId);
    // FF-501 token for takeaway: per-business per-day counter
    let tokenNo = null;
    if (source === 'takeaway') {
      // P2 fix (2026-08-22): token day rolls over at IST midnight, not UTC
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const t = await client.query(
        `INSERT INTO takeaway_counters (business_id, day, last_token)
         VALUES ($1, $2, 1)
         ON CONFLICT (business_id, day)
         DO UPDATE SET last_token = takeaway_counters.last_token + 1,
                        updated_at = NOW()
         RETURNING last_token`,
        [businessId, today],
      );
      tokenNo = t.rows[0].last_token;
    }

    let orderRow;
    try {
      const ins = await client.query(
        `INSERT INTO orders
         (business_id, order_no, source, table_no, customer_phone, customer_name,
          subtotal, tax, discount, total, payment_method, client_id,
          customer_id, points_redeemed, loyalty_discount_paise,
          table_session_id, table_id,
          service_charge_paise, round_off_paise, discount_is_pre_tax, token_no,
          cgst, sgst, igst, gst_breakdown, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [businessId, orderNo, source, tableNo, customerPhone, customerName,
          subtotal, tax, discountEff, total, paymentMethod, clientId,
          customerRow?.id || null, redeemedPoints, loyaltyDiscountPaise,
          resolvedSessionId, resolvedTableId,
          Math.round(serviceCharge * 100), Math.round(roundOff * 100),
          preTax, tokenNo,
          cgst, sgst, igst, gstBreakdown ? JSON.stringify(gstBreakdown) : null,
          channel],
      );
      orderRow = ins.rows[0];

      // Membership redemption audit rows (2026-08-23)
      if (_membershipRedeem) {
        try {
          for (const l of _membershipRedeem.lines) {
            await client.query(
              `INSERT INTO membership_redemptions
                 (business_id, subscription_id, order_id, menu_item_id, qty, value_inr)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [businessId, _membershipRedeem.subId, orderRow.id,
                l.menuItemId, l.qty, l.valueInr],
            );
          }
        } catch (_) { /* table added in 055 — non-fatal on older DBs */ }
      }

      // Record the redemption transaction inline (we're already in the txn)
      if (redeemedPoints > 0) {
        const updated = await client.query(
          `UPDATE customers
              SET points_balance = points_balance - $1,
                  lifetime_redeemed = lifetime_redeemed + $1
            WHERE id = $2 RETURNING points_balance`,
          [redeemedPoints, customerRow.id],
        );
        await client.query(
          `INSERT INTO loyalty_transactions
             (business_id, customer_id, kind, points, balance_after, order_id)
           VALUES ($1, $2, 'redeem', $3, $4, $5)`,
          [businessId, customerRow.id, -redeemedPoints,
            updated.rows[0].points_balance, orderRow.id],
        );
      }
    } catch (err) {
      // 23505 on uq_orders_client → another request beat us. The current
      // txn is now aborted, so we cannot recover inline. Let it bubble; the
      // outer `withTransaction` will ROLLBACK, then the controller-side
      // retry will hit the pre-txn lookup at the top of `create()`.
      // (Mobile clients send a stable clientId so the retry is cheap.)
      if (err.code === '23505' && clientId) {
        const { Conflict } = require('../utils/errors');
        throw new Conflict('Order with this clientId already exists; retry to fetch it');
      }
      throw err;
    }

    // items — capture optional variant + modifier choices (Sprint 1 FF-201/202)
    const itemRows = [];
    for (const it of items) {
      const ins = await client.query(
        `INSERT INTO order_items
           (order_id, menu_item_id, name, price, qty, note,
            variant_id, variant_label, modifier_lines)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [orderRow.id, it.menuItemId, it.name, it.price, it.qty, it.note || null,
          it.variantId || null, it.variantLabel || null,
          it.modifierLines ? JSON.stringify(it.modifierLines) : null],
      );
      itemRows.push(ins.rows[0]);

      // P0-4 fix: lock the row, then validate stock won't go negative BEFORE
      // we deduct. Two concurrent guest orders on the last unit used to both
      // pass and both insert; the FOR UPDATE plus the check below serialises
      // them. We only enforce on guest/dineIn paths — staff are allowed to
      // sell into a negative stock for now (will revisit when we expose
      // "allow oversell" toggle to owners).
      // Unmapped aggregator items have no menu_item_id — skip stock.
      const cur = it.menuItemId
        ? await client.query(
          `SELECT stock, name, sold_out_until FROM menu_items
            WHERE business_id = $1 AND id = $2 FOR UPDATE`,
          [businessId, it.menuItemId],
        )
        : { rowCount: 0, rows: [] };
      if (cur.rowCount > 0) {
        // 86'd enforcement (2026-08-23): sold-out items can't be ordered
        // from staff POS / guest QR. Aggregator orders pass through —
        // they were accepted on the platform already; the availability
        // fanout keeps those menus in sync separately.
        if (!allowUnmappedItems
            && cur.rows[0].sold_out_until
            && new Date(cur.rows[0].sold_out_until) > new Date()) {
          throw new BadRequest(`${cur.rows[0].name} is sold out`);
        }
        const before = parseFloat(cur.rows[0].stock);
        const after = before - Number(it.qty);
        if (source === 'dineIn' && before > 0 && after < 0) {
          // Soft-reject only when stock had been tracked (>0). Items with
          // stock=0 are assumed "not tracked".
          throw new BadRequest(
            `${cur.rows[0].name} only has ${before} left, ${it.qty} requested`,
          );
        }
        await client.query(
          'UPDATE menu_items SET stock = $1 WHERE id = $2',
          [after, it.menuItemId],
        );
        await client.query(
          `INSERT INTO inventory_transactions
           (business_id, menu_item_id, qty_change, balance_after, reason, order_id)
           VALUES ($1, $2, $3, $4, 'sale', $5)`,
          [businessId, it.menuItemId, -Number(it.qty), after, orderRow.id],
        );
      }
    }

    // ── KOT routing: generate one ticket per station ──────────────────────
    try {
      const itemsForKot = itemRows.map((it) => {
        const src = items.find((i) => i.menuItemId === it.menu_item_id);
        return {
          orderItemId: it.id,
          menuItemId: it.menu_item_id,
          name: it.name,
          qty: parseFloat(it.qty),
          note: it.note,
        };
      });
      await kot.generateTickets(client, {
        businessId, orderId: orderRow.id, orderItems: itemsForKot,
      });
    } catch (_) { /* KOT generation is best-effort; never block order creation */ }

    // ── Recipe-based ingredient deduction (gated by 'recipe-costing' addon) ─
    try {
      const hasRecipes = await addons.hasAddon(businessId, 'recipe-costing');
      if (hasRecipes) {
        const itemsForRecipe = itemRows.map((it) => ({
          orderItemId: it.id,
          menuItemId: it.menu_item_id,
          qty: parseFloat(it.qty),
        }));
        await recipes.deductForOrder(client, {
          businessId, orderId: orderRow.id, orderItems: itemsForRecipe,
        });
      }
    } catch (_) { /* never block order creation on a recipe miss */ }

    // ── Bar / liquor FIFO deduction (FF-902) ─────────────────────────────
    // For lines whose menu_item has `is_liquor = TRUE`, walk the matching
    // liquor_batches in FIFO order and subtract `pour_ml * qty`. Required
    // for excise reporting in licensed restaurants.
    try {
      const bar = require('./barFifoService');
      const liquorMeta = await client.query(
        `SELECT id, is_liquor, pour_ml FROM menu_items
          WHERE business_id = $1
            AND id = ANY($2::uuid[])
            AND is_liquor = TRUE`,
        [businessId, itemRows.map((r) => r.menu_item_id)],
      );
      const byId = new Map(liquorMeta.rows.map((r) => [r.id, r]));
      const liquorLines = itemRows
        .filter((it) => byId.has(it.menu_item_id))
        .map((it) => ({
          menuItemId: it.menu_item_id,
          qty: parseFloat(it.qty),
          isLiquor: true,
          pourMl: byId.get(it.menu_item_id).pour_ml,
        }));
      if (liquorLines.length > 0) {
        await bar.deductForOrder(client, businessId, liquorLines);
      }
    } catch (_) { /* bar deduction is non-blocking */ }

    // FF-903 — attribute server + tip. Done as UPDATE so we don't have
    // to touch the (already gnarly) 25-column INSERT above. Server
    // must belong to this business; enforced by requireBusinessOwnership
    // on the route, but we sanity-check with the WHERE.
    if (serverUserId || (tipInr && tipInr > 0)) {
      // P2 fix (2026-08-22): verify the attributed server actually
      // belongs to this business — the route only authenticates the
      // caller, not the payload.
      let serverIdEff = serverUserId || null;
      if (serverIdEff) {
        const member = await client.query(
          `SELECT 1 FROM business_users
            WHERE business_id = $1 AND user_id = $2 AND is_active = TRUE`,
          [businessId, serverIdEff],
        );
        if (member.rowCount === 0) serverIdEff = null; // ignore bogus attribution
      }
      await client.query(
        `UPDATE orders
            SET server_user_id = COALESCE($1, server_user_id),
                tip_paise = $2
          WHERE id = $3`,
        [serverIdEff, Math.round((tipInr || 0) * 100), orderRow.id],
      );
      orderRow.server_user_id = serverIdEff;
      orderRow.tip_paise = Math.round((tipInr || 0) * 100);
    }

    // FF-1005 — wallet / gift-card redemption. Recorded BEFORE splits
    // so the remaining amount is what gets split-tendered.
    if (walletRedeem && (walletRedeem.giftCardCode || walletRedeem.customerId)
        && walletRedeem.amountInr > 0) {
      const gc = require('./giftCardService');
      // Delegating; giftCardService owns its own txn. Because we're
      // inside a txn here, we defer this to the .then() below.
      orderRow._pendingRedeem = walletRedeem;
    }

    // FF-312 — split-tender. Insert one `payments` row per leg. The
    // primary method already lives in orders.payment_method; here we
    // just persist the breakdown + flag the order.
    if (Array.isArray(splits) && splits.length > 1) {
      let sum = 0;
      for (const s of splits) {
        const amt = Math.round((s.amountInr || 0) * 100);
        if (amt <= 0) continue;
        sum += amt;
        await client.query(
          `INSERT INTO payments (business_id, order_id, method, amount_paise, status)
           VALUES ($1, $2, $3, $4, 'captured')`,
          [businessId, orderRow.id, s.method, amt],
        );
      }
      // Sanity: split total shouldn't exceed order total. Warn but
      // don't block — real cafes overpay/round to nearest rupee.
      const orderPaise = Math.round(total * 100);
      if (Math.abs(sum - orderPaise) > 100) {
        require('../config/logger').warn(
          `[order ${orderRow.id}] split total ${sum} vs order ${orderPaise} — mismatch > ₹1`,
        );
      }
      await client.query(
        'UPDATE orders SET is_split_tender = TRUE WHERE id = $1',
        [orderRow.id],
      );
      orderRow.is_split_tender = true;
    }

    // P1 fix (2026-08-22): _pendingRedeem was set on the raw DB row but
    // serializeOrder returns a fresh object — the flag was lost and the
    // gift card / wallet was never debited. Carry it through explicitly.
    const out = serializeOrder(orderRow, itemRows);
    if (orderRow._pendingRedeem) out._pendingRedeem = orderRow._pendingRedeem;
    return out;
  }).then(async (result) => {
    // Bump usage AFTER the txn commits (best-effort, doesn't roll back the order)
    // Bug fix (B20): log the failure so plan-cap enforcement drift is
    // visible to support. Still non-blocking — the order itself is
    // committed by this point.
    try { await sub.incrementUsage(businessId, 'monthly_orders'); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[orderService] incrementUsage failed biz=${businessId}: ${e?.message}`);
    }
    // FF-1005 post-commit redemption. Failure here doesn't roll back
    // the order — the customer's food is already going out. We log
    // and surface the error to the caller via `result._redeemError`
    // so the POS can retry.
    if (result?._pendingRedeem || result?.pendingRedeem) {
      try {
        const gc = require('./giftCardService');
        const wr = result._pendingRedeem || result.pendingRedeem;
        result.redeem = await gc.redeem(businessId, {
          giftCardCode: wr.giftCardCode,
          customerId: wr.customerId,
          orderId: result.id,
          amountInr: wr.amountInr,
        });
      } catch (e) {
        require('../config/logger').warn(
          `[order ${result.id}] redemption failed: ${e.message}`,
        );
        result._redeemError = e.message;
      }
      delete result._pendingRedeem;
    }
    return result;
  });
}

/**
 * Collapse orders sharing a `tableSessionId` into one "bill" row.
 *
 * Output shape mostly matches a regular order so the existing
 * front-end card components don't have to fork, with these
 * additions:
 *   - isBill        : true (marker so the UI knows this is a session)
 *   - displayNo     : smallest order_no in the session — what the
 *                     customer sees on the receipt and in the app
 *   - kots          : [{ orderNo, total, status, createdAt }, ...]
 *                     so the kitchen + Captain views can still drill
 *                     into individual tickets (5.1, 5.2, …)
 *
 * For session rows, we also:
 *   - sum subtotal / tax / discount / total across non-cancelled KOTs
 *   - merge `items` line by line so "2× Chai KOT1 + 1× Chai KOT2"
 *     prints as "3× Chai"
 *   - elevate paymentMethod to whichever non-unpaid one shows up;
 *     stay 'unpaid' if all KOTs are still unpaid
 *   - status = 'pending' if any KOT pending → 'ready' if any ready →
 *               'collected' if all collected (cancelled ignored)
 *
 * Orders without a `tableSessionId` (takeaway, QR ordering, aggregator)
 * pass through untouched.
 */
function collapseBySession(orders) {
  const out = [];
  const bySession = new Map();
  for (const o of orders) {
    const sid = o.tableSessionId;
    if (!sid) { out.push(o); continue; }
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(o);
  }
  // Status priority: pending > ready > collected > cancelled
  const statusRank = { pending: 0, ready: 1, collected: 2, cancelled: 3 };
  for (const [sid, kots] of bySession.entries()) {
    // Sort so the smallest order_no wins as displayNo
    kots.sort((a, b) => (a.orderNo || 0) - (b.orderNo || 0));
    const live = kots.filter((k) => k.status !== 'cancelled');
    const itemMap = new Map();
    let subtotal = 0; let tax = 0; let discount = 0; let
      total = 0;
    let pm = 'unpaid';
    let st = 'collected';
    for (const k of live) {
      subtotal += k.subtotal || 0;
      tax += k.tax || 0;
      discount += k.discount || 0;
      total += k.total || 0;
      if (pm === 'unpaid' && k.paymentMethod && k.paymentMethod !== 'unpaid') {
        pm = k.paymentMethod;
      }
      if (statusRank[k.status] !== undefined
          && statusRank[k.status] < statusRank[st]) {
        st = k.status;
      }
      for (const it of (k.items || [])) {
        const key = `${it.menuItemId || it.name}|${it.price}|${it.variantLabel || ''}`;
        const existing = itemMap.get(key);
        if (existing) {
          existing.qty += it.qty;
        } else {
          itemMap.set(key, { ...it, qty: it.qty });
        }
      }
    }
    const head = live[0] || kots[0];
    out.push({
      ...head,
      isBill: true,
      // The customer-facing "Order #" — pinned to the first KOT in the
      // session. KOTs created later (5.1, 5.2 …) don't change it.
      displayNo: head.orderNo,
      items: Array.from(itemMap.values()),
      subtotal,
      tax,
      discount,
      total,
      paymentMethod: pm,
      status: st,
      kots: kots.map((k, i) => ({
        id: k.id,
        orderNo: k.orderNo,
        // Display label like 5.1 / 5.2. The first KOT in the session
        // gets the bare number (5); subsequent ones get the dot suffix.
        // Lets cashiers + kitchen reconcile a refund without losing
        // the "this is the second KOT under bill #5" context.
        label: i === 0 ? `${head.orderNo}` : `${head.orderNo}.${i}`,
        total: k.total,
        status: k.status,
        paymentMethod: k.paymentMethod,
        createdAt: k.createdAt,
        itemCount: (k.items || []).length,
      })),
    });
  }
  // Keep the original time ordering (most recent first)
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out;
}

async function list(businessId, { date, status, source, channel, groupBy, limit = 100, offset = 0 } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId];
  let idx = 2;
  if (status) { where.push(`status = $${idx++}`); values.push(status); }
  if (date) {
    where.push(`created_at::date = $${idx++}::date`);
    values.push(date);
  }
  // Filter by exact source (dineIn / takeaway / zomato / swiggy / other),
  // or by channel = 'online' (zomato + swiggy) / 'offline' (dineIn + takeaway).
  if (source) { where.push(`source = $${idx++}`); values.push(source); }
  // Bug fix (B32): 'online' used to miss `other` (guest QR + Dunzo/
  // Magicpin — all of them enum-map to 'other' since 'qr','dunzo',
  // 'magicpin' aren't in order_source). The Overview donut and
  // channel tiles now include those buckets.
  if (channel === 'online') {
    where.push('source IN (\'zomato\',\'swiggy\',\'other\')');
  } else if (channel === 'offline') {
    where.push('source IN (\'dineIn\',\'takeaway\')');
  }
  const r = await query(
    `SELECT * FROM orders WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset],
  );
  if (r.rowCount === 0) return [];
  const ids = r.rows.map((o) => o.id);
  const its = await query(
    'SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])',
    [ids],
  );
  const byOrder = new Map();
  for (const it of its.rows) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push(it);
  }
  const serialized = r.rows.map((o) => serializeOrder(o, byOrder.get(o.id) || []));
  if (groupBy === 'session') {
    return collapseBySession(serialized);
  }
  return serialized;
}

async function byId(businessId, orderId) {
  const r = await query(
    'SELECT * FROM orders WHERE business_id = $1 AND id = $2 LIMIT 1',
    [businessId, orderId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found');
  const its = await query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
  const out = serializeOrder(r.rows[0], its.rows);
  // 2026-08-23 (founder): the order detail must show what was refunded.
  try {
    const ref = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS paise
         FROM refunds
        WHERE business_id = $1 AND order_id = $2
          AND status IN ('pending', 'processed')`,
      [businessId, orderId],
    );
    out.refundedInr = Number(ref.rows[0]?.paise || 0) / 100;
  } catch (_) { out.refundedInr = 0; }
  return out;
}

// P1 fix (2026-08-22): order status was accepted as a bare string —
// `collected → pending`, `cancelled → ready` all passed, re-awarding
// loyalty on the next collected write. Formal transition matrix now
// rejects impossible moves at the service edge.
const ORDER_TRANSITIONS = {
  pending: ['ready', 'collected', 'cancelled'], // fast-collect skips ready
  ready: ['collected', 'cancelled'],
  collected: ['cancelled'], // only cancel-with-refund
  cancelled: [], // terminal
};

async function updateStatus(businessId, orderId, status, reason = null, reasonCode = null) {
  const allowed = ['pending', 'ready', 'collected', 'cancelled'];
  if (!allowed.includes(status)) throw new BadRequest(`Invalid status: ${status}`);
  // FF-503: when cancelling, require + validate the reason code
  if (status === 'cancelled') {
    if (!reasonCode) throw new BadRequest('cancel_reason_code is required to cancel');
    const cancelReasons = require('./cancelReasonService');
    const ok = await cancelReasons.validateCode(businessId, reasonCode);
    if (!ok) throw new BadRequest(`Unknown cancel_reason_code: ${reasonCode}`);
  }

  // P1 fix (Arvind #1): if we're cancelling a previously-collected order, we
  // need to reverse the loyalty earn so the refund leaves the customer's
  // balance where it started. We capture the prior state in the same query.
  const prior = await query(
    `SELECT status, customer_id, points_earned, points_redeemed
       FROM orders WHERE business_id = $1 AND id = $2`,
    [businessId, orderId],
  );
  if (prior.rowCount === 0) throw new NotFound('Order not found');
  // P1 fix (2026-08-22): enforce transition matrix.
  const currentStatus = prior.rows[0].status;
  // Idempotent no-op (2026-08-23): re-sending the current status returns
  // the order unchanged — bulk bill updates from older app builds could
  // include already-transitioned KOTs.
  if (currentStatus === status) {
    return byId(businessId, orderId);
  }
  const validNext = ORDER_TRANSITIONS[currentStatus] || [];
  if (!validNext.includes(status)) {
    throw new BadRequest(
      `Cannot move order from ${currentStatus} to ${status}. `
      + `Allowed next states: ${validNext.join(', ') || '(terminal)'}.`,
    );
  }
  const wasCollected = prior.rows[0].status === 'collected';
  const cancelling = status === 'cancelled' && wasCollected;

  const patch = ['status = $1'];
  const values = [status];
  if (status === 'ready') patch.push('ready_at = NOW()');
  if (status === 'collected') patch.push('collected_at = NOW()');
  if (reason) { patch.push(`cancel_reason = $${values.length + 1}`); values.push(reason); }
  if (reasonCode) { patch.push(`cancel_reason_code = $${values.length + 1}`); values.push(reasonCode); }
  const r = await query(
    `UPDATE orders SET ${patch.join(', ')}
     WHERE business_id = $${values.length + 1} AND id = $${values.length + 2}
     RETURNING *`,
    [...values, businessId, orderId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found');

  // Push 13.3 reverse-sync: when the cashier moves an order forward in
  // the Orders tab, drag the KOT tickets along so the kitchen doesn't
  // keep showing a ticket the cashier already marked ready.
  if (status === 'ready' || status === 'collected') {
    await query(
      `UPDATE kot_tickets SET status = 'done', completed_at = COALESCE(completed_at, NOW())
        WHERE order_id = $1 AND status NOT IN ('done','cancelled')`,
      [orderId],
    );
  } else if (status === 'cancelled') {
    await query(
      `UPDATE kot_tickets SET status = 'cancelled'
        WHERE order_id = $1 AND status NOT IN ('done','cancelled')`,
      [orderId],
    );
    // H6 fix (2026-08-23, review): cancelling never restored inventory
    // or membership-bundle entitlements — stock leaked on every cancel.
    // Both are best-effort (a failure never blocks the cancel).
    try {
      // (a) Return stock deducted at create for each line item.
      const its = await query(
        `SELECT menu_item_id, qty FROM order_items
          WHERE order_id = $1 AND menu_item_id IS NOT NULL`,
        [orderId],
      );
      for (const it of its.rows) {
        const upd = await query(
          `UPDATE menu_items SET stock = stock + $1
            WHERE business_id = $2 AND id = $3
            RETURNING stock`,
          [it.qty, businessId, it.menu_item_id],
        );
        if (upd.rowCount > 0) {
          await query(
            `INSERT INTO inventory_transactions
               (business_id, menu_item_id, qty_change, balance_after, reason, order_id)
             VALUES ($1, $2, $3, $4, 'returned', $5)`,
            [businessId, it.menu_item_id, it.qty,
              upd.rows[0].stock, orderId],
          );
        }
      }
      // (b) Return consumed membership-bundle entitlements (audit rows
      // written at create, migration 055).
      const redemptions = await query(
        `SELECT subscription_id, menu_item_id, qty
           FROM membership_redemptions
          WHERE business_id = $1 AND order_id = $2`,
        [businessId, orderId],
      );
      for (const rd of redemptions.rows) {
        await query(
          `UPDATE membership_subscriptions
              SET remaining = (
                SELECT jsonb_agg(
                  CASE WHEN elem->>'menuItemId' = $1
                       THEN jsonb_set(elem, '{qty}',
                            to_jsonb((elem->>'qty')::numeric + $2::numeric))
                       ELSE elem END)
                  FROM jsonb_array_elements(remaining) elem)
            WHERE id = $3 AND remaining IS NOT NULL`,
          [rd.menu_item_id, rd.qty, rd.subscription_id],
        );
      }
      if (redemptions.rowCount > 0) {
        await query(
          `DELETE FROM membership_redemptions
            WHERE business_id = $1 AND order_id = $2`,
          [businessId, orderId],
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[orderService] cancel restore failed for ${orderId}: ${e?.message}`);
    }
  }

  // P1: reverse loyalty earn + restore redeemed points on a collected→cancelled
  // transition. Best-effort — if loyalty is mis-configured we still cancel.
  if (cancelling && prior.rows[0].customer_id) {
    const reverseEarn = prior.rows[0].points_earned || 0;
    const restoreRedeem = prior.rows[0].points_redeemed || 0;
    try {
      if (reverseEarn > 0 || restoreRedeem > 0) {
        await query(
          `UPDATE customers
              SET points_balance    = points_balance - $1 + $2,
                  lifetime_points   = GREATEST(0, lifetime_points - $1),
                  lifetime_redeemed = GREATEST(0, lifetime_redeemed - $2)
            WHERE id = $3 AND business_id = $4`,
          [reverseEarn, restoreRedeem, prior.rows[0].customer_id, businessId],
        );
        await query(
          `INSERT INTO loyalty_transactions
             (business_id, customer_id, kind, points, balance_after, order_id, note)
           SELECT $1, customer_id, 'reverse', $2 - $3,
                  points_balance, $4, 'Cancel/refund reversal'
             FROM customers WHERE id = $5`,
          [businessId, restoreRedeem, reverseEarn, orderId, prior.rows[0].customer_id],
        );
      }
    } catch (e) {
      // Bug fix (B21): don't fully swallow — loyalty desync is
      // unrecoverable without an audit trail. Log so support can spot
      // + reconcile.
      // eslint-disable-next-line no-console
      console.warn(`[orderService] loyalty reversal failed for order ${orderId}: ${e?.message}`);
    }
  }

  // ── Loyalty: award points on collection ─────────────────────────────
  if (status === 'collected') {
    const o = r.rows[0];
    if (o.customer_id && o.points_earned === 0) {
      try {
        // Fix (2026-08-22): plan feature, not paid addon (see create()).
        const loyaltyActive = await require('./featureService')
          .hasFeature(businessId, 'loyalty');
        if (loyaltyActive) {
          const settings = await loyalty.getSettings(businessId);
          if (settings.isActive) {
            const points = await loyalty.earn({
              businessId,
              customerId: o.customer_id,
              orderId: o.id,
              amountPaise: Math.round(parseFloat(o.total) * 100),
              settings,
            });
            if (points > 0) {
              await query(
                'UPDATE orders SET points_earned = $1 WHERE id = $2',
                [points, o.id],
              );
            }
          }
        }
      } catch (e) {
        // Never fail the order update over loyalty — but log LOUDLY.
        // (A silent catch here hid the ON CONFLICT bug that kept every
        // customer at 0 points until 2026-08-23.)
        // eslint-disable-next-line no-console
        console.warn(`[orderService] loyalty earn failed for order ${orderId}: ${e?.message}`);
      }
    }
  }

  // Push 15c — auto-issue a tax invoice when the order is collected. The
  // service is idempotent (re-calling for the same order returns the
  // existing invoice), so this is safe to call here without worrying
  // about race conditions. Wrapped in try/catch so a tax-invoice issue
  // failure (e.g. missing GSTIN on the business) doesn't roll back the
  // order state change.
  if (status === 'collected') {
    try {
      // Bug #5 fix (2026-08-25): orders that belong to a table session
      // must NOT get their own per-KOT invoice — the customer receives
      // ONE combined invoice for the whole session, issued when the
      // table is settled (tableService.closeSession →
      // taxInvoiceService.issueFromSession). Standalone orders
      // (takeaway/QR/delivery) keep the instant per-order invoice.
      const sess = await query(
        'SELECT table_session_id FROM orders WHERE id = $1', [orderId]);
      if (!sess.rows[0]?.table_session_id) {
        await require('./taxInvoiceService').issueFromOrder(businessId, orderId);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[orderService] auto-issue tax invoice failed:', e?.message);
    }
  }

  // Push 16h — auto-send WhatsApp on status change, gated by the
  // `auto_whatsapp_order` feature flag. Outbound rows go into
  // wa_messages with direction='out' — any provider integration
  // (Twilio / Gupshup / WATI) drains them. We don't fail the order
  // update if the WhatsApp queue write errors out.
  if (['pending', 'ready', 'collected', 'cancelled'].includes(status)) {
    try {
      await _queueOrderWhatsApp(businessId, orderId, status);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[orderService] queue WhatsApp failed:', e?.message);
    }
  }

  return byId(businessId, orderId);
}

// Push 16h — outbound WhatsApp queue helper.
//
// Inserts a wa_messages row with direction='out' for the customer's
// phone, gated by:
//   1. The business has `auto_whatsapp_order` in its plan_features.
//   2. The order has a customer_phone.
// Uses the wa_threads table from migration 022 (already in place) to
// thread the conversation. No external HTTP — just enqueues; a worker
// process reads `wa_messages WHERE direction='out' AND provider_msg_id IS NULL`
// and ships to whichever provider the business configured.
async function _queueOrderWhatsApp(businessId, orderId, status) {
  const features = require('./featureService');
  const enabled = await features.hasFeature(businessId, 'auto_whatsapp_order');
  if (!enabled) return;

  const o = await query(
    `SELECT o.id, o.order_no, o.total, o.customer_phone, o.customer_name,
            o.payment_method, o.service_mode, o.channel, o.table_id,
            t.service_mode      AS table_mode,
            b.default_service_mode AS biz_default_mode,
            b.name              AS biz_name
       FROM orders o
       LEFT JOIN tables     t ON t.id = o.table_id
       JOIN businesses b ON b.id = o.business_id
      WHERE o.business_id = $1 AND o.id = $2`,
    [businessId, orderId],
  );
  if (o.rowCount === 0) return;
  const order = o.rows[0];
  if (!order.customer_phone) return; // can't WhatsApp without a number

  // FF-252 — resolve the effective service mode: order override → table
  // setting → business default. Aggregator channels are always delivery
  // (their platform handles customer comms, so we skip anyway).
  const mode = resolveServiceMode(order);

  // For dine-in orders the guest is sitting at the table — a "ready to
  // collect" ping is confusing AND spammy (the waiter is bringing it).
  // Skip the ready WA entirely; the KDS/captain gets the alert instead.
  if (status === 'ready' && mode === 'dine_in') return;
  // Aggregator delivery orders: the platform (Zomato/Swiggy) messages
  // the eater; suppressing our own duplicate keeps things clean.
  if (mode === 'delivery') return;

  // Compose the message body based on status + mode.
  const bizName = order.biz_name || 'us';
  const name = order.customer_name || 'friend';
  const msg = (() => {
    switch (status) {
      case 'pending':
        return mode === 'dine_in'
          ? `Hi ${name}! ${bizName} received your order #${order.order_no}. Our team is preparing it now.`
          : `Hi ${name}! ${bizName} received your order #${order.order_no}. We'll let you know when it's ready.`;
      case 'ready':
        // Only reached in self_pickup / takeaway modes (dine_in returned
        // above). Copy makes the collection point explicit.
        return `Hi ${name}! Your order #${order.order_no} from ${bizName} is ready — please collect it at the counter.`;
      case 'collected': {
        // On collect we also link the tax invoice if it exists.
        return `Hi ${name}! Thanks for ordering from ${bizName}. Your bill #${order.order_no} (₹${parseFloat(order.total).toFixed(2)}) is settled — a GST invoice has been generated. Have a great day!`;
      }
      case 'cancelled':
        return `Hi ${name}, your order #${order.order_no} from ${bizName} was cancelled. If this was a mistake please reach out.`;
      default:
        return null;
    }
  })();
  if (!msg) return;

  // Thread upsert
  const t = await query(
    `INSERT INTO wa_threads (business_id, customer_phone, customer_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, customer_phone)
       DO UPDATE SET customer_name = COALESCE(wa_threads.customer_name, EXCLUDED.customer_name),
                     last_message_at = NOW()
     RETURNING id`,
    [businessId, order.customer_phone, order.customer_name],
  );
  const threadId = t.rows[0].id;

  // Enqueue outbound
  await query(
    `INSERT INTO wa_messages (business_id, thread_id, direction, body)
     VALUES ($1, $2, 'out', $3)`,
    [businessId, threadId, msg],
  );
}

async function markPrinted(businessId, orderId) {
  const r = await query(
    `UPDATE orders SET printed = TRUE
     WHERE business_id = $1 AND id = $2 RETURNING *`,
    [businessId, orderId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found');
  return byId(businessId, orderId);
}

// FF-252 — resolve the effective service mode for an order row that
// was JOINed against tables + businesses. Order value wins (captain
// override), then the table's own mode, then the business default.
// `hybrid` at the business level means "let each table decide", so if
// the table also has no mode we fall back to `dine_in` — the safer
// default (won't ping a sitting customer with "come collect").
function resolveServiceMode(row) {
  if (row.channel && ['zomato', 'swiggy', 'dunzo', 'aggregator'].includes(row.channel)) {
    return 'delivery';
  }
  if (row.service_mode) return row.service_mode;
  if (row.table_mode) return row.table_mode;
  if (row.biz_default_mode === 'self_pickup') return 'self_pickup';
  if (row.biz_default_mode === 'dine_in') return 'dine_in';
  return 'dine_in'; // hybrid + no table hint → assume table service
}

module.exports = {
  create,
  list,
  byId,
  updateStatus,
  markPrinted,
  markReprint,
  serializeOrder,
  resolveServiceMode,
  ORDER_TRANSITIONS,
};
