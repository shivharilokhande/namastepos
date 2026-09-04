// Integration tests for /v1/admin/customers/* (super-admin only)

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let ownerToken;
let owner;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'admin-target@example.com', name: 'Admin Target' });
  ownerToken = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

describe('Super-admin customer endpoints', () => {
  it('GET /admin/customers rejects unauthenticated', async () => {
    const r = await request(app).get('/v1/admin/customers');
    expect(r.status).toBe(401);
  });
  it('GET /admin/customers rejects non-super-admin owner token', async () => {
    const r = await request(app).get('/v1/admin/customers')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([401, 403]).toContain(r.status);
  });
  it('GET /admin/customers/:businessId — owner cannot see drilldown', async () => {
    const r = await request(app).get(`/v1/admin/customers/${owner.id}/drilldown`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([401, 403]).toContain(r.status);
  });
});

describe('Super-admin plan endpoints', () => {
  it('GET /admin/plans rejects unauthenticated', async () => {
    const r = await request(app).get('/v1/admin/plans');
    expect([401, 404]).toContain(r.status);
  });
  it('POST /admin/plans rejects non-admin', async () => {
    const r = await request(app).post('/v1/admin/plans')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tier: 'test', name: 'Test', priceInr: 0, tierKind: 'starter' });
    expect([401, 403, 404]).toContain(r.status);
  });
});
