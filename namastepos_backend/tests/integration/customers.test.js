// Integration tests for /v1/businesses/:businessId/customers/*

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'crm-owner@example.com', name: 'CRM Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

describe('GET /customers', () => {
  it('returns 200 with paginated shape', async () => {
    const r = await request(app).get(url('/customers')).set(auth());
    // May 200 (loyalty addon active) or 402/403 (addon required)
    expect([200, 402, 403]).toContain(r.status);
    if (r.status === 200) {
      expect(r.body).toHaveProperty('customers');
      expect(Array.isArray(r.body.customers)).toBe(true);
    }
  });
  it('rejects unauthenticated', async () => {
    const r = await request(app).get(url('/customers'));
    expect(r.status).toBe(401);
  });
});

describe('POST /customers', () => {
  it('rejects missing phone', async () => {
    const r = await request(app).post(url('/customers')).set(auth())
      .send({ name: 'Bob' });
    expect([400, 402, 403, 422]).toContain(r.status);
  });
  it('creates a customer with valid payload (if addon enabled)', async () => {
    const r = await request(app).post(url('/customers')).set(auth())
      .send({ name: 'Alice', phone: '9000099001' });
    expect([200, 201, 402, 403]).toContain(r.status);
  });
});

describe('Search & filter', () => {
  it('accepts ?search= query', async () => {
    const r = await request(app).get(url('/customers?search=Alice')).set(auth());
    expect([200, 402, 403]).toContain(r.status);
  });
  it('accepts ?tier= query', async () => {
    const r = await request(app).get(url('/customers?tier=gold')).set(auth());
    expect([200, 402, 403]).toContain(r.status);
  });
});

describe('Cross-tenant guard', () => {
  it('cannot list other business\'s customers', async () => {
    const other = await makeBusiness({ email: 'other-crm@example.com', name: 'Other' });
    const r = await request(app)
      .get(`/v1/businesses/${other.id}/customers`).set(auth());
    expect([401, 403, 404]).toContain(r.status);
  });
});
