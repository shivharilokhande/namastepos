// NamastePOS backend - coupons & promotions

const { query } = require('../config/db');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

function serialize(c) {
  return {
    id: c.id, code: c.code, description: c.description,
    type: c.type, value: parseFloat(c.value),
    appliesToPlan: c.applies_to_plan,
    maxRedemptions: c.max_redemptions,
    redemptionCount: c.redemption_count,
    startsAt: c.starts_at, expiresAt: c.expires_at,
    status: c.status, createdAt: c.created_at,
  };
}

async function list({ status, type, limit = 100 } = {}) {
  const where = ['1=1']; const values = []; let idx = 1;
  if (status) { where.push(`status = $${idx++}`); values.push(status); }
  if (type)   { where.push(`type = $${idx++}`);   values.push(type); }
  values.push(limit);
  const r = await query(
    `SELECT * FROM coupons WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${idx++}`,
    values
  );
  return r.rows.map(serialize);
}

async function getById(id) {
  const r = await query(`SELECT * FROM coupons WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new NotFound('Coupon not found');
  return serialize(r.rows[0]);
}

async function getByCode(code) {
  const r = await query(`SELECT * FROM coupons WHERE code = $1`, [code.toUpperCase()]);
  if (r.rowCount === 0) throw new NotFound('Coupon not found');
  return r.rows[0];
}

async function create({
  code, description, type, value, appliesToPlan = null,
  maxRedemptions = null, expiresAt = null, createdBy,
}) {
  if (!code || !type || value === undefined) {
    throw new BadRequest('code, type and value are required');
  }
  try {
    const r = await query(
      `INSERT INTO coupons (code, description, type, value, applies_to_plan,
                            max_redemptions, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code.toUpperCase(), description, type, value, appliesToPlan,
       maxRedemptions, expiresAt, createdBy]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Coupon code already exists');
    throw err;
  }
}

async function update(id, patch) {
  const fields = ['description', 'value', 'applies_to_plan', 'max_redemptions',
                  'expires_at', 'status'];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  if (sets.length === 0) return getById(id);
  values.push(id);
  const r = await query(
    `UPDATE coupons SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Coupon not found');
  return serialize(r.rows[0]);
}

async function disable(id) {
  return update(id, { status: 'disabled' });
}

async function listRedemptions(couponId) {
  const r = await query(
    `SELECT cr.*, b.name AS business_name
       FROM coupon_redemptions cr JOIN businesses b ON b.id = cr.business_id
      WHERE cr.coupon_id = $1
      ORDER BY cr.applied_at DESC`,
    [couponId]
  );
  return r.rows.map((x) => ({
    id: x.id, businessId: x.business_id, businessName: x.business_name,
    appliedAt: x.applied_at, invoiceId: x.invoice_id,
  }));
}

/**
 * Validate a coupon for a given business + plan. Returns the calculated discount.
 * (Used by the customer dashboard's plan-change flow.)
 */
async function validate(code, { businessId, tier, basePaise }) {
  const c = await getByCode(code);
  if (c.status !== 'active') throw new BadRequest('Coupon is not active');
  if (c.expires_at && new Date(c.expires_at) < new Date()) {
    throw new BadRequest('Coupon expired');
  }
  if (c.max_redemptions && c.redemption_count >= c.max_redemptions) {
    throw new BadRequest('Coupon redeemed to maximum');
  }
  if (c.applies_to_plan && c.applies_to_plan !== tier) {
    throw new BadRequest(`Coupon only applies to ${c.applies_to_plan} plan`);
  }
  // Same business can't redeem twice
  const used = await query(
    `SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1 AND business_id = $2`,
    [c.id, businessId]
  );
  if (used.rowCount > 0) throw new BadRequest('Already redeemed by this business');

  let discountPaise = 0; let trialDays = 0;
  if (c.type === 'percent')     discountPaise = Math.round(basePaise * (parseFloat(c.value) / 100));
  else if (c.type === 'flat')   discountPaise = Math.round(parseFloat(c.value) * 100);
  else if (c.type === 'trial_extension') trialDays = parseInt(c.value, 10);

  return {
    coupon: serialize(c),
    discountPaise: Math.min(discountPaise, basePaise),
    trialDays,
  };
}

async function markRedeemed(couponId, businessId, invoiceId = null) {
  await query(
    `INSERT INTO coupon_redemptions (coupon_id, business_id, invoice_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [couponId, businessId, invoiceId]
  );
  await query(
    `UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = $1`,
    [couponId]
  );
}

module.exports = {
  list, getById, getByCode, create, update, disable,
  listRedemptions, validate, markRedeemed, serialize,
};
