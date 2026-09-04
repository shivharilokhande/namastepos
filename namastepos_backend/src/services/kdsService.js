// Kitchen Display System (F38) — long-polling for tickets per station.
// Front-end calls /poll with `since` timestamp; we return new+updated tickets.

const { query } = require('../config/db');

async function ticketsForStation(businessId, stationId, sinceIso) {
  const r = await query(
    `SELECT kt.id, kt.order_id, kt.ticket_no, kt.status, kt.created_at,
            kt.started_at, kt.completed_at,
            o.order_no, o.source, o.table_no,
            ks.name AS station_name, ks.color AS station_color,
            COALESCE(json_agg(json_build_object(
              'id', kti.id, 'name', kti.name, 'qty', kti.qty, 'note', kti.note
            )) FILTER (WHERE kti.id IS NOT NULL), '[]') AS items
       FROM kot_tickets kt
       JOIN orders o ON o.id = kt.order_id
       JOIN kot_stations ks ON ks.id = kt.station_id
  LEFT JOIN kot_ticket_items kti ON kti.ticket_id = kt.id
      WHERE kt.business_id = $1
        AND kt.station_id = $2
        AND kt.status IN ('pending','in_progress')
        AND (kt.created_at > $3::timestamptz OR $3 IS NULL)
      GROUP BY kt.id, o.order_no, o.source, o.table_no, ks.name, ks.color
      ORDER BY kt.created_at`,
    [businessId, stationId, sinceIso || null],
  );
  return r.rows;
}

async function markTicketStatus(businessId, ticketId, status) {
  const setExtras = status === 'in_progress' ? ', started_at = COALESCE(started_at, NOW())'
    : status === 'done' ? ', completed_at = NOW()'
      : '';
  const r = await query(
    `UPDATE kot_tickets
        SET status = $1::kot_status ${setExtras}
      WHERE business_id = $2 AND id = $3 RETURNING *`,
    [status, businessId, ticketId],
  );
  const ticket = r.rows[0];

  // Push 13.8: cascade ticket → order. There are TWO endpoints that mark
  // a KOT ticket (kotService.updateTicketStatus via /ops/kot/tickets/...
  // and this kdsService.markTicketStatus via /kds/tickets/...). The
  // mobile KDS hits THIS one, so the cascade must live here too — the
  // copy in kotService alone was missing the mobile flow.
  if (ticket && status === 'done') {
    const remaining = await query(
      `SELECT COUNT(*)::int AS n FROM kot_tickets
        WHERE order_id = $1 AND status NOT IN ('done','cancelled')`,
      [ticket.order_id],
    );
    if (remaining.rows[0].n === 0) {
      await query(
        `UPDATE orders SET status = 'ready', ready_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
        [ticket.order_id, businessId],
      );
    }
  }
  return ticket;
}

async function heartbeat(businessId, stationId, label) {
  await query(
    `INSERT INTO kds_clients (business_id, station_id, client_label)
     VALUES ($1, $2, $3)`,
    [businessId, stationId, label],
  );
}

module.exports = { ticketsForStation, markTicketStatus, heartbeat };
