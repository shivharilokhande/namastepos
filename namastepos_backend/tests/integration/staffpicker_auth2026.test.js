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

  it('phone-first staff-resolve stays PRE-LOGIN and never enumerates (200 + [] for unknown)', async () => {
    const r = await request(app)
      .post('/v1/auth/staff-resolve')
      .send({ phone: '9999999999' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.outlets)).toBe(true);
    expect(r.body.outlets).toHaveLength(0);
  });
});
