// FB-17 regression (2026-09-01): the staff PICKER used to be unauthenticated,
// so anyone with a businessId (they appear in QR/deep links) could dump the
// full staff roster — userId + role + display name — and harvest valid userIds
// for PIN brute-forcing. It's now auth-gated. The phone-first /auth/staff-resolve
// remains pre-login (and returns [] for unknown numbers, so no enumeration).

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: `picker-${Date.now()}@example.com`, name: 'Picker Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

describe('POST /v1/auth/staff-picker (FB-17)', () => {
  it('rejects an ANONYMOUS caller (no anonymous roster dump)', async () => {
    const r = await request(app)
      .post('/v1/auth/staff-picker')
      .send({ businessId: owner.id });
    expect(r.status).toBe(401);
    // The roster must NOT be present in an unauthenticated response.
    expect(r.body.staff).toBeUndefined();
  });

  it('allows an AUTHENTICATED caller and returns the staff array', async () => {
    const r = await request(app)
      .post('/v1/auth/staff-picker')
      .set('Authorization', `Bearer ${token}`)
      .send({ businessId: owner.id });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.staff)).toBe(true);
  });

  // NP-102 (2026-09-03): requireAuth alone was not enough — any signed-in
  // tenant could post a FOREIGN businessId and dump that tenant's roster
  // (cross-tenant IDOR). The picker is now scoped to the caller's own bid.
  it('rejects a tenant-A token requesting tenant-B\'s roster (cross-tenant IDOR)', async () => {
    const other = await makeBusiness({ email: `picker-b-${Date.now()}@example.com`, name: 'Picker Other' });
    const r = await request(app)
      .post('/v1/auth/staff-picker')
      .set('Authorization', `Bearer ${token}`) // tenant A's token
      .send({ businessId: other.id });         // tenant B's roster
    expect(r.status).toBe(403);
    expect(r.body.staff).toBeUndefined();
  });

  it('rejects a STAFF token requesting a foreign roster too (same bid check)', async () => {
    const other = await makeBusiness({ email: `picker-c-${Date.now()}@example.com`, name: 'Picker Staff' });
    const { issueAccessToken } = require('../../src/utils/jwt');
    // Staff tokens carry the same bid claim as owner tokens (single issuance path).
    const staffToken = issueAccessToken({
      sub: owner._owner?.id || owner.id, bid: owner.id,
      email: `staff-${Date.now()}@example.com`, role: 'staff',
    });
    const r = await request(app)
      .post('/v1/auth/staff-picker')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ businessId: other.id });
    expect(r.status).toBe(403);
    expect(r.body.staff).toBeUndefined();
  });

  it('rejects a token WITHOUT a businessId claim (super-admin-shaped) — roster access belongs on the admin surface', async () => {
    const { issueAccessToken } = require('../../src/utils/jwt');
    const noBidToken = issueAccessToken({
      sub: owner._owner?.id || owner.id,
      email: `nobid-${Date.now()}@example.com`, role: 'super_admin',
    });
    const r = await request(app)
      .post('/v1/auth/staff-picker')
      .set('Authorization', `Bearer ${noBidToken}`)
      .send({ businessId: owner.id });
    expect([401, 403]).toContain(r.status);
    expect(r.body.staff).toBeUndefined();
  });

  it('phone-first staff-resolve stays PRE-LOGIN and never enumerates (200 + [] for unknown)', async () => {
    const r = await request(app)
      .post('/v1/auth/staff-resolve')
      .send({ phone: '9999999999' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.outlets)).toBe(true);
    expect(r.body.outlets).toHaveLength(0);
  });
});
