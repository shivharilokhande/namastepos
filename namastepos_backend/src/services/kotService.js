// NamastePOS backend - Kitchen Order Tickets (KOT)
//
// When an order is placed, items get grouped by their assigned station
// and one ticket is generated per station. Each ticket can be routed to
// that station's own printer (different MAC address than the bill printer).

const { query } = require('../config/db');
const { NotFound, Conflict, BadRequest } = require('../utils/errors');

// ── Serializers ────────────────────────────────────────────────────────
function serializeStation(s) {
  return {
    id: s.id,
    businessId: s.business_id,
    name: s.name,
    printerAddress: s.printer_address,
    printerPaperMm: s.printer_paper_mm,
    color: s.color,
    isActive: s.is_active,
    displayOrder: s.display_order,
    createdAt: s.created_at,
  };
}
function serializeTicket(t, items = []) {
  return {
    id: t.id,
    businessId: t.business_id,
    orderId: t.order_id,
    stationId: t.station_id,
    stationName: t.station_name,
    ticketNo: t.ticket_no,
    status: t.status,
    printed: t.printed,
    printedAt: t.printed_at,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    createdAt: t.created_at,
    orderNo: t.order_no,
    tableLabel: t.table_label,
    items: items.map((i) => ({
      id: i.id, name: i.name, qty: parseFloat(i.qty), note: i.note,
    })),
  };
}

// ── Stations CRUD ──────────────────────────────────────────────────────
async function listStations(businessId) {
  const r = await query(
    'SELECT * FROM kot_stations WHERE business_id = $1 ORDER BY display_order, name',
    [businessId],
  );
  return r.rows.map(serializeStation);
}

