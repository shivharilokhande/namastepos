// Integration tests for /v1/admin/customers/* (super-admin only)

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');

let app;
let ownerToken;
let owner;

// Issue a super-admin token by hand. The admin login flow uses email/password,
// but for these tests we just need a token with role: 'super_admin'.
function adminTokenFor() {
  return issueAccessToken({
    sub: '00000000-0000-0000-0000-000000000001',
    bid: null,
    email: 'admin@namastepos.in',
    role: 'super_admin',
    perms: ['customers.read', 'customers.write', 'plans.read', 'plans.change', 'reports.read'],
  });
}

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
