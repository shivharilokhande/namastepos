// Integration tests for /auth/*

const request = require('supertest');
// Test-harness fix (2026-08-23): ../setup registers the googleService
// jest.mock — it MUST load before src/app, otherwise authController
// caches the real module and every google login 401s.
const { resetDb, closePool } = require('../setup');
const buildApp = require('../../src/app');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});

afterAll(async () => {
  await closePool();
});

describe('POST /v1/auth/google', () => {
  it('creates a new business on first sign-in', async () => {
    const res = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'google:sub-A:newuser@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.business.email).toBe('newuser@example.com');
    // 2026-08-23: API renamed isNew → isNewUser/isNewBusiness long ago;
    // test was stale.
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.isNewBusiness).toBe(true);
  });

  it('reuses the business on second sign-in', async () => {
    const res = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'google:sub-A:newuser@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.isNewBusiness).toBe(false);
  });

  it('rejects bad Google tokens', async () => {
    const res = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'bad' });
    expect(res.status).toBe(401);
  });

  it('rejects missing idToken', async () => {
    const res = await request(app).post('/v1/auth/google').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/auth/me', () => {
  let token;
  beforeAll(async () => {
    const login = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'google:sub-me:me@example.com' });
    token = login.body.token;
  });

  it('returns the current business', async () => {
    const res = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.business.email).toBe('me@example.com');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/v1/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates refresh tokens and issues a new JWT', async () => {
    const login = await request(app)
      .post('/v1/auth/google')
      .send({ idToken: 'google:sub-R:refresh@example.com' });
    const { refreshToken } = login.body;

    const r = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.refreshToken).not.toBe(refreshToken); // rotated

    // old refresh token no longer valid
    const replay = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken });
    expect(replay.status).toBe(401);
  });
});