async function createStation(businessId, body) {
  if (!body.name) throw new BadRequest('Station name is required');
  try {
    const r = await query(
      `INSERT INTO kot_stations
         (business_id, name, printer_address, printer_paper_mm, color, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [businessId, body.name, body.printer_address || null,
        body.printer_paper_mm || 58, body.color || '#FF6B35',
        body.display_order || 100, body.is_active !== false],
    );
    return serializeStation(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Station name already exists');
    throw err;
  }
}

async function updateStation(businessId, id, patch) {
  const allowed = ['name', 'printer_address', 'printer_paper_mm',
    'color', 'is_active', 'display_order'];
  const sets = []; const values = []; let idx = 1;
  for (const f of allowed) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  if (sets.length === 0) {
    const r = await query(
      'SELECT * FROM kot_stations WHERE business_id = $1 AND id = $2',
      [businessId, id],
    );
    if (r.rowCount === 0) throw new NotFound('Station not found');
    return serializeStation(r.rows[0]);
  }
  values.push(businessId, id);
  const r = await query(
    `UPDATE kot_stations SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Station not found');
  return serializeStation(r.rows[0]);
}

async function deleteStation(businessId, id) {
  const r = await query(
    'DELETE FROM kot_stations WHERE business_id = $1 AND id = $2 RETURNING id',
    [businessId, id],
  );
  if (r.rowCount === 0) throw new NotFound('Station not found');
  return { id: r.rows[0].id };
}

// ── Ticket generation (called inside order create txn) ─────────────────
// P1 fix (2026-08-22): was `MAX(ticket_no)+1` without `FOR UPDATE` — two
// concurrent orders could pick the same next number. Now:
//   * Acquire a transaction-scoped advisory lock keyed by business_id
//     (Postgres serialises callers with the same key)
//   * Then compute MAX+1 within the lock window
// Advisory locks are automatically released at COMMIT/ROLLBACK, so
// the lock lifetime matches the order-create transaction. We convert
// the business_id UUID to an int8 by hashing to keep the lock key
// numeric (pg_advisory_xact_lock takes int8).
async function nextTicketNo(client, businessId) {
  // pg_advisory_xact_lock(bigint) — key derived from the business_id.
  await client.query(
    'SELECT pg_advisory_xact_lock((\'x\' || substr(md5($1::text), 1, 15))::bit(60)::bigint)',
    [businessId],
  );
  const r = await client.query(
    `SELECT COALESCE(MAX(ticket_no), 0) + 1 AS next
       FROM kot_tickets
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
            = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [businessId],
  );
  return r.rows[0].next;
}

/**
 * After an order is inserted + its order_items are inserted, call this
 * inside the same transaction to generate the KOT tickets.
 *
 * orderItemsByStation: Map<stationId, [{ orderItemId, name, qty, note }, ...]>
 */
async function generateTickets(client, { businessId, orderId, orderItems }) {
  // Look up the station for each order item via menu_items.kot_station_id
  const itemIds = orderItems.map((it) => it.menuItemId).filter(Boolean);
  if (itemIds.length === 0) return [];
  const stationLookup = await client.query(
    `SELECT id, kot_station_id FROM menu_items
      WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, itemIds],
  );
  const stationByItem = new Map();
  for (const m of stationLookup.rows) stationByItem.set(m.id, m.kot_station_id);

  // Fallback station (Push 13.3 fix): cafes that haven't set up the
  // station-router still want orders to show on KDS. If ANY order item is
  // missing a kot_station_id, route it to a default "Kitchen" station
  // for the business. Look one up; create it if none exists.
  let fallbackStationId = null;
  const needsFallback = orderItems.some((oi) => !stationByItem.get(oi.menuItemId));
  if (needsFallback) {
    const existing = await client.query(
      `SELECT id FROM kot_stations
        WHERE business_id = $1 AND is_active = TRUE
        ORDER BY created_at LIMIT 1`,
      [businessId],
    );
    if (existing.rowCount > 0) {
      fallbackStationId = existing.rows[0].id;
    } else {
      // NP-301 (2026-09-04): `ON CONFLICT DO NOTHING` + re-read. Two
      // concurrent FIRST orders for a brand-new business used to race here and
      // one hit `uq_station (business_id, name)` — harmless while the caller
      // swallowed every KOT error, but now that a KOT failure correctly rolls
      // the order back, a 23505 on the auto-created fallback station would
      // reject a perfectly good sale. So the insert is made idempotent.
      const created = await client.query(
        `INSERT INTO kot_stations (business_id, name, is_active)
         VALUES ($1, 'Kitchen', TRUE)
         ON CONFLICT (business_id, name) DO NOTHING
         RETURNING id`,
        [businessId],
      );
      if (created.rowCount > 0) {
        fallbackStationId = created.rows[0].id;
      } else {
        const raced = await client.query(
          `SELECT id FROM kot_stations
            WHERE business_id = $1 AND name = 'Kitchen' LIMIT 1`,
          [businessId],
        );
        // If the racer's transaction has not committed yet its row is
        // invisible to us; fall back to any active station, and if there is
        // genuinely none, leave the items unroutable (returns [] as before)
        // rather than failing the sale on a naming collision.
        fallbackStationId = raced.rows[0]?.id || null;
      }
    }
  }

  // Group items by station (using the fallback for unassigned items)
  const byStation = new Map();
  for (const oi of orderItems) {
    const stationId = stationByItem.get(oi.menuItemId) || fallbackStationId;
    if (!stationId) continue; // truly unroutable — skip
    if (!byStation.has(stationId)) byStation.set(stationId, []);
    byStation.get(stationId).push(oi);
  }
  if (byStation.size === 0) return [];

  const tickets = [];
  for (const [stationId, items] of byStation.entries()) {
    const ticketNo = await nextTicketNo(client, businessId);
    const ins = await client.query(
      `INSERT INTO kot_tickets (business_id, order_id, station_id, ticket_no)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [businessId, orderId, stationId, ticketNo],
    );
    for (const it of items) {
      await client.query(
        `INSERT INTO kot_ticket_items (ticket_id, order_item_id, name, qty, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [ins.rows[0].id, it.orderItemId || null, it.name, it.qty, it.note || null],
      );
    }
    // NP-301: carry the grouped lines back out so the caller can enqueue the
    // print job for this ticket in the SAME transaction without re-reading
    // kot_ticket_items. Pure addition to the return shape.
    tickets.push({ ...ins.rows[0], items });
  }
  return tickets;
}

/**
 * NP-301 (2026-09-04) — enqueue ONE print job per kitchen ticket, in the
 * caller's transaction.
 *
 * Why this is split from `generateTickets`: the tickets are the RECORD of what
 * the kitchen must cook and must commit with the order; the paper is I/O and
 * must not be able to fail the sale. So rows go in-txn (both the ticket rows
 * and the print_jobs rows — a queue row is still just a row), and the actual
 * ESC/POS write happens later in the print agent, which claims jobs via
 * printerService.dequeueNext and reports back with markJobDone. A printer that
 * is offline now retries with a backoff instead of dead-lettering (see
 * printerService.markJobDone).
 *
 * Routing: the station's own printer if one is configured, else the business's
 * default KOT printer, else NULL — a NULL printer_id job is still claimable by
 * the business's agent, which is strictly better than not queueing the ticket.
 */
async function enqueueTicketPrints(client, { businessId, orderId, tickets, order = {} }) {
  if (!tickets || tickets.length === 0) return [];
  const printer = require('./printerService');

  // ONE round-trip: station names/paper + each station's bound KOT printer +
  // the business-wide fallback KOT printer. This runs inside the order
  // transaction (the hottest path in the codebase), so it is deliberately not
  // three queries.
  const stationIds = [...new Set(tickets.map((t) => t.station_id).filter(Boolean))];
  const meta = await client.query(
    `WITH st AS (
        SELECT ks.id, ks.name, ks.printer_paper_mm,
               p.id AS printer_id, p.paper_width_mm
          FROM kot_stations ks
     LEFT JOIN printers p
            ON p.station_id = ks.id AND p.business_id = ks.business_id
           AND p.is_active = TRUE AND p.kind = 'kot'
         WHERE ks.business_id = $1 AND ks.id = ANY($2::uuid[])
     ), fb AS (
        SELECT id AS printer_id, paper_width_mm
          FROM printers
         WHERE business_id = $1 AND is_active = TRUE AND kind = 'kot'
           AND station_id IS NULL
         ORDER BY is_default DESC, created_at ASC
         LIMIT 1
     )
     SELECT st.id, st.name, st.printer_paper_mm, st.printer_id, st.paper_width_mm,
            fb.printer_id AS fb_printer_id, fb.paper_width_mm AS fb_paper_width_mm
       FROM st LEFT JOIN fb ON TRUE`,
    [businessId, stationIds],
  );
  const byStation = new Map(meta.rows.map((r) => [r.id, r]));
  const fallbackPrinter = meta.rows.find((r) => r.fb_printer_id)
    ? { id: meta.rows[0].fb_printer_id, paper_width_mm: meta.rows[0].fb_paper_width_mm }
    : null;

  const jobIds = [];
  for (const t of tickets) {
    const st = byStation.get(t.station_id) || {};
    const printerId = st.printer_id || fallbackPrinter?.id || null;
    const paperWidthMm = st.paper_width_mm || st.printer_paper_mm
      || fallbackPrinter?.paper_width_mm || 58;
    const payloadText = printer.renderKotText({
      stationName: st.name,
      ticketNo: t.ticket_no,
      orderNo: order.orderNo ?? order.order_no,
      source: order.source,
      tableLabel: order.tableLabel ?? order.table_no,
      tokenNo: order.tokenNo ?? order.token_no,
      items: (t.items || []).map((i) => ({ qty: i.qty, name: i.name, note: i.note })),
      paperWidthMm,
      createdAt: t.created_at,
    });
    // eslint-disable-next-line no-await-in-loop
    jobIds.push(await printer.queuePrintJob({
      businessId,
      printerId,
      orderId,
      kotTicketId: t.id,
      kind: 'kot',
      payloadText,
      client, // ← in-txn: no order without its queued ticket
    }));
  }
  return jobIds;
}

// ── Live queue / status updates ─────────────────────────────────────────
async function listTickets(businessId, { stationId, status, day } = {}) {
  const where = ['kt.business_id = $1'];
  const values = [businessId];
  let idx = 2;
  if (stationId) { where.push(`kt.station_id = $${idx++}`); values.push(stationId); }
  if (status) { where.push(`kt.status = $${idx++}`); values.push(status); }
  if (day) {
    where.push(`kt.created_at::date = $${idx++}::date`);
    values.push(day);
  } else {
    // default: today (IST, so the KDS queue rolls over at IST midnight
    // not 05:30 IST / UTC midnight)
    where.push("(kt.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date");
  }

  const r = await query(
    `SELECT kt.*, ks.name AS station_name, o.order_no, t.label AS table_label
       FROM kot_tickets kt
       JOIN kot_stations ks ON ks.id = kt.station_id
       JOIN orders o ON o.id = kt.order_id
  LEFT JOIN tables t ON t.id = o.table_id
      WHERE ${where.join(' AND ')}
      ORDER BY kt.created_at DESC`,
    values,
  );
  if (r.rowCount === 0) return [];

  const ticketIds = r.rows.map((x) => x.id);
  const itemsR = await query(
    'SELECT * FROM kot_ticket_items WHERE ticket_id = ANY($1::uuid[])',
    [ticketIds],
  );
  const byTicket = new Map();
  for (const i of itemsR.rows) {
    if (!byTicket.has(i.ticket_id)) byTicket.set(i.ticket_id, []);
    byTicket.get(i.ticket_id).push(i);
  }
  return r.rows.map((t) => serializeTicket(t, byTicket.get(t.id) || []));
}

async function updateTicketStatus(businessId, ticketId, status) {
  const allowed = ['pending', 'in_progress', 'done', 'cancelled'];
  if (!allowed.includes(status)) throw new BadRequest(`Invalid status: ${status}`);
  const patch = ['status = $1'];
  const values = [status];
  if (status === 'in_progress') patch.push('started_at = NOW()');
  if (status === 'done') patch.push('completed_at = NOW()');
  const r = await query(
    `UPDATE kot_tickets SET ${patch.join(', ')}
      WHERE business_id = $${values.length + 1} AND id = $${values.length + 2}
      RETURNING *`,
    [...values, businessId, ticketId],
  );
  if (r.rowCount === 0) throw new NotFound('Ticket not found');

  // Push 13.3 sync: cascade KOT ticket status into the parent order so
  // the Orders tab + KDS don't drift. Marking ALL tickets for an order
  // as 'done' → order moves to 'ready'. Marking the first ticket as
  // 'in_progress' doesn't change the order (still 'pending' until ready).
  const ticket = r.rows[0];
  if (status === 'done') {
    const remaining = await query(
      `SELECT COUNT(*)::int AS n FROM kot_tickets
        WHERE order_id = $1 AND status NOT IN ('done','cancelled')`,
      [ticket.order_id],
    );
    if (remaining.rows[0].n === 0) {
      await query(
        `UPDATE orders SET status = 'ready', updated_at = NOW()
          WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
        [ticket.order_id, businessId],
      );
    }
  }
  return ticket;
}

async function markPrinted(businessId, ticketId) {
  await query(
    `UPDATE kot_tickets
        SET printed = TRUE, printed_at = NOW()
      WHERE business_id = $1 AND id = $2`,
    [businessId, ticketId],
  );
}

module.exports = {
  listStations,
  createStation,
  updateStation,
  deleteStation,
  generateTickets,
  enqueueTicketPrints,
  listTickets,
  updateTicketStatus,
  markPrinted,
  serializeStation,
  serializeTicket,
};
