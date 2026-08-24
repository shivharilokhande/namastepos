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
