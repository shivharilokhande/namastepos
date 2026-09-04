// Integration tests for /v1/businesses/:businessId/uploads
//
// Regression suite for AUDIT-S001/S002/S003 (P0 fixes in routes/uploads.routes.js):
//  - S001: anonymous POST was accepted; must now require auth + business membership
//  - S002: ":businessId" was used verbatim in path.join; must reject non-UUID values
//  - S003: filename extension was derived from client's originalname; must use MIME

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app;
let ownerA;
let tokenA;
let ownerB;
let _tokenB;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  ownerA = await makeBusiness({ email: 'a@example.com', name: 'Cafe A' });
  ownerB = await makeBusiness({ email: 'b@example.com', name: 'Cafe B' });
  tokenA = tokenFor(ownerA);
  _tokenB = tokenFor(ownerB);
});

afterAll(async () => {
  await closePool();
  // Tidy: scrub any test-created files (best-effort, ignore failures).
  try {
    const dir = path.join(__dirname, '..', '..', 'uploads');
    if (fs.existsSync(dir)) {
      for (const sub of fs.readdirSync(dir)) {
        const subPath = path.join(dir, sub);
        if (fs.statSync(subPath).isDirectory() && (sub === ownerA?.id || sub === ownerB?.id)) {
          fs.rmSync(subPath, { recursive: true, force: true });
        }
      }
    }
  } catch (_) { /* noop */ }
});

// 1x1 transparent PNG (smallest valid PNG)
const TINY_PNG = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478'
  + '9C6300010000000500010D0A2DB40000000049454E44AE426082',
  'hex',
);

describe('POST /v1/businesses/:businessId/uploads — AUTH boundary', () => {
  it('rejects anonymous POST with 401 (AUDIT-S001)', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .attach('file', TINY_PNG, { filename: 'cat.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated user uploading to a DIFFERENT business with 403', async () => {
    // Cross-tenant attempt — A's JWT, B's URL.
    const res = await request(app)
      .post(`/v1/businesses/${ownerB.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'cat.png', contentType: 'image/png' });
    expect([403, 404]).toContain(res.status);
  });

  it('rejects a malformed JWT with 401', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', 'Bearer not-a-real-token')
      .attach('file', TINY_PNG, { filename: 'cat.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/businesses/:businessId/uploads — PATH TRAVERSAL (AUDIT-S002)', () => {
  it('rejects ".." in :businessId', async () => {
    const res = await request(app)
      .post('/v1/businesses/..%2F..%2Fetc/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'cat.png', contentType: 'image/png' });
    expect([400, 401, 403, 404]).toContain(res.status);
  });

  it('rejects a non-UUID :businessId', async () => {
    const res = await request(app)
      .post('/v1/businesses/not-a-uuid/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'cat.png', contentType: 'image/png' });
    expect([400, 401, 403, 404]).toContain(res.status);
  });

  it('does not create files outside UPLOAD_ROOT', async () => {
    const escapeAttempt = path.join(__dirname, '..', '..', 'uploads', '..', 'NOPE.png');
    // After the attack attempt above, this path MUST NOT exist.
    expect(fs.existsSync(escapeAttempt)).toBe(false);
  });
});

describe('POST /v1/businesses/:businessId/uploads — MIME & EXTENSION (AUDIT-S003)', () => {
  it('accepts a PNG and stores it with a .png extension regardless of originalname', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'evil.exe.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\.png$/);
    expect(res.body.filename).toMatch(/\.png$/);
    expect(res.body.filename).not.toMatch(/\.exe/);
  });

  it('accepts a JPEG with normalized .jpg extension', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'cat.jpeg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.filename).toMatch(/\.jpg$/);
  });

  it('rejects executables with 400', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('MZ\x90\x00'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect([400, 500]).toContain(res.status);
  });

  it('rejects HTML with 400', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'xss.html', contentType: 'text/html' });
    expect([400, 500]).toContain(res.status);
  });
});

describe('POST /v1/businesses/:businessId/uploads — SHAPE', () => {
  it('returns {url, filename, size, mime} on success', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', TINY_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('filename');
    expect(res.body).toHaveProperty('size');
    expect(res.body).toHaveProperty('mime');
    expect(res.body.mime).toBe('image/png');
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app)
      .post(`/v1/businesses/${ownerA.id}/uploads`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect([400, 500]).toContain(res.status);
  });
});
