// NP-401 regression tests (2026-09-04) — GENERIC REQUEST IDEMPOTENCY.
//
// THE BUG THIS LOCKS DOWN
// The Flutter offline outbox replays a queued write until it gets a 2xx. Until
// now only three mutations tolerated that: order-create (orders.client_id),
// expenses (expenses.client_key) and membership subscribe
// (membership_subscriptions.client_key). Every other queued write double-
// applied whenever the server COMMITTED and only the response was lost — a
// timeout, the app being killed, the wifi dropping between request and reply.
// Stock decremented twice, refunds paid twice, points granted twice.
//
// The fix is one dedup table (migration 085) behind one middleware
// (src/middleware/idempotent.js), applied per route.
//
// THE CONTRACT ASSERTED BELOW
//   same key      → the stored response is replayed verbatim and the side
//                   effect runs EXACTLY ONCE (asserted against a real
//                   countable effect: menu_items.stock and the
//                   inventory_transactions ledger, not just the response body)
//   different key → a genuine second request; the effect runs again
//   no key        → byte-for-byte the old behaviour, gate never engages
//   handler error → the claim is RELEASED, so a real retry can actually retry
//                   (the razorpayService.handleWebhook pattern)
//   in flight     → 409 + Retry-After, never a 2xx (acking early would let the
//                   client drop a write the winner may still roll back)
//   tenant scoped → the same key for two businesses runs twice; a key can
//                   never suppress another restaurant's write

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');

let app;
let bizA;
let tokenA;
let bizB;
let tokenB;
let itemA;
let itemB;

const KEY_HEADER = 'Idempotency-Key';

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  bizA = await makeBusiness({ email: `idem-a-${Date.now()}` });
  tokenA = tokenFor(bizA);
  bizB = await makeBusiness({ email: `idem-b-${Date.now()}` });
  tokenB = tokenFor(bizB);
});

afterAll(async () => { await closePool(); });

const authA = () => ({ Authorization: `Bearer ${tokenA}` });
const authB = () => ({ Authorization: `Bearer ${tokenB}` });

/** A fresh dish per test — every case here moves stock, so sharing would couple them. */
async function makeItem(biz, token, name, stock = 100) {
  const r = await request(app)
    .post(`/v1/businesses/${biz.id}/menu`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ name, price: 60, stock });
  expect(r.status).toBe(201);
  return r.body.item.id;
}

async function stockOf(biz, itemId) {
  const r = await query(
    'SELECT stock FROM menu_items WHERE business_id = $1 AND id = $2',
    [biz.id, itemId],
  );
  return parseFloat(r.rows[0].stock);
}

