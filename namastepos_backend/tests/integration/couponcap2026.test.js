// Regression test for food-coupon max_redemptions enforcement (2026-09-01).
// Before this fix, orderService.create never recorded coupon use, so a
// "one-time" coupon (max_redemptions=1) could be redeemed infinitely and
// redemption_count stayed 0.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');

let biz;
let itemId;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `cc-${Date.now()}` });
  const item = await menuService.create(biz.id, { name: 'Samosa', price: 100 });
  itemId = item.id;
});
afterAll(async () => { await closePool(); });

async function makeCoupon(code, maxRedemptions) {
  const r = await query(
    `INSERT INTO coupons (code, type, value, applies_to, status, business_id, max_redemptions)
     VALUES ($1, 'flat', 10, 'food_order', 'active', $2, $3) RETURNING id`,
    [code, biz.id, maxRedemptions],
  );
  return r.rows[0].id;
}

function orderBody(couponCode) {
  return {
    source: 'takeaway',
    items: [{ menuItemId: itemId, name: 'Samosa', price: 100, qty: 1 }],
    discount: 10,
    couponCode,
    paymentMethod: 'cash',
  };
}

async function redemptionCount(couponId) {
  const r = await query('SELECT redemption_count FROM coupons WHERE id = $1', [couponId]);
  return r.rows[0].redemption_count;
}

describe('food-coupon max_redemptions', () => {
  test('a max_redemptions=1 coupon is rejected on the SECOND order', async () => {
    const id = await makeCoupon('ONCE1', 1);

    // First order redeems it — succeeds and increments the counter.
    await orderService.create(biz.id, orderBody('ONCE1'));
    expect(await redemptionCount(id)).toBe(1);

    // Second order with the same code must be rejected (cap reached) and
    // NOT create an order (the whole create txn rolls back).
    await expect(orderService.create(biz.id, orderBody('ONCE1')))
      .rejects.toThrow(/fully redeemed/i);
    expect(await redemptionCount(id)).toBe(1); // unchanged
  });

  test('an uncapped coupon still tracks redemption_count and never rejects', async () => {
    const id = await makeCoupon('MANY', null);
    await orderService.create(biz.id, orderBody('MANY'));
    await orderService.create(biz.id, orderBody('MANY'));
    expect(await redemptionCount(id)).toBe(2);
  });

  test('an unknown coupon code is ignored (order still places)', async () => {
    const o = await orderService.create(biz.id, orderBody('NOPE'));
    expect(o).toBeTruthy();
  });
});
