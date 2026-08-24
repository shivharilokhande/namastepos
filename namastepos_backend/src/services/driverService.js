// Driver / delivery rider management (Sprint 7 / FF-703)

const { query } = require('../config/db');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

function serialize(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    phone: d.phone,
    vehicleNo: d.vehicle_no,
    vehicleType: d.vehicle_type,
    isActive: d.is_active,
    isOnDuty: d.is_on_duty,
    currentLat: d.current_lat ? parseFloat(d.current_lat) : null,
    currentLng: d.current_lng ? parseFloat(d.current_lng) : null,
    lastPingAt: d.last_ping_at,
  };
}

async function list(businessId) {
  const r = await query(
    `SELECT * FROM drivers WHERE business_id = $1 AND is_active = TRUE
      ORDER BY is_on_duty DESC, name`,
    [businessId],
  );
  return r.rows.map(serialize);
}

async function create(businessId, body) {
  try {
    const r = await query(
      `INSERT INTO drivers (business_id, name, phone, vehicle_no, vehicle_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [businessId, body.name, body.phone, body.vehicleNo || null, body.vehicleType || 'bike'],
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Driver with this phone exists');
    throw err;
  }
}

async function update(businessId, id, patch) {
  const allowed = {
    name: 'name',
    phone: 'phone',
    vehicleNo: 'vehicle_no',
    vehicleType: 'vehicle_type',
    isOnDuty: 'is_on_duty',
    isActive: 'is_active',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(patch[k]); }
  }
  if (!sets.length) return null;
  values.push(businessId, id);
  const r = await query(
    `UPDATE drivers SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Driver not found');
  return serialize(r.rows[0]);
}

async function ping(businessId, driverId, { lat, lng }) {
  await query(
    `UPDATE drivers SET current_lat = $1, current_lng = $2, last_ping_at = NOW()
      WHERE business_id = $3 AND id = $4`,
    [lat, lng, businessId, driverId],
  );
}

async function assignOrder(businessId, orderId, driverId, body = {}) {
  if (!driverId) throw new BadRequest('driverId required');
  // P1 fix (2026-08-22): tenant scoping — both the order and the driver
  // must belong to this business, otherwise a tenant could attach (and
  // later read) another tenant's order via a leaked UUID.
  const own = await query(
    `SELECT
       (SELECT 1 FROM orders  WHERE id = $2 AND business_id = $1) AS order_ok,
       (SELECT 1 FROM drivers WHERE id = $3 AND business_id = $1 AND is_active = TRUE) AS driver_ok`,
    [businessId, orderId, driverId],
  );
  if (!own.rows[0].order_ok) throw new NotFound('Order not found');
  if (!own.rows[0].driver_ok) throw new NotFound('Driver not found');
  const r = await query(
    `INSERT INTO delivery_assignments
       (business_id, order_id, driver_id, delivery_address,
        delivery_lat, delivery_lng, distance_km, delivery_fee_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (order_id) DO UPDATE
       SET driver_id = EXCLUDED.driver_id,
           delivery_address = EXCLUDED.delivery_address
     RETURNING *`,
    [businessId, orderId, driverId, body.address || null,
      body.lat || null, body.lng || null,
      body.distanceKm || null, body.deliveryFeePaise || 0],
  );
  return r.rows[0];
}

async function markStatus(businessId, assignmentId, status) {
  const ts = {
    picked_up: 'picked_up_at', delivered: 'delivered_at',
  }[status];
  const r = await query(
    `UPDATE delivery_assignments
        SET status = $1 ${ts ? `, ${ts} = NOW()` : ''}
      WHERE business_id = $2 AND id = $3 RETURNING *`,
    [status, businessId, assignmentId],
  );
  if (r.rowCount === 0) throw new NotFound('Assignment not found');
  // P1 fix (2026-08-22): flipping an assignment to `delivered` never
  // propagated to the parent order — the Dashboard kept the order in
  // 'pending' forever. Auto-move to 'collected' when the driver marks
  // delivered.
  if (status === 'delivered' && r.rows[0].order_id) {
    try {
      // P2 fix (2026-08-22): route through orderService.updateStatus so
      // the transitions matrix, loyalty earn and tax-invoice auto-issue
      // all fire (the raw UPDATE bypassed them). Already-collected /
      // cancelled orders throw and are safely ignored.
      const orderService = require('./orderService');
      await orderService.updateStatus(businessId, r.rows[0].order_id, 'collected');
    } catch (_) { /* keep the assignment update even if order flip fails */ }
  }
  return r.rows[0];
}

async function liveAssignments(businessId) {
  const r = await query(
    `SELECT da.*, d.name AS driver_name, d.phone AS driver_phone,
            o.order_no, o.total
       FROM delivery_assignments da
       JOIN drivers d ON d.id = da.driver_id AND d.business_id = da.business_id
       JOIN orders o ON o.id = da.order_id AND o.business_id = da.business_id
      WHERE da.business_id = $1 AND da.status IN ('assigned', 'picked_up')
      ORDER BY da.assigned_at`,
    [businessId],
  );
  return r.rows;
}

module.exports = {
  list,
  create,
  update,
  ping,
  assignOrder,
  markStatus,
  liveAssignments,
};
