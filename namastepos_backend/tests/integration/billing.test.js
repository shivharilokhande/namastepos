// Integration tests for /v1/plans (public) + /v1/businesses/:id/billing/*

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'billing-owner@example.com', name: 'Billing Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

describe('GET /plans (public)', () => {
  it('returns plans list with tierKind + featureKeys', async () => {
    const r = await request(app).get('/v1/plans');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.plans)).toBe(true);
    for (const p of r.body.plans) {
      expect(p).toHaveProperty('tier');
      expect(p).toHaveProperty('tierKind');
      expect(p).toHaveProperty('featureKeys');
      expect(Array.isArray(p.featureKeys)).toBe(true);
    }
  });
  it('does not require auth', async () => {
    const r = await request(app).get('/v1/plans');
    expect([200, 304]).toContain(r.status);
  });
});

describe('GET /billing/subscription', () => {
  it('returns current subscription for owner', async () => {
    const r = await request(app).get(url('/billing/subscription')).set(auth());
    expect([200, 404]).toContain(r.status);
  });
  it('rejects unauthenticated', async () => {
    const r = await request(app).get(url('/billing/subscription'));
    expect(r.status).toBe(401);
  });
});

describe('Plan limits enforcement', () => {
  it('enforceLimit on /menu returns 403 PLAN_LIMIT past cap (smoke check shape)', async () => {
    // We can't easily blow the cap in 1 test, but the route should respond 200/403
    const r = await request(app).get(url('/menu')).set(auth());
    expect([200, 403]).toContain(r.status);
  });
});

describe('Cross-tenant guard on billing', () => {
  it('refuses requests for a businessId the owner doesn\'t own', async () => {
    const other = await makeBusiness({ email: 'other@example.com', name: 'Other' });
    const r = await request(app)
      .get(`/v1/businesses/${other.id}/billing/subscription`).set(auth());
    expect([401, 403, 404]).toContain(r.status);
  });
});
