// NamastePOS backend - customer CRM service (per-tenant)

const { query } = require('../config/db');
const { NotFound, Conflict, BadRequest } = require('../utils/errors');

function serialize(c) {
  if (!c) return null;
  return {
    id: c.id,
    businessId: c.business_id,
    phone: c.phone,
    name: c.name,
    email: c.email,
    birthday: c.birthday,
    gender: c.gender,
    tags: c.tags || [],
    notes: c.notes,
    totalOrders: c.total_orders,
    totalSpent: parseFloat(c.total_spent || 0),
    pointsBalance: c.points_balance,
    lifetimePoints: c.lifetime_points,
    lifetimeRedeemed: c.lifetime_redeemed,
    tier: c.tier,
    firstOrderAt: c.first_order_at,
    lastOrderAt: c.last_order_at,
    visitCount: c.visit_count,
    marketingOptin: c.marketing_optin,
    createdAt: c.created_at,
  };
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('+91')) return digits.slice(3);
  return digits;
}

// ── List / search ───────────────────────────────────────────────────────
async function list(businessId, { search, tier, sort = 'recent', limit = 100, offset = 0 } = {}) {
  const where = ['business_id = $1']; const values = [businessId]; let idx = 2;
  if (search) {
    where.push(`(phone ILIKE $${idx} OR name ILIKE $${idx} OR email ILIKE $${idx})`);
    values.push(`%${search}%`); idx += 1;
  }
  if (tier) { where.push(`tier = $${idx++}`); values.push(tier); }

  const orderBy = sort === 'top_spender' ? 'total_spent DESC'
                : sort === 'top_loyalty' ? 'lifetime_points DESC'
                : 'last_order_at DESC NULLS LAST';

  // P1 perf (Vivek #2 / Aditya): single roundtrip — window-function COUNT
  // over the same predicate avoids the two-query race that caused
  // `listCustomers` 500s in the admin pane (idx slice bug) and means the
  // `total` field can never drift from the rows we just returned.
  values.push(limit, offset);
  const r = await query(
    `SELECT *, COUNT(*) OVER ()::int AS _total FROM customers
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${idx++} OFFSET $${idx}`,
    values
  );
  const total = r.rows[0]?._total ?? 0;
  return { customers: r.rows.map(serialize), total };
}

async function byId(businessId, id) {
  const r = await query(
    `SELECT * FROM customers WHERE business_id = $1 AND id = $2 LIMIT 1`,
    [businessId, id]
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return serialize(r.rows[0]);
}

async function byPhone(businessId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new BadRequest('Invalid phone');
  const r = await query(
    `SELECT * FROM customers WHERE business_id = $1 AND phone = $2 LIMIT 1`,
    [businessId, normalized]
  );
  return r.rowCount === 0 ? null : serialize(r.rows[0]);
}

// ── Create / upsert (used at checkout) ──────────────────────────────────
async function upsert(businessId, body) {
  const phone = normalizePhone(body.phone);
  if (!phone) throw new BadRequest('Phone required');

  // Try existing
  const found = await byPhone(businessId, phone);
  if (found) {
    if (!body.name && !body.email && !body.birthday) return found;
    return update(businessId, found.id, body);
  }
  // Create new
  try {
    const r = await query(
      `INSERT INTO customers (business_id, phone, name, email, birthday, gender, tags, notes, marketing_optin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [businessId, phone, body.name || null, body.email || null,
       body.birthday || null, body.gender || null,
       body.tags || null, body.notes || null,
       body.marketingOptin !== false]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Customer phone already exists');
    throw err;
  }
}

async function update(businessId, id, patch) {
  const allowed = {
    name: 'name', email: 'email', birthday: 'birthday', gender: 'gender',
    tags: 'tags', notes: 'notes', marketing_optin: 'marketing_optin',
    marketingOptin: 'marketing_optin',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(patch[k]); }
  }
  if (sets.length === 0) return byId(businessId, id);
  values.push(businessId, id);
  const r = await query(
    `UPDATE customers SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return serialize(r.rows[0]);
}

async function softDelete(businessId, id) {
  // Customers can't be hard-deleted (order history depends on them).
  // We just blank out personal fields.
  await query(
    `UPDATE customers
        SET name = NULL, email = NULL, birthday = NULL,
            tags = NULL, notes = '(removed)', marketing_optin = FALSE
      WHERE business_id = $1 AND id = $2`,
    [businessId, id]
  );
  return { id };
}

// ── Order linkage (called from orderService when an order is created) ──
/**
 * Find-or-create a customer for the given phone and update visit stats.
 * Called inside the order-create transaction.
 */
async function linkToOrder(client, { businessId, phone, name, orderId, orderTotal }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  // Upsert
  const upsert = await client.query(
    `INSERT INTO customers (business_id, phone, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, phone) DO UPDATE
       SET name = COALESCE(customers.name, EXCLUDED.name)
     RETURNING *`,
    [businessId, normalized, name || null]
  );
  const customer = upsert.rows[0];

  // Bump stats
  await client.query(
    `UPDATE customers
        SET total_orders   = total_orders + 1,
            total_spent    = total_spent + $1,
            visit_count    = visit_count + 1,
            last_order_at  = NOW(),
            first_order_at = COALESCE(first_order_at, NOW())
      WHERE id = $2`,
    [orderTotal, customer.id]
  );

  return customer;
}

async function recentOrders(businessId, customerId, { limit = 20 } = {}) {
  const r = await query(
    `SELECT id, order_no, total, status, source, payment_method,
            points_earned, points_redeemed, created_at
       FROM orders
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [businessId, customerId, limit]
  );
  return r.rows;
}

module.exports = {
  list, byId, byPhone, upsert, update, softDelete,
  linkToOrder, recentOrders, serialize, normalizePhone,
};
