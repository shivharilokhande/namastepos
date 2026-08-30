// Regression tests for the 2026-08-30 money/inventory P0/P1 fixes.
// Locks in: Razorpay charge does NOT resurrect a cancelled subscription +
// invoice numbers come from the DB sequence; order cancel restores raw
// ingredient stock (not just dish stock).

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');

const razorpayService = require('../../src/services/razorpayService');
const orderService = require('../../src/services/orderService');
const menuService = require('../../src/services/menuService');
const ingredientService = require('../../src/services/ingredientService');
const recipeService = require('../../src/services/recipeService');

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closePool(); });

describe('Razorpay: cancelled subscription is not resurrected by a charge', () => {
  it('records the payment but keeps the sub cancelled, with a sequence invoice no', async () => {
    const biz = await makeBusiness({ email: `rzp-${Date.now()}` });
    // Point the 'pro' plan at a fake Razorpay plan id.
    await query(`UPDATE plans SET razorpay_plan_id = 'plan_TEST' WHERE tier = 'pro'`);
    const freePlan = (await query(`SELECT id FROM plans WHERE tier = 'free'`)).rows[0];
    // Seed a CANCELLED subscription bound to a gateway sub id.
    await query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, cancel_at_period_end, cancelled_at,
          razorpay_subscription_id)
       VALUES ($1, $2, 'cancelled', TRUE, NOW(), 'sub_TEST')`,
      [biz.id, freePlan.id]
    );

    await razorpayService.handleWebhook({
      id: `evt-${Date.now()}`,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_TEST', plan_id: 'plan_TEST',
          current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
        payment: { entity: { id: `pay-${Date.now()}`, amount: 29900, method: 'upi' } },
      },
    });

    const sub = (await query(
      `SELECT status FROM subscriptions WHERE business_id = $1`, [biz.id]
    )).rows[0];
    expect(sub.status).toBe('cancelled'); // guard held — NOT reactivated

    const inv = (await query(
      `SELECT number, amount_paise FROM invoices WHERE business_id = $1`, [biz.id]
    )).rows[0];
    expect(inv).toBeTruthy();                 // payment still recorded
    expect(inv.amount_paise).toBe(29900);
    expect(inv.number).toMatch(/^INV-\d{4}-\d{6,}$/); // DB-sequence number
  });
});

describe('Guest path: membership bundle only spent when benefits allowed', () => {
  it('does NOT decrement a member bundle when allowMemberBenefits is false', async () => {
    const biz = await makeBusiness({ email: `mb-${Date.now()}` });
    const phone = '9812300000';
    const item = await menuService.create(biz.id, { name: 'Cold Coffee', price: 150 });
    const cust = (await query(
      `INSERT INTO customers (business_id, phone, name) VALUES ($1,$2,'Member') RETURNING id`,
      [biz.id, phone]
    )).rows[0];
    const mem = (await query(
      `INSERT INTO memberships (business_id, name, price_paise) VALUES ($1,'Coffee Club',500000) RETURNING id`,
      [biz.id]
    )).rows[0];
    const remaining = JSON.stringify([{ menuItemId: item.id, qty: 5 }]);
    await query(
      `INSERT INTO membership_subscriptions
         (business_id, customer_id, membership_id, expires_at, amount_paid_paise, status, remaining)
       VALUES ($1,$2,$3, NOW() + INTERVAL '30 days', 500000, 'active', $4::jsonb)`,
      [biz.id, cust.id, mem.id, remaining]
    );

    // Guest path (no OTP proof) → benefits NOT applied.
    await orderService.create(biz.id, {
      source: 'other', customerPhone: phone, allowMemberBenefits: false,
      items: [{ menuItemId: item.id, name: 'Cold Coffee', price: 150, qty: 2 }],
    });
    let rem = (await query(
      `SELECT remaining FROM membership_subscriptions WHERE customer_id = $1`, [cust.id]
    )).rows[0].remaining;
    expect(rem[0].qty).toBe(5); // untouched

    // Verified path → benefit honored, bundle counts down.
    await orderService.create(biz.id, {
      source: 'other', customerPhone: phone, allowMemberBenefits: true,
      items: [{ menuItemId: item.id, name: 'Cold Coffee', price: 150, qty: 2 }],
    });
    rem = (await query(
      `SELECT remaining FROM membership_subscriptions WHERE customer_id = $1`, [cust.id]
    )).rows[0].remaining;
    expect(rem[0].qty).toBe(3); // 2 consumed
  });
});

describe('Order cancel restores raw-ingredient stock', () => {
  it('adds ingredient stock back on cancel, not just dish stock', async () => {
    const biz = await makeBusiness({ email: `inv-${Date.now()}` });
    // Recipe deduction (and its restore-on-cancel) is gated by the
    // 'recipe-costing' addon — grant it to this business.
    await query(
      `INSERT INTO business_addons (business_id, addon_id, status, current_period_end)
       SELECT $1, id, 'active', NOW() + INTERVAL '30 days'
         FROM addons WHERE slug = 'recipe-costing'`,
      [biz.id]
    );
    const ing = await ingredientService.create(biz.id, {
      name: 'Paneer', unit: 'kg', stock: 1000, costPerUnitPaise: 5000,
    });
    const item = await menuService.create(biz.id, { name: 'Paneer Tikka', price: 200, stock: 100 });
    await recipeService.setRecipe(biz.id, item.id, [{ ingredientId: ing.id, qty: 2 }]);

    const order = await orderService.create(biz.id, {
      source: 'takeaway',
      items: [{ menuItemId: item.id, name: 'Paneer Tikka', price: 200, qty: 3 }],
    });

    const afterCreate = (await query(
      `SELECT stock FROM ingredients WHERE id = $1`, [ing.id]
    )).rows[0].stock;
    expect(Number(afterCreate)).toBe(1000 - 2 * 3); // 6 consumed

    await query(
      `INSERT INTO cancel_reasons (business_id, code, label, is_active)
       VALUES ($1, 'CUST_REQ', 'Customer request', TRUE)`,
      [biz.id]
    );
    await orderService.updateStatus(biz.id, order.id, 'cancelled', 'test', 'CUST_REQ');

    const afterCancel = (await query(
      `SELECT stock FROM ingredients WHERE id = $1`, [ing.id]
    )).rows[0].stock;
    expect(Number(afterCancel)).toBe(1000); // fully restored
    // And a 'returned' ingredient ledger row exists.
    const ret = (await query(
      `SELECT count(*)::int AS c FROM ingredient_transactions
        WHERE order_id = $1 AND kind = 'reverse'`, [order.id]
    )).rows[0].c;
    expect(ret).toBeGreaterThan(0);
  });
});
