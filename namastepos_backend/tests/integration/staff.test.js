// Integration tests for /v1/businesses/:businessId/staff/*

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let owner;
let token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'staff-owner@example.com', name: 'Staff Test' });
  token = tokenFor(owner);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

describe('GET /staff/pin', () => {
  it('returns 200 with empty list when no staff added', async () => {
    const r = await request(app).get(url('/staff/pin')).set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.staff)).toBe(true);
  });
  it('rejects unauthenticated requests', async () => {
    const r = await request(app).get(url('/staff/pin'));
    expect(r.status).toBe(401);
  });
});

describe('POST /staff/pin', () => {
  it('rejects missing name', async () => {
    const r = await request(app).post(url('/staff/pin')).set(auth())
      .send({ phone: '9000000001', role: 'staff_cashier', pin: '1234' });
    expect([400, 422]).toContain(r.status);
  });
  it('rejects non-4-digit PIN', async () => {
    const r = await request(app).post(url('/staff/pin')).set(auth())
      .send({ displayName: 'Bob', phone: '9000000002', role: 'staff_cashier', pin: '12' });
    expect([400, 422]).toContain(r.status);
  });
  it('creates a staff with valid payload', async () => {
    const r = await request(app).post(url('/staff/pin')).set(auth())
      .send({ displayName: 'Alice', phone: '9000000003', role: 'staff_cashier', pin: '1234' });
    expect([200, 201]).toContain(r.status);
  });
  it('rejects duplicate phone with 409 or 400', async () => {
    await request(app).post(url('/staff/pin')).set(auth())
      .send({ displayName: 'X', phone: '9000000004', role: 'staff_cashier', pin: '1234' });
    const r = await request(app).post(url('/staff/pin')).set(auth())
      .send({ displayName: 'Y', phone: '9000000004', role: 'staff_cashier', pin: '5678' });
    expect([400, 409]).toContain(r.status);
  });
  it('rejects unauthenticated requests', async () => {
    const r = await request(app).post(url('/staff/pin'))
      .send({ displayName: 'Z', phone: '9000000005', role: 'staff_cashier', pin: '1234' });
    expect(r.status).toBe(401);
  });
});

describe('PIN login (public)', () => {
  it('rejects bad business ID', async () => {
    const r = await request(app).post('/v1/auth/staff-picker')
      .send({ businessId: 'not-a-uuid' });
    expect([400, 404]).toContain(r.status);
  });
  it('returns a list of staff for a valid business', async () => {
    const r = await request(app).post('/v1/auth/staff-picker')
      .send({ businessId: owner.id });
    expect([200, 401, 403]).toContain(r.status);
  });
});

// 2026-08-26 — a staffer who works at (or moved between) two NamastePOS
// restaurants. The second owner must be able to add the same phone WITHOUT an
// error, phone-resolve must surface both outlets, and each outlet's own PIN
// must sign in independently. This is the "staff left R1, joined R2" case.
describe('Cross-restaurant staff (phone-first login)', () => {
  const PHONE = '9333000001';
  let owner2;
  let token2;

  beforeAll(async () => {
    owner2 = await makeBusiness({ email: 'staff-owner2@example.com', name: 'Second Kitchen' });
    token2 = tokenFor(owner2);
  });

  it('lets restaurant 1 add the staffer', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${owner.id}/staff/pin`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ displayName: 'Ravi', phone: PHONE, role: 'staff_cashier', pin: '1111' });
    expect([200, 201]).toContain(r.status);
  });

  it('lets restaurant 2 add the SAME phone with no conflict', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${owner2.id}/staff/pin`)
      .set({ Authorization: `Bearer ${token2}` })
      .send({ displayName: 'Ravi', phone: PHONE, role: 'staff_waiter', pin: '2222' });
    expect([200, 201]).toContain(r.status);
  });

  it('staff-resolve returns BOTH outlets for the phone', async () => {
    const r = await request(app).post('/v1/auth/staff-resolve').send({ phone: PHONE });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.outlets)).toBe(true);
    expect(r.body.outlets.length).toBe(2);
    const bizIds = r.body.outlets.map((o) => o.businessId).sort();
    expect(bizIds).toEqual([owner.id, owner2.id].sort());
    r.body.outlets.forEach((o) => {
      expect(o.userId).toBeTruthy();
      expect(o.businessName).toBeTruthy();
    });
  });

  it('each outlet PIN signs in independently', async () => {
    const res = await request(app).post('/v1/auth/staff-resolve').send({ phone: PHONE });
    const o1 = res.body.outlets.find((o) => o.businessId === owner.id);
    const o2 = res.body.outlets.find((o) => o.businessId === owner2.id);

    const l1 = await request(app).post('/v1/auth/pin-login')
      .send({ businessId: owner.id, userId: o1.userId, pin: '1111' });
    expect(l1.status).toBe(200);
    expect(l1.body.token).toBeTruthy();
    expect(l1.body.business.id).toBe(owner.id);

    const l2 = await request(app).post('/v1/auth/pin-login')
      .send({ businessId: owner2.id, userId: o2.userId, pin: '2222' });
    expect(l2.status).toBe(200);
    expect(l2.body.business.id).toBe(owner2.id);

    // R1's PIN must NOT work for the R2 membership.
    const bad = await request(app).post('/v1/auth/pin-login')
      .send({ businessId: owner2.id, userId: o2.userId, pin: '1111' });
    expect([400, 401]).toContain(bad.status);
  });

  it('returns an empty list for an unknown phone (no user enumeration)', async () => {
    const r = await request(app).post('/v1/auth/staff-resolve').send({ phone: '9000999999' });
    expect(r.status).toBe(200);
    expect(r.body.outlets).toEqual([]);
  });
});
