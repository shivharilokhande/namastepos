// Security review 2026-09-04 — regression tests for the five-item batch.
//
//   1. Multi-instance cache correctness — membership/admin invalidation now
//      goes through utils/cacheBus instead of waiting out a 30s per-process
//      TTL with no invalidation hook at all.
//   2. Admin auth is httpOnly-cookie ONLY — the Bearer-from-localStorage
//      fallback is gone on both sides.
//   3. Admin TOTP secrets are encrypted with TOTP_ENC_KEY, not a key derived
//      from JWT_SECRET; rows written under the old key still decrypt and are
//      re-encrypted on next successful use.
//   4. The guest membership lookup no longer answers "does this phone have an
//      account here?" differently for members and strangers.
//   5. The QR token verify path pins the signature algorithm.
//
// MUST be set before anything requires src/config/env — Jest gives each test
// file its own module registry, so this only affects this suite.
process.env.TOTP_ENC_KEY = 'test-only-totp-enc-key-not-for-production';

const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');

const buildApp = require('../../src/app');
const cacheBus = require('../../src/utils/cacheBus');
const authMw = require('../../src/middleware/auth');
const staffService = require('../../src/services/staffService');
const qrService = require('../../src/services/qrService');
const tableService = require('../../src/services/tableService');
const twoFactor = require('../../src/services/twoFactorService');
const adminTeam = require('../../src/services/adminTeamService');

let app;
let biz;
let qrToken;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `secbatch-${Date.now()}` });
  const floor = (await query(
    "INSERT INTO floors (business_id, name) VALUES ($1, 'Ground') RETURNING id",
    [biz.id],
  )).rows[0];
  const table = await tableService.createTable(biz.id, { floorId: floor.id, label: 'T1', seats: 4 });
  qrToken = await qrService.issueTokenForTable(biz.id, table.id);
  await query('UPDATE tables SET qr_enabled = TRUE WHERE id = $1', [table.id]);
});
afterAll(async () => { await closePool(); });

// ───────────────────────────────────────────────────────────────────────────
// 1. Cache invalidation
// ───────────────────────────────────────────────────────────────────────────
describe('item 1 — cacheBus delivers invalidations locally with no Redis', () => {
  it('dispatches a published payload to every local subscriber', () => {
    const seen = [];
    const off = cacheBus.subscribe('test:topic', (p) => seen.push(p));
    cacheBus.publish('test:topic', { hello: 'world' });
    expect(seen).toEqual([{ hello: 'world' }]);
    off();
    cacheBus.publish('test:topic', { hello: 'again' });
    expect(seen).toHaveLength(1); // unsubscribed
  });

  it('reports Redis as unconfigured in test (TTL-only fallback, no throw)', () => {
    const s = cacheBus.status();
    expect(s.configured).toBe(false);
    expect(typeof s.instanceId).toBe('string');
  });
});

