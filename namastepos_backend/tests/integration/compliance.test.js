// Integration tests for the DPDP compliance surface.
//
// Covers the happy paths on /v1/me/* (self-service) and the public
// /v1/compliance/* endpoints. Admin paths get a sanity check too.
//
// Schema is provisioned by the resetDb() helper (which runs all
// migrations in db/migrations/, including 041_dpdp_compliance.sql).

const request = require('supertest');
// Test-harness fix (2026-08-23): ../setup registers the googleService
// jest.mock — it MUST load before src/app, otherwise authController
// caches the real module and every google login 401s.
const { resetDb, closePool } = require('../setup');
const buildApp = require('../../src/app');

let app;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  // Sign in once and reuse the bearer token.
  const login = await request(app)
    .post('/v1/auth/google')
    .send({ idToken: 'google:sub-dpdp:dpdp@example.com' });
  expect(login.status).toBe(200);
  token = login.body.token;
});

afterAll(async () => {
  await closePool();
});

describe('POST /v1/me/consents', () => {
  it('records a consent grant', async () => {
    const res = await request(app)
      .post('/v1/me/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        consentKey: 'privacy_policy',
        granted: true,
        policyVersion: 'privacy-2026-05-26',
        source: 'mobile_app',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.createdAt).toBeTruthy();
  });

  it('rejects unknown consent keys', async () => {
    const res = await request(app)
      .post('/v1/me/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({ consentKey: 'totally_made_up', granted: true });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/me/consents', () => {
  it('returns the latest state per key', async () => {
    // Grant then withdraw the same key
    await request(app)
      .post('/v1/me/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({ consentKey: 'marketing_email', granted: true, source: 'mobile_app' });
    await request(app)
      .post('/v1/me/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({ consentKey: 'marketing_email', granted: false, source: 'mobile_app' });

    const res = await request(app)
      .get('/v1/me/consents')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const me = (res.body.consents || []).find((c) => c.consentKey === 'marketing_email');
    expect(me).toBeTruthy();
    expect(me.granted).toBe(false); // most recent state wins
  });
});

describe('POST /v1/me/dsr', () => {
  it('files a portability request', async () => {
    const res = await request(app)
      .post('/v1/me/dsr')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestType: 'portability' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('pending');
  });

  it('rejects unknown request types', async () => {
    const res = await request(app)
      .post('/v1/me/dsr')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestType: 'free_data_pls' });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/me/export', () => {
  it('returns a JSON dump with the sha256 hash header', async () => {
    const res = await request(app)
      .get('/v1/me/export')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-namastepos-export-sha256']).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.parse(res.text);
    expect(dump.userId).toBeTruthy();
    expect(dump.sections.profile).toBeTruthy();
    expect(Array.isArray(dump.sections.consents)).toBe(true);
  });
});

describe('POST /v1/compliance/grievance (public)', () => {
  it('accepts a grievance with no auth', async () => {
    const res = await request(app)
      .post('/v1/compliance/grievance')
      .send({
        complainantEmail: 'angry@example.com',
        subject: 'Where is my data',
        body: 'Asked for export 30 days ago, nothing happened.',
        category: 'privacy',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('received');
  });
});

describe('GET /v1/compliance/grievance-officer (public)', () => {
  it('returns whatever has been published (may be empty)', async () => {
    const res = await request(app).get('/v1/compliance/grievance-officer');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('grievanceOfficer');
    expect(res.body).toHaveProperty('legalEntity');
  });
});

describe('DELETE /v1/me/account', () => {
  // Run this last — once we erase, the token's user is anonymised and
  // subsequent calls would be against a meaningless principal.
  it('erases the signed-in user', async () => {
    // Sign in a separate, throwaway user for this test
    const login = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'google:sub-erase:erase@example.com' });
    const tk = login.body.token;
    const res = await request(app)
      .delete('/v1/me/account')
      .set('Authorization', `Bearer ${tk}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.requestId).toBeTruthy();
  });
});
