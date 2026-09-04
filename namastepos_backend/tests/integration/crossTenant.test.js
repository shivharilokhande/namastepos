// Integration test — cross-tenant isolation (FF-212 + FF-257).
//
// Seeds two businesses, gives each an owner, then attempts to reach
// Business B's data with Business A's token. Every business-scoped
// endpoint must respond 403 FORBIDDEN.
//
// This is the automated companion to `scripts/idor-audit.js` — the
// script hits a live server, this test hits an in-process app so it
// runs on every `npm test`.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let bizA;
let bizB;
let tokA;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  bizA = await makeBusiness({ email: 'ownerA@example.com', name: 'Cafe A' });
  bizB = await makeBusiness({ email: 'ownerB@example.com', name: 'Cafe B' });
  tokA = tokenFor(bizA);
});

afterAll(async () => { await closePool(); });

// Every business-scoped GET we ship. If you add a new one, add it here.
// Note: URL suffix only — the /v1/businesses/:id prefix is prepended in
// the test loop.
const BIZ_GETS = [
  '/orders?groupBy=session',
  '/menu/items',
  '/menu/categories',
  '/menu/modifier-groups',
  '/staff',
  '/expenses',
  '/customers',
  '/reports/pnl',
  '/reports/kpis',
  '/tax-invoices',
  '/billing/subscription',
  '/addons',
  '/ops/tables',
  '/ops/floors',
  '/ops/kot/tickets',
  '/ingredients',
  '/print-jobs/next',
];

describe('Cross-tenant IDOR protection', () => {
  test.each(BIZ_GETS)(
    'Owner A cannot GET %s on Business B',
    async (path) => {
      const res = await request(app)
        .get(`/v1/businesses/${bizB.id}${path}`)
        .set('Authorization', `Bearer ${tokA}`);
      // Accept 403 (forbidden) or 402 (feature-locked before ownership check
      // is reached — both mean "not delivered"). Anything else = leak.
      expect([402, 403]).toContain(res.status);
    },
  );

  test('Owner A cannot POST an order into Business B', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${bizB.id}/orders`)
      .set('Authorization', `Bearer ${tokA}`)
      .send({ source: 'takeaway', items: [] });
    expect([402, 403]).toContain(res.status);
  });

  test('Missing token → 401 across the board', async () => {
    const res = await request(app).get(`/v1/businesses/${bizB.id}/orders`);
    expect(res.status).toBe(401);
  });

  test('Malformed token → 401', async () => {
    const res = await request(app)
      .get(`/v1/businesses/${bizB.id}/orders`)
      .set('Authorization', 'Bearer nope.this.is.bad');
    expect(res.status).toBe(401);
  });
});