describe('item 1 — revoked staff lose cached permissions immediately', () => {
  let staffUserId;

  beforeAll(async () => {
    const u = await query(
      `INSERT INTO users (email, phone, display_name, google_sub)
       VALUES ($1, $2, 'Revoke Me', $3) RETURNING id`,
      [`revoke-${Date.now()}@example.com`, null, `sub-revoke-${Date.now()}`],
    );
    staffUserId = u.rows[0].id;
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, 'staff_manager', TRUE)`,
      [biz.id, staffUserId],
    );
  });

  it('caches the membership (this is the behaviour that made staleness possible)', async () => {
    const m = await authMw._currentMembership(staffUserId, biz.id);
    expect(m).not.toBeNull();
    expect(m.role).toBe('staff_manager');

    // Deactivate BEHIND the service layer so nothing invalidates. The cached
    // entry must still be served — that is the 30s window the review was about.
    await query(
      'UPDATE business_users SET is_active = FALSE WHERE business_id = $1 AND user_id = $2',
      [biz.id, staffUserId],
    );
    const stale = await authMw._currentMembership(staffUserId, biz.id);
    expect(stale).not.toBeNull();
    expect(stale.role).toBe('staff_manager');
  });

  it('invalidateMembership(businessId, userId) drops it at once', async () => {
    authMw.invalidateMembership(biz.id, staffUserId);
    const gone = await authMw._currentMembership(staffUserId, biz.id);
    expect(gone).toBeNull();
  });

  it('invalidateMembership(businessId) drops every member of the business', async () => {
    await query(
      'UPDATE business_users SET is_active = TRUE WHERE business_id = $1 AND user_id = $2',
      [biz.id, staffUserId],
    );
    authMw.invalidateMembership(biz.id, staffUserId); // clear the negative entry
    expect(await authMw._currentMembership(staffUserId, biz.id)).not.toBeNull();

    // Deliberately scoped to the staff row so the owner's membership survives
    // for the later suites; the point under test is that the business-wide
    // invalidate form finds entries by businessId suffix, not that the UPDATE
    // touched every row.
    await query(
      'UPDATE business_users SET is_active = FALSE WHERE business_id = $1 AND user_id = $2',
      [biz.id, staffUserId],
    );
    authMw.invalidateMembership(biz.id); // whole-business form (outlet delete)
    expect(await authMw._currentMembership(staffUserId, biz.id)).toBeNull();
  });

  it('staffService.removeStaff invalidates without the caller doing anything', async () => {
    await query(
      'UPDATE business_users SET is_active = TRUE WHERE business_id = $1 AND user_id = $2',
      [biz.id, staffUserId],
    );
    authMw.invalidateMembership(biz.id, staffUserId);
    expect(await authMw._currentMembership(staffUserId, biz.id)).not.toBeNull(); // warm

    await staffService.removeStaff({
      businessId: biz.id, userId: staffUserId, actingUserId: biz._owner.id,
    });
    // No sleep, no TTL wait: the write site published the invalidation.
    expect(await authMw._currentMembership(staffUserId, biz.id)).toBeNull();
  });

  it('staffService.updateRole invalidates so a downgrade bites immediately', async () => {
    await query(
      `UPDATE business_users SET is_active = TRUE, role = 'staff_manager'
        WHERE business_id = $1 AND user_id = $2`,
      [biz.id, staffUserId],
    );
    authMw.invalidateMembership(biz.id, staffUserId);
    expect((await authMw._currentMembership(staffUserId, biz.id)).role).toBe('staff_manager');

    await staffService.updateRole({
      businessId: biz.id, userId: staffUserId, role: 'staff_kitchen',
    });
    expect((await authMw._currentMembership(staffUserId, biz.id)).role).toBe('staff_kitchen');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Admin auth: cookie only
// ───────────────────────────────────────────────────────────────────────────
describe('item 2 — the admin API accepts the ff_admin cookie ONLY', () => {
  let adminToken;
  let adminEmail;
  const ADMIN_PW = 'a-long-admin-password-123';

  beforeAll(async () => {
    adminEmail = `secbatch-admin-${Date.now()}@namastepos.in`;
    await adminTeam.create({
      email: adminEmail, password: ADMIN_PW, displayName: 'SecBatch', role: 'super_admin',
    });
    const login = await adminTeam.login(adminEmail, ADMIN_PW);
    adminToken = login.token;
  });

  it('login sets the httpOnly cookie and does NOT echo the JWT in the body', async () => {
    const r = await request(app)
      .post('/v1/admin/auth/login')
      .send({ email: adminEmail, password: ADMIN_PW });

    expect(r.status).toBe(200);
    expect(r.body.authenticated).toBe(true);
    // The credential must exist only as a cookie the browser manages. A token
    // in the body is reachable by any JS on the page — and a stolen one is
    // replayable from anywhere, because any client can set a Cookie header.
    expect(r.body.token).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('eyJ'); // no JWT anywhere in the body

    const setCookie = [].concat(r.headers['set-cookie'] || []).join('; ');
    expect(setCookie).toMatch(/ff_admin=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });

  it('issues a session token on login (sanity)', () => {
    expect(typeof adminToken).toBe('string');
  });

  it('accepts a valid admin session from the cookie', async () => {
    const r = await request(app)
      .get('/v1/admin/auth/me')
      .set('Cookie', `ff_admin=${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.admin?.role).toBe('super_admin');
  });

  it('REJECTS the same token presented as Authorization: Bearer', async () => {
    // This is the fallback that was removed. An XSS-exfiltratable admin token
    // must have nothing on the server willing to accept it.
    const r = await request(app)
      .get('/v1/admin/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(401);
  });

  it('rejects an unauthenticated admin call', async () => {
    const r = await request(app).get('/v1/admin/auth/me');
    expect(r.status).toBe(401);
  });

  it('still rejects a TENANT token supplied in the admin cookie', async () => {
    const { issueAccessToken } = require('../../src/utils/jwt');
    const tenant = issueAccessToken({
      sub: biz._owner.id, bid: biz.id, email: biz.email, role: 'business_owner',
    });
    const r = await request(app)
      .get('/v1/admin/auth/me')
      .set('Cookie', `ff_admin=${tenant}`);
    expect(r.status).toBe(403); // authenticated, but not a super admin
  });

  it('tenant Bearer auth is untouched by the change', async () => {
    const { issueAccessToken } = require('../../src/utils/jwt');
    const tenant = issueAccessToken({
      sub: biz._owner.id, bid: biz.id, email: biz.email, role: 'business_owner',
    });
    const r = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tenant}`);
    expect(r.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. TOTP key split
// ───────────────────────────────────────────────────────────────────────────
describe('item 3 — admin TOTP secrets use TOTP_ENC_KEY, legacy rows still read', () => {
  async function makeEnrolledAdmin(secretEnc) {
    const r = await query(
      `INSERT INTO admin_users (email, password_hash, role, is_active,
                                totp_secret_enc, totp_enrolled_at)
       VALUES ($1, 'x-not-a-real-hash', 'super_admin', TRUE, $2, NOW())
       RETURNING id`,
      [`totp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@namastepos.in`, secretEnc],
    );
    return r.rows[0].id;
  }

  it('is actually using a different key from JWT_SECRET', () => {
    expect(env.TOTP_ENC_KEY).toBeTruthy();
    expect(env.TOTP_ENC_KEY).not.toBe(env.JWT_SECRET);

    const enc = twoFactor._encrypt('JBSWY3DPEHPK3PXP');
    expect(enc.startsWith(twoFactor.V2_PREFIX)).toBe(true);
    // A v2 ciphertext must NOT be readable with the old JWT-derived key —
    // otherwise the "separation" would be cosmetic.
    const legacyKek = crypto.createHash('sha256').update(env.JWT_SECRET).digest();
    const buf = Buffer.from(enc.slice(twoFactor.V2_PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', legacyKek, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    expect(() => Buffer.concat([d.update(buf.subarray(28)), d.final()])).toThrow();
  });

  it('round-trips a v2 ciphertext', () => {
    const out = twoFactor._decryptAny(twoFactor._encrypt('HELLOSECRET'));
    expect(out).toEqual({ plain: 'HELLOSECRET', legacy: false });
  });

  it('reads a row written under the OLD JWT_SECRET-derived key', () => {
    const legacy = twoFactor._encryptLegacy('LEGACYSECRET');
    expect(legacy.startsWith(twoFactor.V2_PREFIX)).toBe(false);
    expect(twoFactor._decryptAny(legacy)).toEqual({ plain: 'LEGACYSECRET', legacy: true });
  });

  it('completes a 2FA login against a legacy row and re-encrypts it to v2', async () => {
    const b32 = twoFactor._base32Encode(crypto.randomBytes(20));
    const adminId = await makeEnrolledAdmin(twoFactor._encryptLegacy(b32));

    const { challengeId } = await twoFactor.startChallenge(adminId);
    // Compute the live code exactly the way the service does.
    const code = twoFactor._totp(twoFactor._base32Decode(b32));

    const res = await twoFactor.verifyChallenge(challengeId, code);
    expect(res.adminId).toBe(adminId);

    const after = await query('SELECT totp_secret_enc FROM admin_users WHERE id = $1', [adminId]);
    expect(after.rows[0].totp_secret_enc.startsWith(twoFactor.V2_PREFIX)).toBe(true);
    expect(twoFactor._decryptAny(after.rows[0].totp_secret_enc).plain).toBe(b32);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. QR token algorithm pinning  (before item 4 — item 4 spends the rate-limit
//    budget for /guest/benefit/check, so it has to run last.)
// ───────────────────────────────────────────────────────────────────────────
describe('item 5 — QR token verification pins the algorithm', () => {
  it('accepts the legitimately issued HS256 token', async () => {
    const v = await qrService.verifyToken(qrToken);
    expect(v.businessId).toBe(biz.id);
  });

  it('rejects an alg:none token that carries a valid-looking payload', async () => {
    const decoded = jwt.decode(qrToken);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      bid: decoded.bid, tid: decoded.tid, kind: 'qr-menu', iss: 'namastepos-qr',
    })).toString('base64url');
    const forged = `${header}.${body}.`;
    await expect(qrService.verifyToken(forged)).rejects.toThrow(/Invalid QR token/);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const decoded = jwt.decode(qrToken);
    const forged = jwt.sign(
      { bid: decoded.bid, tid: decoded.tid, kind: 'qr-menu' },
      'not-the-real-secret',
      { issuer: 'namastepos-qr', algorithm: 'HS256' },
    );
    await expect(qrService.verifyToken(forged)).rejects.toThrow(/Invalid QR token/);
  });

  it('rejects a validly signed token of the wrong KIND', async () => {
    const decoded = jwt.decode(qrToken);
    const wrongKind = jwt.sign(
      { bid: decoded.bid, tid: decoded.tid, kind: 'something-else' },
      env.JWT_SECRET,
      { issuer: 'namastepos-qr', algorithm: 'HS256' },
    );
    await expect(qrService.verifyToken(wrongKind)).rejects.toThrow(/Wrong token kind/);
  });

  it('the public QR endpoints are behind a limiter (100/min per IP+token)', async () => {
    // Not exhausted here (it would cost 100 requests) — assert the middleware
    // is actually mounted by checking the standard headers it sets.
    const r = await request(app).get(`/v1/guest/menu/${qrToken}`);
    expect(r.headers['ratelimit-limit']).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Guest membership enumeration
//
// NOTE ON BUDGETS: /guest/benefit/check is capped at 5/min per IP by
// otpSendLimiter and supertest requests all share one IP, so this block spends
// exactly 5 allowed calls and then asserts the 6th is throttled. Do not add
// another benefitCheck call to this file without re-counting.
// ───────────────────────────────────────────────────────────────────────────
describe('item 4 — the guest membership lookup is uniform for member vs stranger', () => {
  const MEMBER_PHONE = '9800001111';
  const STRANGER_PHONE = '9800002222';

  beforeAll(async () => {
    const cust = await query(
      'INSERT INTO customers (business_id, phone, name) VALUES ($1, $2, $3) RETURNING id',
      [biz.id, MEMBER_PHONE, 'Member Diner'],
    );
    const mem = await query(
      `INSERT INTO memberships (business_id, name, price_paise, validity_days, benefits)
       VALUES ($1, 'Gold', 100000, 90, '{"discount_pct":10}'::jsonb) RETURNING id`,
      [biz.id],
    );
    await query(
      `INSERT INTO membership_subscriptions
         (business_id, customer_id, membership_id, expires_at, amount_paid_paise,
          status, remaining)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', 100000, 'active',
               '{"items":[]}'::jsonb)`,
      [biz.id, cust.rows[0].id, mem.rows[0].id],
    );
  });

  it('returns a byte-identical response shape for a member and a stranger', async () => {
    const post = (phone) => request(app)
      .post(`/v1/guest/benefit/check/${qrToken}`)
      .send({ phone });

    const member = await post(MEMBER_PHONE); // budget 1/5
    const stranger = await post(STRANGER_PHONE); // budget 2/5

    expect(member.status).toBe(200);
    expect(stranger.status).toBe(member.status);

    // Same keys, same otpRequired value, both carry a requestId — nothing in
    // the body distinguishes "has an account here" from "does not".
    expect(Object.keys(member.body).sort()).toEqual(Object.keys(stranger.body).sort());
    expect(member.body.otpRequired).toBe(true);
    expect(stranger.body.otpRequired).toBe(true);
    expect(typeof member.body.requestId).toBe('string');
    expect(typeof stranger.body.requestId).toBe('string');
    expect(member.body.requestId).not.toBe(stranger.body.requestId);

    // The stranger's id is a decoy: no otp_requests row was created for them,
    // so we never SMS an arbitrary number and never burn their OTP budget.
    const rows = await query('SELECT phone FROM otp_requests WHERE id = $1',
      [stranger.body.requestId]);
    expect(rows.rowCount).toBe(0);
  });

  it('verify answers every failure identically (decoy id vs wrong code)', async () => {
    // Seeded directly so this test does not spend the check budget.
    const hash = await bcrypt.hash('123456', 8);
    const real = (await query(
      `INSERT INTO otp_requests (phone, purpose, code_hash, expires_at, meta)
       VALUES ($1, 'guest_benefit', $2, NOW() + INTERVAL '10 min', $3::jsonb)
       RETURNING id`,
      ['+919800001111', hash, JSON.stringify({ businessId: biz.id })],
    )).rows[0].id;

    const verify = (body) => request(app)
      .post(`/v1/guest/benefit/verify/${qrToken}`).send(body);

    const wrongCode = await verify({ requestId: real, code: '000000', phone: MEMBER_PHONE });
    const decoyId = await verify({
      requestId: crypto.randomUUID(), code: '123456', phone: STRANGER_PHONE,
    });

    expect(wrongCode.status).toBe(400);
    expect(decoyId.status).toBe(400);
    expect(decoyId.status).toBe(wrongCode.status);
    // Same error code AND same message — a distinguishable message is the same
    // oracle wearing a different hat.
    expect(JSON.stringify(decoyId.body)).toBe(JSON.stringify(wrongCode.body));
  });

  it('a real diner can still redeem after OTP verification', async () => {
    const hash = await bcrypt.hash('654321', 8);
    const real = (await query(
      `INSERT INTO otp_requests (phone, purpose, code_hash, expires_at, meta)
       VALUES ($1, 'guest_benefit', $2, NOW() + INTERVAL '10 min', $3::jsonb)
       RETURNING id`,
      ['+919800001111', hash, JSON.stringify({ businessId: biz.id })],
    )).rows[0].id;

    const ok = await request(app)
      .post(`/v1/guest/benefit/verify/${qrToken}`)
      .send({ requestId: real, code: '654321', phone: MEMBER_PHONE });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.benefitToken).toBe('string');
  });

  it('is rate-limited per IP (6th check in the window is 429)', async () => {
    const post = () => request(app)
      .post(`/v1/guest/benefit/check/${qrToken}`)
      .send({ phone: STRANGER_PHONE });

    for (let i = 0; i < 3; i += 1) {
      // budget 3/5, 4/5, 5/5
      const r = await post();
      expect(r.status).not.toBe(429);
    }
    const sixth = await post();
    expect(sixth.status).toBe(429);
  });
});
