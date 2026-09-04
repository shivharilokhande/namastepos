// Sprint 4 (2026-09-03) — NP-135 delta polling via `updatedSince`.
//
// GET /orders?updatedSince=<ISO ts> must return ONLY orders whose updated_at
// is strictly after the timestamp (create and updateStatus both set
// updated_at = NOW()), so the mobile Orders tab can poll cheaply: an empty
// delta means nothing changed → no 500-row cache rewrite. Omitting the param
// must keep the exact old full-list behaviour.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app; let business; let token; let
  itemId;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: 'sprint4-updatedsince@example.com' });
  token = tokenFor(business);
  const m = await request(app)
    .post(`/v1/businesses/${business.id}/menu`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Misal Pav', price: 60, stock: 1000 });
  itemId = m.body.item.id;
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

const placeOrder = async () => {
  const r = await request(app)
    .post(`/v1/businesses/${business.id}/orders`)
    .set(auth())
    .send({
      source: 'takeaway',
      items: [{ menuItemId: itemId, name: 'Misal Pav', price: 60, qty: 1 }],
      paymentMethod: 'cash',
    });
  expect(r.status).toBe(201);
  return r.body.order;
};

describe('NP-135 — orders list updatedSince delta filter', () => {
  let orderIds;
  let watermark; // max updatedAt after the initial 3 creates

  beforeAll(async () => {
    orderIds = [];
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const o = await placeOrder();
      orderIds.push(o.id);
      if (!watermark || o.updatedAt > watermark) watermark = o.updatedAt;
    }
  });

  it('without updatedSince the full list still comes back (default unchanged)', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders?limit=50`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBe(3);
    expect(r.body.total).toBe(3);
  });

  it('updatedSince = current watermark → empty delta (nothing changed)', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .query({ updatedSince: watermark, limit: 50 })
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders).toEqual([]);
    expect(r.body.count).toBe(0);
  });

  it('a status change bumps updated_at and shows up in the delta — alone', async () => {
    const changedId = orderIds[0];
    const u = await request(app)
      .put(`/v1/businesses/${business.id}/orders/${changedId}/status`)
      .set(auth())
      .send({ status: 'ready' });
    expect(u.status).toBe(200);

    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .query({ updatedSince: watermark, limit: 50 })
      .set(auth());
    expect(r.status).toBe(200);
    // Only the touched order, not the two untouched ones.
    expect(r.body.orders.map((o) => o.id)).toEqual([changedId]);
    expect(r.body.orders[0].status).toBe('ready');
    // Strictly-after: the returned row's own updatedAt is past the watermark,
    // so the client can advance its cursor and the next poll is empty again.
    const next = r.body.orders[0].updatedAt;
    expect(new Date(next) > new Date(watermark)).toBe(true);

    const r2 = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .query({ updatedSince: next, limit: 50 })
      .set(auth());
    expect(r2.status).toBe(200);
    expect(r2.body.orders).toEqual([]);
  });

  it('a new order also lands in the delta', async () => {
    const before = new Date().toISOString();
    const o = await placeOrder();
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .query({ updatedSince: watermark, limit: 50 })
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders.map((x) => x.id)).toContain(o.id);
    // Sanity: it is newer than the pre-create instant too.
    expect(new Date(o.updatedAt) >= new Date(before)).toBe(true);
  });

  it('rejects a malformed updatedSince', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders?updatedSince=not-a-date`)
      .set(auth());
    expect(r.status).toBe(400);
  });
});

// NP-137 follow-up (mig 073) — expense clientKey idempotency.
describe('NP-137 — expense clientKey idempotency', () => {
  it('same clientKey twice → one row, original echoed back', async () => {
    const { randomUUID } = require('crypto');
    const key = randomUUID();
    const body = { category: 'gas', amount: 450, date: '2026-09-03', clientKey: key };
    const r1 = await request(app)
      .post(`/v1/businesses/${business.id}/expenses`).set(auth()).send(body);
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post(`/v1/businesses/${business.id}/expenses`).set(auth()).send(body);
    expect([200, 201]).toContain(r2.status);
    expect(r2.body.expense.id).toBe(r1.body.expense.id); // same row, no dup
    const { query } = require('../../src/config/db');
    const n = (await query(
      'SELECT count(*)::int AS c FROM expenses WHERE business_id = $1 AND client_key = $2',
      [business.id, key],
    )).rows[0].c;
    expect(n).toBe(1);
  });

  it('different keys are genuinely separate expenses', async () => {
    const { randomUUID } = require('crypto');
    const mk = () => ({ category: 'gas', amount: 450, date: '2026-09-03', clientKey: randomUUID() });
    const a = await request(app)
      .post(`/v1/businesses/${business.id}/expenses`).set(auth()).send(mk());
    const b = await request(app)
      .post(`/v1/businesses/${business.id}/expenses`).set(auth()).send(mk());
    expect(a.body.expense.id).not.toBe(b.body.expense.id);
  });
});
