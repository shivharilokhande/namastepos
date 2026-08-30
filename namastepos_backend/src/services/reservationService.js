// Reservations + wait list (Sprint 3 / FF-505)

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

function serialize(r) {
  if (!r) return null;
  return {
    id: r.id,
    tableId: r.table_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    partySize: r.party_size,
    reservedAt: r.reserved_at,
    durationMin: r.duration_min,
    status: r.status,
    specialRequests: r.special_requests,
    source: r.source,
    arrivedAt: r.arrived_at,
    tableLabel: r.table_label,
  };
}

async function list(businessId, { from, to, status, tableId } = {}) {
  const where = ['r.business_id = $1'];
  const values = [businessId]; let idx = 2;
  if (from)   { where.push(`r.reserved_at >= $${idx++}`); values.push(from); }
  if (to)     { where.push(`r.reserved_at < $${idx++}`); values.push(to); }
  if (status) { where.push(`r.status = $${idx++}`); values.push(status); }
  if (tableId){ where.push(`r.table_id = $${idx++}`); values.push(tableId); }
  const r = await query(
    `SELECT r.*, t.label AS table_label
       FROM reservations r
  LEFT JOIN tables t ON t.id = r.table_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.reserved_at ASC`,
    values
  );
  return r.rows.map(serialize);
}

async function create(businessId, body, createdBy) {
  const {
    customerName, customerPhone, customerEmail,
    partySize, reservedAt, durationMin = 90,
    tableId = null, specialRequests, source = 'phone',
  } = body;
  if (!customerName || !customerPhone || !reservedAt || !partySize) {
    throw new BadRequest('name, phone, reservedAt, partySize required');
  }
  // Optional: block double-booking the same table in the same slot
  if (tableId) {
    const conflict = await query(
      `SELECT id FROM reservations
        WHERE business_id = $1 AND table_id = $2
          AND status IN ('booked','confirmed','seated')
          AND tstzrange(reserved_at, reserved_at + (duration_min || ' min')::interval)
              && tstzrange($3::timestamptz, $3::timestamptz + ($4 || ' min')::interval)
        LIMIT 1`,
      [businessId, tableId, reservedAt, durationMin]
    );
    if (conflict.rowCount > 0) throw new Conflict('Table already booked for that time slot');
  }

  const r = await query(
    `INSERT INTO reservations
       (business_id, table_id, customer_name, customer_phone, customer_email,
        party_size, reserved_at, duration_min, special_requests, source, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [businessId, tableId, customerName, customerPhone, customerEmail || null,
     partySize, reservedAt, durationMin, specialRequests || null, source, createdBy || null]
  );

  // Schedule a reminder 1 hour before
  await query(
    `INSERT INTO scheduled_messages
       (business_id, channel, kind, scheduled_at, body)
     VALUES ($1, 'whatsapp', 'reservation_reminder', $2::timestamptz - INTERVAL '1 hour',
             $3)`,
    [businessId, reservedAt,
     `Hi ${customerName}, this is a reminder for your reservation at our place for ${partySize} guests. See you soon!`]
  );

  return serialize(r.rows[0]);
}

async function update(businessId, id, patch) {
  const allowed = {
    status: 'status', tableId: 'table_id', arrivedAt: 'arrived_at',
    specialRequests: 'special_requests', partySize: 'party_size',
    reservedAt: 'reserved_at',
  };
  // IDOR fix (2026-08-30): if re-pointing the reservation at a table, verify
  // that table belongs to THIS business — the incoming tableId was written
  // straight through, allowing a cross-tenant table reference.
  if (patch.tableId !== undefined && patch.tableId !== null) {
    const own = await query(
      `SELECT 1 FROM tables WHERE id = $1 AND business_id = $2`,
      [patch.tableId, businessId]
    );
    if (own.rowCount === 0) throw new NotFound('Table not found');
  }
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(patch[k]); }
  }
  if (!sets.length) return null;
  values.push(businessId, id);
  const r = await query(
    `UPDATE reservations SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Reservation not found');
  return serialize(r.rows[0]);
}

async function seat(businessId, id) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE reservations SET status = 'seated', arrived_at = NOW()
        WHERE business_id = $1 AND id = $2 RETURNING *`,
      [businessId, id]
    );
    if (r.rowCount === 0) throw new NotFound('Reservation not found');
    const res = r.rows[0];
    if (res.table_id) {
      await client.query(
        `UPDATE tables SET status = 'occupied'::table_status
          WHERE business_id = $1 AND id = $2`,
        [businessId, res.table_id]
      );
    }
    return serialize(res);
  });
}

// ── Wait list ────────────────────────────────────────────────────────────
async function addToWaitList(businessId, body) {
  const { customerName, customerPhone, partySize, estimatedWaitMin } = body;
  const r = await query(
    `INSERT INTO wait_list
       (business_id, customer_name, customer_phone, party_size, estimated_wait_min)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [businessId, customerName, customerPhone, partySize, estimatedWaitMin || null]
  );
  return r.rows[0];
}

async function listWaitList(businessId) {
  const r = await query(
    `SELECT * FROM wait_list
      WHERE business_id = $1 AND status = 'waiting'
      ORDER BY created_at ASC`,
    [businessId]
  );
  return r.rows;
}

async function notifyWaitList(businessId, id) {
  await query(
    `UPDATE wait_list SET notified_at = NOW() WHERE business_id = $1 AND id = $2`,
    [businessId, id]
  );
}

module.exports = {
  list, create, update, seat,
  addToWaitList, listWaitList, notifyWaitList, serialize,
};
