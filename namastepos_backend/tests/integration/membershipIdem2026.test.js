// NP-116 regression test (2026-09-03): idempotent membership subscribe.
// Before this fix a mobile retry of POST /memberships/subscribe sold the
// membership TWICE — two subscription rows and two wallet debits. The client
// now sends an optional `clientKey` (migration 070: client_key column +
// partial unique index on (business_id, client_key)); a repeat returns the
// stored sale.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const membership = require('../../src/services/membershipService');

let biz;
let planId;
let customerId;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `memidem-${Date.now()}` });
  const plan = await membership.createMembership(biz.id, {
    name: 'Coffee Club', priceInr: 100, validityDays: 30,
  });
  planId = plan.id;
  const c = await query(
    `INSERT INTO customers (business_id, phone, name)
     VALUES ($1, '9876500011', 'Idem Tester') RETURNING id`,
    [biz.id],
  );
  customerId = c.rows[0].id;
  // ₹500 wallet so a wallet-paid sale can debit (and prove it debits ONCE).
  await query(
    `INSERT INTO customer_wallets (business_id, customer_id, balance_paise)
     VALUES ($1, $2, 50000)`,
    [biz.id, customerId],
  );
});
afterAll(async () => { await closePool(); });

async function walletPaise() {
  const r = await query(
    'SELECT balance_paise FROM customer_wallets WHERE business_id = $1 AND customer_id = $2',
    [biz.id, customerId],
  );
  return Number(r.rows[0].balance_paise);
}

describe('membership subscribe idempotency (clientKey)', () => {
  test('same clientKey twice → one membership, one wallet debit, same response', async () => {
    const clientKey = 'a3a3f9d2-7f21-4e57-9a8e-0c5d1b2e3f40';
    const body = {
      customerId, membershipId: planId, paymentMethod: 'wallet', clientKey,
    };
    const first = await membership.subscribe(biz.id, body);
    const second = await membership.subscribe(biz.id, body); // the retry

    // Same sale, same shape — not a second one.
    expect(second.id).toBe(first.id);
    expect(second.amount_paid_paise).toBe(first.amount_paid_paise);
    expect(second.client_key).toBe(clientKey);

    const rows = await query(
      'SELECT id FROM membership_subscriptions WHERE business_id = $1 AND customer_id = $2',
      [biz.id, customerId],
    );
    expect(rows.rowCount).toBe(1); // one membership sold
    expect(await walletPaise()).toBe(40000); // 500 − 100 — debited ONCE
  });

  test('a different clientKey is a genuine new sale', async () => {
    const r = await membership.subscribe(biz.id, {
      customerId,
      membershipId: planId,
      paymentMethod: 'wallet',
      clientKey: 'b4b4f9d2-7f21-4e57-9a8e-0c5d1b2e3f41',
    });
    expect(r.id).toBeTruthy();
    expect(await walletPaise()).toBe(30000); // second real debit
  });
});
