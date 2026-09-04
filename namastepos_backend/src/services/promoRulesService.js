// NamastePOS — Promo-code rules engine (FF-329).
//
// Extends the existing `coupons` table with rule columns:
//   • rule_type: 'flat' | 'first_order' | 'happy_hour' | 'min_basket'
//   • min_basket_inr
//   • happy_hour_from / happy_hour_to (time-of-day window)
//   • max_uses_per_customer
//
// `evaluate({code, businessId, customerId, orderSubtotalInr})`
// returns {ok, discountInr, reason} — the POS + guest checkout call
// this before applying the discount.

const { query } = require('../config/db');

async function evaluate({ code, businessId, customerId, orderSubtotalInr }) {
  const r = await query(
    `SELECT * FROM coupons
      WHERE business_id = $1
        AND code = $2
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [businessId, code.trim().toUpperCase()],
  );
  if (r.rowCount === 0) return { ok: false, reason: 'INVALID_CODE' };
  const c = r.rows[0];

  // 1. Min-basket gate — applies to any rule type.
  if (c.min_basket_inr && orderSubtotalInr < parseFloat(c.min_basket_inr)) {
    return { ok: false,
      reason: 'MIN_BASKET_NOT_MET',
      message: `Order must be at least ₹${c.min_basket_inr}` };
  }

  // 2. Happy hour — only valid inside the time window.
  if (c.rule_type === 'happy_hour') {
    if (c.happy_hour_from && c.happy_hour_to) {
      const now = new Date();
      const hhmm = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      if (hhmm < c.happy_hour_from || hhmm > c.happy_hour_to) {
        return { ok: false,
          reason: 'OUTSIDE_HAPPY_HOUR',
          message: `Only valid between ${c.happy_hour_from}-${c.happy_hour_to}` };
      }
    }
  }

  // 3. First-order — customer must have zero prior collected orders.
  if (c.rule_type === 'first_order') {
    if (!customerId) return { ok: false, reason: 'CUSTOMER_REQUIRED' };
    const prev = await query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE business_id = $1 AND customer_id = $2 AND status = 'collected'`,
      [businessId, customerId],
    );
    if (prev.rows[0].n > 0) {
      return { ok: false, reason: 'NOT_FIRST_ORDER' };
    }
  }

  // 4. Per-customer usage cap.
  if (c.max_uses_per_customer && customerId) {
    const used = await query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE business_id = $1 AND customer_id = $2 AND coupon_code = $3`,
      [businessId, customerId, c.code],
    );
    if (used.rows[0].n >= c.max_uses_per_customer) {
      return { ok: false, reason: 'MAX_USES_REACHED' };
    }
  }

  // 5. Compute the discount amount.
  let discount;
  if (c.discount_type === 'percentage') {
    discount = orderSubtotalInr * (parseFloat(c.discount_value) / 100);
    if (c.max_discount_inr) discount = Math.min(discount, parseFloat(c.max_discount_inr));
  } else {
    discount = parseFloat(c.discount_value);
  }
  discount = Math.min(discount, orderSubtotalInr);

  return { ok: true, discountInr: Math.round(discount * 100) / 100, code: c.code };
}

module.exports = { evaluate };
