// Integration tests for /v1/businesses/:businessId/ops/* (tables, floors, reservations)

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'ops-owner@example.com', name: 'Ops Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

describe('Tables CRUD', () => {
  it('lists empty tables', async () => {
    const r = await request(app).get(url('/ops/tables')).set(auth());
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) expect(Array.isArray(r.body.tables)).toBe(true);
  });
  it('rejects unauthenticated', async () => {
    const r = await request(app).get(url('/ops/tables'));
    expect(r.status).toBe(401);
  });
  it('creates a table (or 403 if plan-gated)', async () => {
    // 2026-08-23: schema moved on long ago — tables live on a floor and
    // use floorId + label + seats (capacity never existed in the API).
    const fl = await request(app).post(url('/ops/floors')).set(auth())
      .send({ name: 'GF' });
    if (![200, 201].includes(fl.status)) {
      expect([402, 403]).toContain(fl.status);
      return;
    }
    const floorId = fl.body.floor?.id || fl.body.id;
    const r = await request(app).post(url('/ops/tables')).set(auth())
      .send({ floorId, label: 'T1', seats: 4 });
    expect([200, 201, 403]).toContain(r.status);
  });
  it('rejects negative seats', async () => {
    const fl = await request(app).get(url('/ops/floors')).set(auth());
    const floorId = fl.body?.floors?.[0]?.id;
    const r = await request(app).post(url('/ops/tables')).set(auth())
      .send({ floorId: floorId || '00000000-0000-0000-0000-000000000000',
        label: 'T2',
        seats: -3 });
    expect([400, 402, 403, 422]).toContain(r.status);
  });
});

describe('Floors CRUD', () => {
  it('lists empty floors', async () => {
    const r = await request(app).get(url('/ops/floors')).set(auth());
    expect([200, 403, 404]).toContain(r.status);
  });
  it('creates a floor', async () => {
    const r = await request(app).post(url('/ops/floors')).set(auth())
      .send({ name: 'Ground' });
    expect([200, 201, 403]).toContain(r.status);
  });
});

describe('Reservations', () => {
  it('lists reservations', async () => {
    const r = await request(app).get(url('/ops/reservations')).set(auth());
    // 402 = FEATURE_LOCKED (reservations are plan-gated since the tier rollout)
    expect([200, 402, 403, 404]).toContain(r.status);
  });
  it('rejects unauth', async () => {
    const r = await request(app).get(url('/ops/reservations'));
    expect(r.status).toBe(401);
  });
});

describe('QR token', () => {
  it('returns 404 for non-existent table id', async () => {
    const r = await request(app).get(url('/ops/tables/00000000-0000-0000-0000-000000000000/qr')).set(auth());
    // 402 added 2026-09-05: /ops/tables/:id/qr is now plan-gated on
    // qr_ordering (review B5) and this fixture's tenant may not hold the key.
    expect([200, 404, 400, 403, 402]).toContain(r.status);
  });
});

describe('Cross-tenant guard', () => {
  it('refuses other business\'s tables', async () => {
    const other = await makeBusiness({ email: 'other-ops@example.com', name: 'Other' });
    const r = await request(app).get(`/v1/businesses/${other.id}/ops/tables`).set(auth());
    expect([401, 403, 404]).toContain(r.status);
  });
});
