// Regression test for wallet-as-tender auto-apply (2026-08-30).
// Bill 300 → membership bundle covers 200 → due 100. Wallet should cover the
// residual up to its balance (and cashier cap), rest to the chosen method.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');

let biz;
beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `aw-${Date.now()}` });
});
afterAll(async () => { await closePool(); });

// Seed a customer with an active 2-unit bundle on `item` and a wallet balance.
async function seedMember(phone, itemId, walletPaise) {
  const cust = (await query(
    'INSERT INTO customers (business_id, phone, name) VALUES ($1,$2,\'M\') RETURNING id',
    [biz.id, phone],
  )).rows[0];
  const mem = (await query(
    'INSERT INTO memberships (business_id, name, price_paise) VALUES ($1,\'Club\',500000) RETURNING id',
    [biz.id],
  )).rows[0];
  await query(
    `INSERT INTO membership_subscriptions
       (business_id, customer_id, membership_id, expires_at, amount_paid_paise, status, remaining)
     VALUES ($1,$2,$3, NOW() + INTERVAL '30 days', 500000, 'active', $4::jsonb)`,
    [biz.id, cust.id, mem.id, JSON.stringify([{ menuItemId: itemId, qty: 2 }])],
  );
  await query(
    'INSERT INTO customer_wallets (business_id, customer_id, balance_paise) VALUES ($1,$2,$3)',
    [biz.id, cust.id, walletPaise],
  );
  return cust.id;
}

async function walletBal(customerId) {
  return parseInt((await query('SELECT balance_paise FROM customer_wallets WHERE customer_id = $1', [customerId])).rows[0].balance_paise, 10);
}
async function legs(orderId) {
  const r = await query('SELECT method, amount_paise FROM payments WHERE order_id = $1 ORDER BY method', [orderId]);
  return r.rows.map((x) => `${x.method}:${x.amount_paise}`);
}

const cart = (itemId) => ([{ menuItemId: itemId, name: 'Item', price: 100, qty: 3 }]);

describe('Wallet auto-apply after membership', () => {
  it('wallet partially covers the residual; rest to cash', async () => {
    const item = await menuService.create(biz.id, { name: 'Item A', price: 100 });
    const cid = await seedMember('9700000001', item.id, 6000); // ₹60 wallet
    const order = await orderService.create(biz.id, {
      source: 'takeaway',
      customerPhone: '9700000001',
      paymentMethod: 'cash',
      items: cart(item.id),
      autoWallet: true,
    });
    // due after bundle (200 off 300) = 100 → wallet 60 + cash 40
    expect(order.total).toBe(100);
    expect(await walletBal(cid)).toBe(0);
    expect(await legs(order.id)).toEqual(expect.arrayContaining(['wallet:6000', 'cash:4000']));
  });

  it('wallet fully covers the residual; balance left over; no cash leg', async () => {
    const item = await menuService.create(biz.id, { name: 'Item B', price: 100 });
    const cid = await seedMember('9700000002', item.id, 30000); // ₹300 wallet
    const order = await orderService.create(biz.id, {
      source: 'takeaway',
      customerPhone: '9700000002',
      paymentMethod: 'cash',
      items: cart(item.id),
      autoWallet: true,
    });
    // due 100, wallet covers all → wallet 100, ₹200 left, no cash row
    expect(await walletBal(cid)).toBe(20000);
    expect(await legs(order.id)).toEqual(['wallet:10000']);
  });

  it('respects the cashier cap', async () => {
    const item = await menuService.create(biz.id, { name: 'Item C', price: 100 });
    const cid = await seedMember('9700000003', item.id, 30000);
    const order = await orderService.create(biz.id, {
      source: 'takeaway',
      customerPhone: '9700000003',
      paymentMethod: 'upi',
      items: cart(item.id),
      autoWallet: true,
      walletCapInr: 30, // cap ₹30
    });
    // due 100, cap 30 → wallet 30 + upi 70; ₹270 left in wallet
    expect(await walletBal(cid)).toBe(27000);
    expect(await legs(order.id)).toEqual(expect.arrayContaining(['wallet:3000', 'upi:7000']));
  });
});
