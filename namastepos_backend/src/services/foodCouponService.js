// Food-order coupons (FF-1701) — separate from subscription coupons.
// Reuses the existing `coupons` table with applies_to = 'food_order' or 'both'.
// 2026-08-25 (founder #13): coupons are now business-owned (business_id,
// migration 058) with an optional percent cap ("10% off upto ₹50").
// business_id IS NULL = legacy/platform-wide coupon, visible to everyone.

const { query } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

async function listForBusiness(businessId, { includeInactive = false } = {}) {
  // Owners see their own coupons + platform-wide ones; never other tenants'.
  const where = [
    `applies_to IN ('food_order','both')`,
    `(business_id IS NULL OR business_id = $1)`,
  ];
  if (!includeInactive) where.push(`status = 'active'`);
  const r = await query(
    `SELECT * FROM coupons WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT 200`,
    [businessId]
  );
  return r.rows;
}

async function applyToOrder(businessId, { code, subtotal, customerId }) {
  // Tenant-scoped lookup — another business's private coupon must behave
  // exactly like a coupon that doesn't exist.
  const c = await query(
    `SELECT * FROM coupons
      WHERE code = $1 AND (business_id IS NULL OR business_id = $2)
      LIMIT 1`,
    [code.toUpperCase(), businessId]
  );
  if (c.rowCount === 0) throw new NotFound('Coupon not found');
  const coupon = c.rows[0];
  if (coupon.status !== 'active') throw new BadRequest('Coupon inactive');
  if (!['food_order', 'both'].includes(coupon.applies_to)) {
    throw new BadRequest('Coupon does not apply to food orders');
  }
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw new BadRequest('Coupon expired');
  }
  if (coupon.max_redemptions && coupon.redemption_count >= coupon.max_redemptions) {
    throw new BadRequest('Coupon fully redeemed');
  }

  let discount = 0;
  if (coupon.type === 'percent') discount = Math.min(subtotal, +(subtotal * parseFloat(coupon.value) / 100).toFixed(2));
  else if (coupon.type === 'flat') discount = Math.min(subtotal, parseFloat(coupon.value));

  // Founder #13: "10% off upto ₹50" — percent coupons can carry a rupee cap.
  if (coupon.type === 'percent' && coupon.max_discount_inr) {
    discount = Math.min(discount, parseFloat(coupon.max_discount_inr));
  }

  // Record the use (idempotent on coupon + customer + day to limit abuse)
  return { coupon, discountInr: discount };
}

async function createForBusiness(businessId, { code, type, value, maxDiscountInr, expiresAt, maxRedemptions }) {
  try {
    const r = await query(
      `INSERT INTO coupons
         (code, type, value, applies_to, status, business_id,
          max_discount_inr, expires_at, max_redemptions)
       VALUES ($1, $2, $3, 'food_order', 'active', $4, $5, $6, $7)
       RETURNING *`,
      [
        code.toUpperCase(), type, value, businessId,
        maxDiscountInr ?? null, expiresAt ?? null, maxRedemptions ?? null,
      ]
    );
    return r.rows[0];
  } catch (err) {
    // coupons.code is globally UNIQUE (003) — surface a friendly 400
    // instead of a raw 23505 → 500.
    if (err.code === '23505') throw new BadRequest('Coupon code already exists');
    throw err;
  }
}

// camelCase API fields → coupons columns. Only fields an owner may edit;
// redemption_count / applies_to / business_id are deliberately untouchable.
const UPDATABLE = {
  code: 'code',
  value: 'value',
  maxDiscountInr: 'max_discount_inr',
  expiresAt: 'expires_at',
  maxRedemptions: 'max_redemptions',
  status: 'status',
};

async function updateForBusiness(businessId, id, patch) {
  // Joi can't see the stored type, so the "percent ≤ 100" rule lives here
  // (flat coupons may legitimately exceed ₹100).
  if (patch.value !== undefined) {
    const t = await query(
      `SELECT type FROM coupons WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (t.rowCount === 0) throw new NotFound('Coupon not found');
    if (t.rows[0].type === 'percent' && parseFloat(patch.value) > 100) {
      throw new BadRequest('Percent value cannot exceed 100');
    }
  }
  const sets = [];
  const args = [];
  for (const [field, col] of Object.entries(UPDATABLE)) {
    if (patch[field] === undefined) continue;
    let v = patch[field];
    if (field === 'code' && v) v = v.toUpperCase();
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  if (sets.length === 0) throw new BadRequest('Nothing to update');
  args.push(id, businessId);
  try {
    // business_id filter = ownership check: platform-wide (NULL) coupons and
    // other tenants' coupons both come back as "not found".
    const r = await query(
      `UPDATE coupons SET ${sets.join(', ')}
        WHERE id = $${args.length - 1} AND business_id = $${args.length}
        RETURNING *`,
      args
    );
    if (r.rowCount === 0) throw new NotFound('Coupon not found');
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new BadRequest('Coupon code already exists');
    throw err;
  }
}

async function deactivate(businessId, id) {
  // Soft delete: keep the row so past orders/redemption history still
  // reference it; ownership enforced like updateForBusiness.
  const r = await query(
    `UPDATE coupons SET status = 'inactive'
      WHERE id = $1 AND business_id = $2
      RETURNING *`,
    [id, businessId]
  );
  if (r.rowCount === 0) throw new NotFound('Coupon not found');
  return r.rows[0];
}

async function recordUse(couponId, orderId) {
  await query(
    `UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = $1`,
    [couponId]
  );
}

module.exports = {
  listForBusiness,
  applyToOrder,
  createForBusiness,
  updateForBusiness,
  deactivate,
  recordUse,
};
