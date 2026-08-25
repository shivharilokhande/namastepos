// NamastePOS backend - floors, tables, sessions

const { query, withTransaction } = require('../config/db');
const { NotFound, Conflict, BadRequest } = require('../utils/errors');

// Joined-tables endpoints take a tableId from the request body and feed it
// into ANY($..) / array operators — reject junk up-front with a 400 instead
// of letting Postgres throw a 22P02 (which surfaces as a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(v, label) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw new BadRequest(`${label} must be a valid id`);
  }
}

function serializeFloor(f) {
  return { id: f.id, name: f.name, displayOrder: f.display_order, createdAt: f.created_at };
}
function serializeTable(t) {
  return {
    id: t.id, floorId: t.floor_id, label: t.label, seats: t.seats,
    shape: t.shape, xPos: t.x_pos, yPos: t.y_pos, status: t.status,
    currentSessionId: t.current_session_id,
    floorName: t.floor_name,
    sessionOpenedAt: t.session_opened_at,
    sessionGuestCount: t.session_guest_count,
    sessionTotalInr: t.session_total_paise ? t.session_total_paise / 100 : null,
    // Push 15i — surface QR fields so the dashboard's QR page can show
    // an accurate "QR disabled" badge. Default true so legacy rows without
    // the column also work; if migration 007 ran, qr_enabled is NOT NULL.
    qrEnabled: t.qr_enabled === undefined ? true : t.qr_enabled !== false,
    hasQrToken: !!t.qr_token,
    // FF-252 — null means "inherit from business default". Dashboard
    // shows this as "Auto" so owners understand the fallback.
    serviceMode: t.service_mode || null,
    // Joined tables (2026-08-25): a SECONDARY member of a joined group has
    // current_session_id pointing at a session whose primary table_id is a
    // DIFFERENT table. The dashboard uses this to draw the link icon; the
    // shared session still resolves through currentSessionId like any
    // occupied table, so "tap any joined table → same running bill" needs
    // no extra lookup.
    isJoinedSecondary: !!(
      t.current_session_id &&
      t.session_primary_table_id &&
      t.session_primary_table_id !== t.id
    ),
    // On the PRIMARY table this lists the extra tables in the group (so it
    // gets the link icon too); [] everywhere else.
    sessionJoinedTableIds: t.session_joined_table_ids || [],
  };
}
function serializeSession(s, orders = [], itemsByOrder = new Map(), joinedTables = []) {
  // Aggregated running bill — every dish the table has consumed across all
  // KOTs, line by line. This is what powers the "click table → see what
  // they ate so far" view.
  const allItems = [];
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const items = itemsByOrder.get(o.id) || [];
    for (const it of items) {
      allItems.push({
        id: it.id,
        orderId: o.id,
        orderNo: o.order_no,
        menuItemId: it.menu_item_id,
        name: it.name,
        qty: parseFloat(it.qty),
        price: parseFloat(it.price),
        lineTotal: parseFloat(it.price) * parseFloat(it.qty),
        note: it.note,
        kotAt: o.created_at,
      });
    }
  }
  // Subtotals across non-cancelled orders so the dialog can render a
  // realistic bill (subtotal + tax + discount + total).
  const subtotal = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + parseFloat(o.subtotal || 0), 0);
  const tax = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + parseFloat(o.tax || 0), 0);
  const discount = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + parseFloat(o.discount || 0), 0);
  const liveTotal = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

  return {
    id: s.id, businessId: s.business_id, tableId: s.table_id,
    tableLabel: s.table_label,
    guestCount: s.guest_count, customerPhone: s.customer_phone,
    customerName: s.customer_name, customerId: s.customer_id,
    status: s.status, openedAt: s.opened_at, closedAt: s.closed_at,
    notes: s.notes,
    // Joined tables (2026-08-25) — extra physical tables sharing this
    // session's bill. Ids come off the row; labels are resolved by
    // sessionDetail so the dialog can render "T2, T3" without a 2nd call.
    joinedTableIds: s.joined_table_ids || [],
    joinedTables,
    // Use the live SUM(orders.total) so newly-saved KOTs show up
    // immediately — total_paise is only refreshed on session close.
    totalInr: s.status === 'closed' ? (s.total_paise || 0) / 100 : liveTotal,
    subtotalInr: subtotal,
    taxInr: tax,
    discountInr: discount,
    // Per-KOT summary (kept so the timeline view still works)
    orders: orders.map((o) => ({
      id: o.id, orderNo: o.order_no,
      total: parseFloat(o.total),
      status: o.status,
      paymentMethod: o.payment_method,
      createdAt: o.created_at,
      itemCount: (itemsByOrder.get(o.id) || []).length,
    })),
    // Flattened item list — what the customer has eaten so far.
    items: allItems,
  };
}

