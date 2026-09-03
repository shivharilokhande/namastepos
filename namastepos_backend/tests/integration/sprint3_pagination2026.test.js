// Sprint 3 (2026-09-03) — NP-128 expense pagination + NP-132 channel counts.
//
// NP-128: GET /expenses must respect limit/offset (default 50, max 200) and
//         return `total` = full match count, page-independent.
// NP-132: GET /orders must return channelCounts {all, online, offline}
//         computed over ALL rows matching the status/date filter — the
//         dashboard chips used to count only the fetched page.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app, business, token, itemId;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: 'sprint3@example.com' });
  token = tokenFor(business);
  const m = await request(app)
    .post(`/v1/businesses/${business.id}/menu`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Vada Pav', price: 20, stock: 1000 });
  itemId = m.body.item.id;
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('NP-128 — expense list pagination', () => {
  beforeAll(async () => {
    // 5 expenses on distinct dates so `ORDER BY date DESC` is deterministic:
    // amounts 10..50 on 2020-01-01..05 (amount = 10 × day).
    for (let day = 1; day <= 5; day++) {
      const r = await request(app)
        .post(`/v1/businesses/${business.id}/expenses`)
        .set(auth())
        .send({ category: 'other', amount: 10 * day, date: `2020-01-0${day}` });
      expect(r.status).toBe(201);
    }
  });

  const range = 'startDate=2020-01-01&endDate=2020-01-31';

  it('respects limit and returns the full total', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/expenses?${range}&limit=2&offset=0`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.expenses.length).toBe(2);
    expect(r.body.count).toBe(2);
    expect(r.body.total).toBe(5);
    // date DESC → newest first: Jan 5 (50), Jan 4 (40).
    expect(r.body.expenses.map((e) => e.amount)).toEqual([50, 40]);
  });

  it('respects offset (page 2) with the same total', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/expenses?${range}&limit=2&offset=2`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.expenses.map((e) => e.amount)).toEqual([30, 20]);
    expect(r.body.total).toBe(5);
  });

  it('no limit sent → FULL list (fielded mobile builds SUM this for P&L)', async () => {
    // Review fix: no default limit — old clients (mobile monthly P&L) must
    // keep receiving every row in the window, `expenses` + `count` intact.
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/expenses?${range}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.expenses.length).toBe(5);
    expect(r.body.count).toBe(5);
    expect(r.body.total).toBe(5);
  });

  it('rejects a limit above the 200 cap', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/expenses?${range}&limit=500`)
      .set(auth());
    expect(r.status).toBe(400);
  });
});

describe('NP-132 — per-channel order counts reflect all pages', () => {
  beforeAll(async () => {
    // 7 pending orders across channels: offline = 2 dineIn + 1 takeaway (3),
    // online = 2 zomato + 1 swiggy + 1 other (4; 'other' counts as online —
    // guest QR / Dunzo, same bucket rule as the channel=online filter).
    const sources = ['dineIn', 'dineIn', 'takeaway', 'zomato', 'zomato', 'swiggy', 'other'];
    for (const source of sources) {
      const r = await request(app)
        .post(`/v1/businesses/${business.id}/orders`)
        .set(auth())
        .send({
          source,
          items: [{ menuItemId: itemId, name: 'Vada Pav', price: 20, qty: 1 }],
          paymentMethod: 'cash',
        });
      expect(r.status).toBe(201);
    }
  });

  it('returns channelCounts over the whole set, not just page 1', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders?status=pending&limit=2&offset=0`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBe(2); // one page…
    expect(r.body.total).toBe(7);
    // …but the chips see every page.
    expect(r.body.channelCounts).toEqual({ all: 7, online: 4, offline: 3 });
  });

  it('keeps the same channelCounts on later pages', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders?status=pending&limit=2&offset=4`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.channelCounts).toEqual({ all: 7, online: 4, offline: 3 });
  });

  it('reports all buckets even when a channel filter narrows the page', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders?status=pending&channel=online&limit=50`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBe(4);
    expect(r.body.total).toBe(4); // pagination total follows the filter…
    // …while the chips still describe every bucket of the status tab.
    expect(r.body.channelCounts).toEqual({ all: 7, online: 4, offline: 3 });
  });
});
