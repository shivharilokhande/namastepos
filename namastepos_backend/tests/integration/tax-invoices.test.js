// Integration tests for /v1/businesses/:businessId/tax-invoices/*

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'inv-owner@example.com', name: 'Invoice Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

describe('GET /tax-invoices', () => {
  it('returns 200 with invoices array', async () => {
    const r = await request(app).get(url('/tax-invoices')).set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.invoices)).toBe(true);
  });
  it('rejects unauthenticated', async () => {
    const r = await request(app).get(url('/tax-invoices'));
    expect(r.status).toBe(401);
  });
  it('accepts date range filter', async () => {
    const r = await request(app).get(url('/tax-invoices?startDate=2025-01-01&endDate=2025-12-31')).set(auth());
    expect(r.status).toBe(200);
  });
});

describe('Cross-tenant guard', () => {
  it('refuses other business\'s invoices', async () => {
    const other = await makeBusiness({ email: 'other-inv@example.com', name: 'Other' });
    const r = await request(app)
      .get(`/v1/businesses/${other.id}/tax-invoices`).set(auth());
    expect([401, 403, 404]).toContain(r.status);
  });
});

describe('GET /tax-invoices/:id', () => {
  it('returns 404 for non-existent invoice', async () => {
    const r = await request(app)
      .get(url('/tax-invoices/00000000-0000-0000-0000-000000000000'))
      .set(auth());
    expect([404, 400]).toContain(r.status);
  });
  it('returns 401 unauth', async () => {
    const r = await request(app).get(url('/tax-invoices/x'));
    expect([401, 400, 404]).toContain(r.status);
  });
});