/** The ledger is the second countable effect — a double-apply writes two rows. */
async function ledgerCount(biz, itemId) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM inventory_transactions
      WHERE business_id = $1 AND menu_item_id = $2`,
    [biz.id, itemId],
  );
  return r.rows[0].n;
}

async function keyRows(biz) {
  const r = await query(
    'SELECT key, endpoint, status_code FROM idempotency_keys WHERE business_id = $1',
    [biz.id],
  );
  return r.rows;
}

const stockUrl = (biz, itemId) => `/v1/businesses/${biz.id}/menu/${itemId}/stock`;

describe('idempotency middleware — the same key runs the side effect once', () => {
  beforeAll(async () => { itemA = await makeItem(bizA, tokenA, 'Idem Dosa'); });

  it('replays the stored response and moves stock exactly once', async () => {
    const key = 'e1a1c2d3-4f5b-6a7c-8d9e-0f1a2b3c4d51';
    const body = { delta: 10, reason: 'purchase', note: 'received 10' };

    const first = await request(app)
      .put(stockUrl(bizA, itemA)).set(authA()).set(KEY_HEADER, key)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.item.stock).toBe(110);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    // The retry the outbox would send after a lost response.
    const second = await request(app)
      .put(stockUrl(bizA, itemA)).set(authA()).set(KEY_HEADER, key)
      .send(body);

    // Same status, same body — a verbatim replay, flagged as such.
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');

    // THE POINT: the countable effect happened ONCE, not twice.
    expect(await stockOf(bizA, itemA)).toBe(110);
    expect(await ledgerCount(bizA, itemA)).toBe(1);
  });

  it('replays for a third and fourth attempt too (not just the first retry)', async () => {
    const key = 'e1a1c2d3-4f5b-6a7c-8d9e-0f1a2b3c4d51'; // same key as above
    const body = { delta: 10, reason: 'purchase', note: 'received 10' };
    await request(app)
      .put(stockUrl(bizA, itemA)).set(authA()).set(KEY_HEADER, key)
      .send(body);
    await request(app)
      .put(stockUrl(bizA, itemA)).set(authA()).set(KEY_HEADER, key)
      .send(body);
    expect(await stockOf(bizA, itemA)).toBe(110);
    expect(await ledgerCount(bizA, itemA)).toBe(1);
  });

  it('a DIFFERENT key is a genuine second request and runs again', async () => {
    const body = { delta: 10, reason: 'purchase' };
    const r = await request(app)
      .put(stockUrl(bizA, itemA)).set(authA())
      .set(KEY_HEADER, 'aaaaaaaa-0000-4000-8000-000000000002')
      .send(body);
    expect(r.status).toBe(200);
    expect(await stockOf(bizA, itemA)).toBe(120);
    expect(await ledgerCount(bizA, itemA)).toBe(2);
  });
});

describe('no key → exactly the old behaviour (back-compat)', () => {
  it('two identical un-keyed calls both apply, and nothing is recorded', async () => {
    const item = await makeItem(bizA, tokenA, 'No Key Vada', 50);
    const body = { delta: -5, reason: 'waste' };
    const before = (await keyRows(bizA)).length;

    const r1 = await request(app).put(stockUrl(bizA, item)).set(authA()).send(body);
    const r2 = await request(app).put(stockUrl(bizA, item)).set(authA()).send(body);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotency-replayed']).toBeUndefined();

    // Both applied — the gate never engaged.
    expect(await stockOf(bizA, item)).toBe(40);
    expect(await ledgerCount(bizA, item)).toBe(2);
    // And no dedup row was written for an un-keyed request.
    expect((await keyRows(bizA)).length).toBe(before);
  });

  it('rejects a key that is present but too short to be a real key', async () => {
    const item = await makeItem(bizA, tokenA, 'Short Key Idli', 20);
    const r = await request(app)
      .put(stockUrl(bizA, item)).set(authA()).set(KEY_HEADER, 'x')
      .send({ delta: 1 });
    // Silently ignoring it would leave the client believing it is protected.
    expect(r.status).toBe(400);
    expect(await stockOf(bizA, item)).toBe(20);
  });
});

describe('a handler error RELEASES the claim so a genuine retry succeeds', () => {
  it('404 first, then the same key succeeds and applies once', async () => {
    const key = 'bbbbbbbb-0000-4000-8000-000000000003';
    const endpoint = 'PUT /menu/:itemId/stock';
    const ghostItem = '00000000-0000-4000-8000-0000000000ff';

    // The handler throws (NotFound from menuService.adjustStock) — the write
    // never happened, so the key MUST NOT be left claimed.
    const failed = await request(app)
      .put(stockUrl(bizA, ghostItem)).set(authA()).set(KEY_HEADER, key)
      .send({ delta: 7, reason: 'purchase' });
    expect(failed.status).toBe(404);

    const held = (await keyRows(bizA)).filter((k) => k.key === key && k.endpoint === endpoint);
    expect(held).toHaveLength(0); // released, exactly like the webhook path does

    // The real retry (the cashier picked the right dish) now goes through.
    const item = await makeItem(bizA, tokenA, 'Retry Poori', 30);
    const ok = await request(app)
      .put(stockUrl(bizA, item)).set(authA()).set(KEY_HEADER, key)
      .send({ delta: 7, reason: 'purchase' });
    expect(ok.status).toBe(200);
    expect(await stockOf(bizA, item)).toBe(37);
    expect(await ledgerCount(bizA, item)).toBe(1);
  });
});

describe('a second attempt while the first is still in flight gets 409', () => {
  it('409 + Retry-After, and NO duplicate side effect', async () => {
    const key = 'cccccccc-0000-4000-8000-000000000004';
    const endpoint = 'PUT /menu/:itemId/stock';
    const item = await makeItem(bizA, tokenA, 'In Flight Uttapam', 60);

    // Stand in for "attempt #1 has claimed the key and is still running":
    // a claimed row with no stored response yet. This is exactly the state the
    // middleware writes before calling the handler.
    await query(
      `INSERT INTO idempotency_keys (business_id, key, endpoint)
       VALUES ($1, $2, $3)`,
      [bizA.id, key, endpoint],
    );

    const r = await request(app)
      .put(stockUrl(bizA, item)).set(authA()).set(KEY_HEADER, key)
      .send({ delta: 99, reason: 'purchase' });

    // Deliberately NOT a 2xx — a 2xx here would let the client mark the write
    // done while the in-flight winner may still fail and roll back.
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('IDEMPOTENT_IN_FLIGHT');
    expect(r.headers['retry-after']).toBeTruthy();

    // The handler never ran.
    expect(await stockOf(bizA, item)).toBe(60);
    expect(await ledgerCount(bizA, item)).toBe(0);
  });
});

describe('keys are tenant-scoped', () => {
  it('the same key for two businesses runs BOTH writes', async () => {
    const key = 'dddddddd-0000-4000-8000-000000000005';
    itemA = await makeItem(bizA, tokenA, 'Shared Key Dosa A', 100);
    itemB = await makeItem(bizB, tokenB, 'Shared Key Dosa B', 100);

    const ra = await request(app)
      .put(stockUrl(bizA, itemA)).set(authA()).set(KEY_HEADER, key)
      .send({ delta: -3, reason: 'waste' });
    const rb = await request(app)
      .put(stockUrl(bizB, itemB)).set(authB()).set(KEY_HEADER, key)
      .send({ delta: -3, reason: 'waste' });

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    // Neither was mistaken for a replay of the other.
    expect(rb.headers['idempotency-replayed']).toBeUndefined();
    expect(await stockOf(bizA, itemA)).toBe(97);
    expect(await stockOf(bizB, itemB)).toBe(97);
  });

  it('the same key on a DIFFERENT endpoint is a different request', async () => {
    // endpoint is part of the primary key on purpose: one outbox row's uuid
    // must never suppress an unrelated mutation that happens to reuse it.
    const key = 'eeeeeeee-0000-4000-8000-000000000006';
    const item = await makeItem(bizA, tokenA, 'Cross Endpoint Chai', 40);

    const stock = await request(app)
      .put(stockUrl(bizA, item)).set(authA()).set(KEY_HEADER, key)
      .send({ delta: 5, reason: 'purchase' });
    expect(stock.status).toBe(200);

    const points = await request(app)
      .post(`/v1/businesses/${bizA.id}/customers/`
        + '00000000-0000-4000-8000-0000000000aa/points')
      .set(authA()).set(KEY_HEADER, key)
      .send({ points: 10 });
    // Whatever this endpoint answers (402 without the loyalty feature, 404 for
    // the ghost customer), the ONE thing it must never be is a replay of the
    // stock adjust above.
    expect(points.status).not.toBe(200);
    expect(points.headers['idempotency-replayed']).toBeUndefined();
    expect(await stockOf(bizA, item)).toBe(45);
  });
});

describe('retention sweep', () => {
  it('deletes keys older than the retention window and keeps fresh ones', async () => {
    const { sweep } = require('../../src/middleware/idempotent');
    const endpoint = 'PUT /menu/:itemId/stock';
    await query(
      `INSERT INTO idempotency_keys (business_id, key, endpoint, status_code, created_at)
       VALUES ($1, $2, $3, 200, NOW() - INTERVAL '30 days')`,
      [bizA.id, 'ffffffff-0000-4000-8000-00000000000f', endpoint],
    );
    const fresh = 'ffffffff-0000-4000-8000-00000000001f';
    await query(
      `INSERT INTO idempotency_keys (business_id, key, endpoint, status_code)
       VALUES ($1, $2, $3, 200)`,
      [bizA.id, fresh, endpoint],
    );

    const out = await sweep(7);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(out.retentionDays).toBe(7);

    const left = (await keyRows(bizA)).map((k) => k.key);
    expect(left).not.toContain('ffffffff-0000-4000-8000-00000000000f');
    expect(left).toContain(fresh);
  });
});