// ── Floors ─────────────────────────────────────────────────────────────
async function listFloors(businessId) {
  const r = await query(
    `SELECT * FROM floors WHERE business_id = $1 ORDER BY display_order, name`,
    [businessId]
  );
  return r.rows.map(serializeFloor);
}

async function createFloor(businessId, body) {
  if (!body.name) throw new BadRequest('Floor name required');
  try {
    const r = await query(
      `INSERT INTO floors (business_id, name, display_order)
       VALUES ($1, $2, $3) RETURNING *`,
      [businessId, body.name, body.display_order || 100]
    );
    return serializeFloor(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Floor name already exists');
    throw err;
  }
}

async function updateFloor(businessId, id, patch) {
  const sets = []; const values = []; let idx = 1;
  if (patch.name)          { sets.push(`name = $${idx++}`); values.push(patch.name); }
  if (patch.display_order !== undefined) { sets.push(`display_order = $${idx++}`); values.push(patch.display_order); }
  if (sets.length === 0) return null;
  values.push(businessId, id);
  const r = await query(
    `UPDATE floors SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Floor not found');
  return serializeFloor(r.rows[0]);
}

async function deleteFloor(businessId, id) {
  const r = await query(
    `DELETE FROM floors WHERE business_id = $1 AND id = $2 RETURNING id`,
    [businessId, id]
  );
  if (r.rowCount === 0) throw new NotFound('Floor not found');
  return { id: r.rows[0].id };
}

// ── Tables ─────────────────────────────────────────────────────────────
async function listTables(businessId, { floorId } = {}) {
  const where = ['t.business_id = $1']; const values = [businessId]; let idx = 2;
  if (floorId) { where.push(`t.floor_id = $${idx++}`); values.push(floorId); }

  const r = await query(
    `SELECT t.*, f.name AS floor_name,
            s.opened_at AS session_opened_at,
            s.guest_count AS session_guest_count,
            s.total_paise AS session_total_paise,
            s.table_id AS session_primary_table_id,
            s.joined_table_ids AS session_joined_table_ids
       FROM tables t
       JOIN floors f ON f.id = t.floor_id
  LEFT JOIN table_sessions s
         ON s.id = t.current_session_id AND s.status = 'open'
      WHERE ${where.join(' AND ')}
      ORDER BY f.display_order, t.label`,
    values
  );
  return r.rows.map(serializeTable);
}

async function createTable(businessId, body) {
  if (!body.floorId || !body.label) throw new BadRequest('floorId and label required');
  try {
    const r = await query(
      `INSERT INTO tables (business_id, floor_id, label, seats, shape, x_pos, y_pos, service_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [businessId, body.floorId, body.label, body.seats || 4,
       body.shape || 'square', body.xPos || 0, body.yPos || 0,
       body.serviceMode || null]
    );
    return serializeTable(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Table label already exists on this floor');
    throw err;
  }
}

async function updateTable(businessId, id, patch) {
  // Map both camelCase (from the new layout-editor + dashboard) and
  // snake_case (legacy / direct DB-shape callers) to the underlying
  // column names. This is what un-broke the drag-to-arrange flow —
  // the dashboard sends { xPos, yPos } and Joi strict mode was 400'ing
  // because the schema only knew about x_pos/y_pos.
  const colMap = {
    label: 'label',
    seats: 'seats',
    shape: 'shape',
    status: 'status',
    xPos: 'x_pos',
    yPos: 'y_pos',
    floorId: 'floor_id',
    x_pos: 'x_pos',
    y_pos: 'y_pos',
    floor_id: 'floor_id',
    serviceMode: 'service_mode',    // FF-252 — null = inherit business
    service_mode: 'service_mode',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(colMap)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = $${idx++}`);
      values.push(patch[k]);
    }
  }
  if (sets.length === 0) return null;
  values.push(businessId, id);
  const r = await query(
    `UPDATE tables SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Table not found');
  return serializeTable(r.rows[0]);
}

async function deleteTable(businessId, id) {
  const r = await query(
    `DELETE FROM tables WHERE business_id = $1 AND id = $2 RETURNING id`,
    [businessId, id]
  );
  if (r.rowCount === 0) throw new NotFound('Table not found');
  return { id: r.rows[0].id };
}

// ── Sessions ───────────────────────────────────────────────────────────
async function openSession(businessId, tableId, body, openedByUserId) {
  return withTransaction(async (client) => {
    // SECURITY (2026-08-25, review finding #2 — tenant isolation):
    // tableId comes straight from the URL; without this ownership check
    // a known table UUID from ANOTHER tenant could be hijacked — the
    // INSERT below happily wrote our business_id next to a foreign
    // table_id. Verify + lock the table first (FOR UPDATE mirrors
    // joinTable so concurrent open/join on the same table serialise).
    const own = await client.query(
      `SELECT id FROM tables
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [businessId, tableId]
    );
    if (own.rowCount === 0) throw new NotFound('Table not found');

    // Block if there's already an open session (business-scoped — see
    // finding #2 above; belt-and-braces now that the table is verified).
    const dup = await client.query(
      `SELECT id FROM table_sessions
        WHERE business_id = $1 AND table_id = $2 AND status = 'open' LIMIT 1`,
      [businessId, tableId]
    );
    if (dup.rowCount > 0) throw new Conflict('Table already has an open session');

    const ins = await client.query(
      `INSERT INTO table_sessions
         (business_id, table_id, guest_count, customer_phone, customer_name,
          opened_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [businessId, tableId, body.guestCount || 2,
       body.customerPhone || null, body.customerName || null,
       openedByUserId || null, body.notes || null]
    );
    const session = ins.rows[0];

    await client.query(
      `UPDATE tables SET status = 'occupied'::table_status, current_session_id = $1
        WHERE business_id = $2 AND id = $3`,
      [session.id, businessId, tableId]
    );
    return session;
  });
}

// ── Joined tables (2026-08-25, founder request) ────────────────────────
// A 10-person party spans 3 physical tables but runs ONE bill. Extra
// tables are appended to table_sessions.joined_table_ids AND get their
// status/current_session_id pointed at the shared session — so every
// existing "resolve table → session" path (listTables LEFT JOIN on
// current_session_id, dashboard tap, settle's
// `UPDATE tables … WHERE current_session_id = $session`) works for the
// whole group with zero special-casing. Settle/abandon/force-close all
// free by current_session_id, so closing releases EVERY joined table.

async function joinTable(businessId, sessionId, tableId) {
  assertUuid(sessionId, 'sessionId');
  assertUuid(tableId, 'tableId');
  return withTransaction(async (client) => {
    // Lock the session row so two captains can't join tables concurrently
    // and lose one append (read-modify-write on the array).
    const s = await client.query(
      `SELECT * FROM table_sessions
        WHERE business_id = $1 AND id = $2 AND status = 'open'
        FOR UPDATE`,
      [businessId, sessionId]
    );
    if (s.rowCount === 0) throw new NotFound('Open session not found');
    const session = s.rows[0];
    if (session.table_id === tableId) {
      throw new BadRequest("That is already this session's main table");
    }
    if ((session.joined_table_ids || []).includes(tableId)) {
      throw new Conflict('Table is already joined to this session');
    }

    // Tenant-scoped + must be genuinely free. Locked so a concurrent
    // openSession/join on the same table serialises behind us.
    const t = await client.query(
      `SELECT id, status, current_session_id FROM tables
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, tableId]
    );
    if (t.rowCount === 0) throw new NotFound('Table not found');
    if (t.rows[0].status !== 'available' || t.rows[0].current_session_id) {
      throw new Conflict('Table is not free — settle or release it first');
    }
    // Belt & braces: an open session where this table is PRIMARY would not
    // show in tables.current_session_id if a crash left them out of sync.
    const dup = await client.query(
      `SELECT id FROM table_sessions
        WHERE table_id = $1 AND status = 'open' LIMIT 1`,
      [tableId]
    );
    if (dup.rowCount > 0) throw new Conflict('Table already has an open session');

    const upd = await client.query(
      `UPDATE table_sessions
          SET joined_table_ids =
              array_append(COALESCE(joined_table_ids, '{}'::uuid[]), $1)
        WHERE id = $2 RETURNING *`,
      [tableId, sessionId]
    );
    await client.query(
      `UPDATE tables
          SET status = 'occupied'::table_status, current_session_id = $1
        WHERE business_id = $2 AND id = $3`,
      [sessionId, businessId, tableId]
    );
    return upd.rows[0];
  });
}

async function unjoinTable(businessId, sessionId, tableId) {
  assertUuid(sessionId, 'sessionId');
  assertUuid(tableId, 'tableId');
  return withTransaction(async (client) => {
    const s = await client.query(
      `SELECT * FROM table_sessions
        WHERE business_id = $1 AND id = $2 AND status = 'open'
        FOR UPDATE`,
      [businessId, sessionId]
    );
    if (s.rowCount === 0) throw new NotFound('Open session not found');
    if (s.rows[0].table_id === tableId) {
      // The primary table IS the session — removing it means settling or
      // abandoning, never unjoining.
      throw new BadRequest("Cannot unjoin the session's main table");
    }
    if (!(s.rows[0].joined_table_ids || []).includes(tableId)) {
      throw new NotFound('Table is not joined to this session');
    }
    const upd = await client.query(
      `UPDATE table_sessions
          SET joined_table_ids = array_remove(joined_table_ids, $1)
        WHERE id = $2 RETURNING *`,
      [tableId, sessionId]
    );
    // `AND current_session_id = $1` keeps this a no-op if the table was
    // somehow re-pointed elsewhere — we only free what we own.
    await client.query(
      `UPDATE tables
          SET status = 'available'::table_status, current_session_id = NULL
        WHERE business_id = $2 AND id = $3 AND current_session_id = $1`,
      [sessionId, businessId, tableId]
    );
    return upd.rows[0];
  });
}

// 2026-08-25 (founder): settle also accepts
//   paymentBreakdown — [{method: cash|upi|card|online|wallet, amountInr}],
//     1-3 legs that must sum to the session total minus shortfall
//     (±₹0.01 → 400). Stored on the HEAD order (like the settle
//     discount) so bills/reports have one canonical place to read it.
//   shortfallInr — customer underpaid; the gap is booked as a NEGATIVE
//     wallet movement (reason 'shortfall') so the debt lives on the
//     customer's wallet and is visible on their card. Requires an
//     identified customer on the session.
async function closeSession(businessId, sessionId, closedByUserId, paymentMethod = 'cash', discountInr = 0, paymentBreakdown = null, shortfallInr = 0) {
  return withTransaction(async (client) => {
    // Settle-time discount (2026-08-22, founder request): applied to the
    // HEAD order (smallest order_no) of the session so it's auditable on
    // the bill and flows into reports/leakage like any other discount.
    // Capped at the session total so the bill can't go negative.
    const disc = Math.max(0, Number(discountInr) || 0);
    if (disc > 0) {
      const head = await client.query(
        `SELECT id, total FROM orders
          WHERE table_session_id = $1 AND business_id = $2
            AND status <> 'cancelled'
          ORDER BY order_no ASC LIMIT 1
          FOR UPDATE`,
        [sessionId, businessId]
      );
      if (head.rowCount > 0) {
        const sumQ = await client.query(
          `SELECT COALESCE(SUM(total), 0) AS total FROM orders
            WHERE table_session_id = $1 AND status <> 'cancelled'`,
          [sessionId]
        );
        const sessionTotal = parseFloat(sumQ.rows[0].total);
        const applied = Math.min(disc, sessionTotal);
        if (applied > 0) {
          await client.query(
            `UPDATE orders
                SET discount = discount + $1,
                    total = GREATEST(0, total - $1)
              WHERE id = $2`,
            [applied, head.rows[0].id]
          );
        }
      }
    }

    // Compute the session total from orders attached to it
    const totals = await client.query(
      `SELECT COALESCE(SUM(total), 0) AS total
         FROM orders
        WHERE table_session_id = $1 AND status <> 'cancelled'`,
      [sessionId]
    );
    const totalPaise = Math.round(parseFloat(totals.rows[0].total) * 100);

    const upd = await client.query(
      `UPDATE table_sessions
          SET status = 'closed', closed_at = NOW(),
              closed_by_user_id = $1, total_paise = $2
        WHERE business_id = $3 AND id = $4 AND status = 'open'
        RETURNING *`,
      [closedByUserId || null, totalPaise, businessId, sessionId]
    );
    if (upd.rowCount === 0) throw new NotFound('Open session not found');

    // ── Split payments + shortfall on settle (2026-08-25, founder) ──
    // All inside the settle txn: a failed wallet debit / mismatched
    // breakdown aborts the whole settle, so the table never closes
    // half-paid.
    // 2026-08-25 (security review finding #5): clamp the shortfall to the
    // session total — it was only clamped to ≥0, so a caller could book an
    // arbitrary debt (e.g. shortfallInr=999999 on a ₹500 bill) onto the
    // customer's wallet via the allowNegative debit below.
    const shortPaise = Math.min(
      totalPaise,
      Math.round(Math.max(0, Number(shortfallInr) || 0) * 100),
    );
    let breakdownPrimary = null; // largest leg's method → orders.payment_method
    if (shortPaise > 0 || (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0)) {
      const ordersQ = await client.query(
        `SELECT id, order_no, customer_id FROM orders
          WHERE table_session_id = $1 AND business_id = $2
            AND status <> 'cancelled'
          ORDER BY order_no ASC`,
        [sessionId, businessId],
      );
      const head = ordersQ.rows[0];
      if (!head) throw new BadRequest('Session has no orders to settle');
      // First identified customer across the session's KOTs — wallet
      // debits (payment leg or shortfall debt) need a real customer.
      // WHY-caveat (2026-08-25, review finding #5): with JOINED tables one
      // session spans several physical tables / parties, so "first
      // identified customer" may pin the shortfall debt or wallet leg on
      // whichever guest identified themselves first — not necessarily the
      // payer. Left as-is deliberately (staff confirm the customer at
      // settle); revisit if joined-table settles start disputing debts.
      const customerId = ordersQ.rows.find((o) => o.customer_id)?.customer_id || null;
      const gc = require('./giftCardService');

      if (shortPaise > 0) {
        if (!customerId) {
          throw new BadRequest(
            'shortfallInr requires an identified customer on the session — '
            + 'attach a customer phone to the order first',
          );
        }
        // Negative wallet movement = "customer owes us". allowNegative
        // is deliberate and ONLY here — see debitWalletTx WHY-comment.
        await gc.debitWalletTx(client, businessId, customerId, shortPaise, {
          reason: 'shortfall',
          orderId: head.id,
          note: `Underpaid ₹${(shortPaise / 100).toFixed(2)} on settle (order #${head.order_no})`,
          allowNegative: true,
        });
      }

      if (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0) {
        const legs = paymentBreakdown.map((l) => ({
          method: l.method,
          amountPaise: Math.round((l.amountInr || 0) * 100),
        }));
        const sumPaise = legs.reduce((s, l) => s + l.amountPaise, 0);
        // Legs cover what was actually PAID = session total − shortfall.
        const duePaise = totalPaise - shortPaise;
        if (Math.abs(sumPaise - duePaise) > 1) {
          throw new BadRequest(
            `paymentBreakdown legs total ₹${(sumPaise / 100).toFixed(2)} but the `
            + `session total due is ₹${(duePaise / 100).toFixed(2)} — they must match`,
          );
        }
        const walletPaise = legs
          .filter((l) => l.method === 'wallet')
          .reduce((s, l) => s + l.amountPaise, 0);
        if (walletPaise > 0) {
          if (!customerId) {
            throw new BadRequest(
              'Wallet payment requires an identified customer on the session',
            );
          }
          await gc.debitWalletTx(client, businessId, customerId, walletPaise, {
            reason: 'order_payment',
            orderId: head.id,
            note: `Session settle (order #${head.order_no})`,
          });
        }
        // Persist: one payments row per leg + the JSON breakdown on the
        // HEAD order (same place the settle discount lands).
        for (const l of legs) {
          await client.query(
            `INSERT INTO payments (business_id, order_id, method, amount_paise, status)
             VALUES ($1, $2, $3, $4, 'captured')`,
            [businessId, head.id, l.method, l.amountPaise],
          );
        }
        await client.query(
          `UPDATE orders SET payment_breakdown = $1::jsonb, is_split_tender = $2
            WHERE id = $3`,
          [JSON.stringify(paymentBreakdown), legs.length > 1, head.id],
        );
        breakdownPrimary = [...legs].sort((a, b) => b.amountPaise - a.amountPaise)[0].method;
      }
    }

    // Settle every order in the session.
    //
    // Two distinct things happen on settle:
    //   (a) every non-cancelled order's payment_method flips from
    //       'unpaid' to whatever the customer paid (cash/upi/card/online)
    //   (b) every non-cancelled, not-yet-collected order also flips
    //       status to 'collected' and stamps collected_at
    //
    // We deliberately do these as TWO separate updates because earlier
    // we lumped them into one and excluded already-collected rows from
    // the whole thing — which left those orders permanently
    // 'collected · unpaid'. Now we touch ALL non-cancelled orders for
    // payment_method, and only the not-yet-collected ones for status.
    const allowedPM = ['cash', 'upi', 'card', 'online'];
    // 2026-08-25: when a breakdown was sent, the LARGEST leg's method
    // (may be 'wallet' — enum value added in migration 060) wins, so
    // reports keep a single primary method per order.
    const pm = breakdownPrimary
      || (allowedPM.includes(paymentMethod) ? paymentMethod : 'cash');

    // (a) Payment method — applies to every non-cancelled order
    await client.query(
      `UPDATE orders
          SET payment_method = $1::payment_method
        WHERE table_session_id = $2
          AND status <> 'cancelled'::order_status
          AND payment_method = 'unpaid'::payment_method`,
      [pm, sessionId]
    );

    // (b) Status / collected_at — applies only to orders still in
    //     pending/ready (i.e. not yet collected, not cancelled).
    //     RETURNING feeds the post-commit loyalty earn below.
    const flipped = await client.query(
      `UPDATE orders
          SET status = 'collected'::order_status,
              collected_at = COALESCE(collected_at, NOW())
        WHERE table_session_id = $1
          AND status NOT IN ('cancelled'::order_status, 'collected'::order_status)
        RETURNING id, customer_id, total, points_earned`,
      [sessionId]
    );

    // Free the table
    await client.query(
      `UPDATE tables
          SET status = 'available'::table_status, current_session_id = NULL
        WHERE business_id = $1 AND current_session_id = $2`,
      [businessId, sessionId]
    );

    const closed = upd.rows[0];
    closed._settledOrders = flipped.rows; // internal — earn after commit
    return closed;
  }).then(async (closed) => {
    // ── Loyalty earn on settle (2026-08-22) ──────────────────────────
    // Dine-in bills are settled here, NOT via orderService.updateStatus,
    // so points were never earned for table sessions — the founder saw
    // permanent zero balances. Earn now fires per settled order, after
    // the settle transaction commits (idempotent via the per-order
    // unique earn constraint). Best-effort: loyalty problems never
    // un-settle a table.
    const settled = closed._settledOrders || [];
    delete closed._settledOrders;
    try {
      const withCustomer = settled.filter(
        (o) => o.customer_id && (o.points_earned || 0) === 0,
      );
      if (withCustomer.length > 0) {
        const featureService = require('./featureService');
        if (await featureService.hasFeature(businessId, 'loyalty')) {
          const loyalty = require('./loyaltyService');
          const settings = await loyalty.getSettings(businessId);
          if (settings.isActive) {
            for (const o of withCustomer) {
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
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[tableService] settle loyalty earn failed: ${e?.message}`);
    }

    // Bug #5 fix (2026-08-25): issue ONE combined GST tax invoice for the
    // whole session now that payment is collected and the table released.
    // Per-KOT auto-issue is suppressed for session orders in orderService,
    // so this is the only place a dine-in invoice is born. Best-effort —
    // a missing GSTIN must never un-settle a table.
    try {
      await require('./taxInvoiceService').issueFromSession(businessId, sessionId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[tableService] combined session invoice failed: ${e?.message}`);
    }
    return closed;
  });
}

/**
 * Abandon a table session — customer was seated but left before
 * ordering. Frees the table back to 'available' without billing
 * anything. Refuses if any non-cancelled orders are attached, in
 * which case the caller should use closeSession (Settle) instead.
 */
async function abandonSession(businessId, sessionId, closedByUserId) {
  return withTransaction(async (client) => {
    const orders = await client.query(
      `SELECT id FROM orders
        WHERE table_session_id = $1 AND status <> 'cancelled'`,
      [sessionId]
    );
    if (orders.rowCount > 0) {
      throw new BadRequest(
        'Cannot release a table with active orders. Settle the bill instead.'
      );
    }
    const upd = await client.query(
      `UPDATE table_sessions
          SET status = 'abandoned', closed_at = NOW(),
              closed_by_user_id = $1, total_paise = 0
        WHERE business_id = $2 AND id = $3 AND status = 'open'
        RETURNING *`,
      [closedByUserId || null, businessId, sessionId]
    );
    if (upd.rowCount === 0) throw new NotFound('Open session not found');
    // Free the table
    await client.query(
      `UPDATE tables
          SET status = 'available', current_session_id = NULL
        WHERE business_id = $1 AND current_session_id = $2`,
      [businessId, sessionId]
    );
    return upd.rows[0];
  });
}

async function sessionDetail(businessId, sessionId) {
  const s = await query(
    `SELECT ts.*, t.label AS table_label
       FROM table_sessions ts JOIN tables t ON t.id = ts.table_id
      WHERE ts.business_id = $1 AND ts.id = $2 LIMIT 1`,
    [businessId, sessionId]
  );
  if (s.rowCount === 0) throw new NotFound('Session not found');
  const orders = await query(
    `SELECT id, order_no, subtotal, tax, discount, total,
            status, payment_method, created_at
       FROM orders
      WHERE table_session_id = $1
      ORDER BY created_at ASC`,
    [sessionId]
  );
  // Bulk-fetch order_items for every KOT in this session — one query.
  const itemsByOrder = new Map();
  if (orders.rowCount > 0) {
    const orderIds = orders.rows.map((o) => o.id);
    const items = await query(
      `SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])
        ORDER BY id`,
      [orderIds]
    );
    for (const row of items.rows) {
      if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
      itemsByOrder.get(row.order_id).push(row);
    }
  }
  // Joined tables (2026-08-25) — resolve labels so the session dialog can
  // show "also on T2, T3" and offer per-table unjoin without extra calls.
  let joinedTables = [];
  const joinedIds = s.rows[0].joined_table_ids || [];
  if (joinedIds.length > 0) {
    const jt = await query(
      `SELECT id, label FROM tables
        WHERE business_id = $1 AND id = ANY($2::uuid[])
        ORDER BY label`,
      [businessId, joinedIds]
    );
    joinedTables = jt.rows.map((r) => ({ id: r.id, label: r.label }));
  }
  return serializeSession(s.rows[0], orders.rows, itemsByOrder, joinedTables);
}

module.exports = {
  listFloors, createFloor, updateFloor, deleteFloor,
  listTables, createTable, updateTable, deleteTable,
  openSession, closeSession, abandonSession, sessionDetail,
  joinTable, unjoinTable,
  serializeFloor, serializeTable, serializeSession,
};
