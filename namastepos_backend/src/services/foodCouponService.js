// Food-order coupons (FF-1701) — separate from subscription coupons.
// Reuses the existing `coupons` table with applies_to = 'food_order' or 'both'.

const { query, withTransaction } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

async function listForBusiness(businessId, { activeOnly = true } = {}) {
  const where = [`applies_to IN ('food_order','both')`];
  if (activeOnly) where.push(`status = 'active'`);
  const r = await query(
    `SELECT * FROM coupons WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT 200`
  );
  return r.rows;
}

async function applyToOrder(businessId, { code, subtotal, customerId }) {
  const c = await query(
    `SELECT * FROM coupons WHERE code = $1 LIMIT 1`,
    [code.toUpperCase()]
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

  // Record the use (idempotent on coupon + customer + day to limit abuse)
  return { coupon, discountInr: discount };
}

async function recordUse(couponId, orderId) {
  await query(
    `UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = $1`,
    [couponId]
  );
}

module.exports = { listForBusiness, applyToOrder, recordUse };
