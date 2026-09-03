// NP-119 / NP-120 (2026-09-03) — strict per-IP limits on public endpoints.
//
//   NP-120: POST /v1/guest/benefit/check/:token can fire a REAL SMS OTP; the
//           shared 100/min tokenLimiter let one IP burn the OTP budget across
//           many phones (otpService's 3/hour cap is per PHONE). Dedicated
//           5/min/IP limiter → the 6th rapid request from the same IP is 429.
//   NP-119: the CSRF-exempt public DPDP POSTs (/v1/compliance/grievance,
//           /consent, /guest-consent) had only the global limiter; now a
//           strict 5/min/IP limiter — 6th rapid request is 429.
//
// express-rate-limit counts EVERY request through the middleware (including
// ones that later 4xx in the controller), and supertest requests all come
// from the same IP — so no valid QR token / grievance body is needed to
// exercise the limiter. Each limiter keys on IP alone, so the two endpoints
// under the compliance limiter share one budget (that's the point).

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, closePool } = require('../setup');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

describe('NP-120: guest OTP-send endpoint is capped at 5/min per IP', () => {
  it('returns 429 on the 6th rapid request from the same IP', async () => {
    const hit = () => request(app)
      .post('/v1/guest/benefit/check/some-bogus-token')
      .send({ phone: '9876543210' });

    for (let i = 0; i < 5; i += 1) {
      const r = await hit();
      expect(r.status).not.toBe(429); // bogus token → 4xx, but not the limiter
    }
    const sixth = await hit();
    expect(sixth.status).toBe(429);
  });
});

describe('NP-119: public DPDP POSTs are capped at 5/min per IP', () => {
  it('returns 429 on the 6th rapid public compliance write from the same IP', async () => {
    const hit = () => request(app)
      .post('/v1/compliance/consent')
      .send({});

    for (let i = 0; i < 5; i += 1) {
      const r = await hit();
      expect(r.status).not.toBe(429);
    }
    const sixth = await hit();
    expect(sixth.status).toBe(429);

    // The budget is shared across the three public writes (same limiter):
    // grievance from the same IP inside the same window is also throttled.
    const grievance = await request(app)
      .post('/v1/compliance/grievance')
      .send({ subject: 'x', description: 'y' });
    expect(grievance.status).toBe(429);
  });
});
