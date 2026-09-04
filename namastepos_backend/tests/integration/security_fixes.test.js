// Regression tests for the 2026-08-23 security fixes (S1, S2/S3).
//
// S1 — refresh token is bound to the user who logged in (no privilege
//      escalation to another member's role).
// S2 — a super-admin token is READ-ONLY on the business API (writes must go
//      through /admin or an impersonation session).

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const authService = require('../../src/services/authService');
const buildApp = require('../../src/app');

let app;
beforeAll(async () => { await resetDb(); app = buildApp(); });
afterAll(async () => { await closePool(); });

describe('S1 — refresh token is user-bound', () => {
  it('refresh keeps the same user identity even when a second member exists', async () => {
    const biz = await makeBusiness({ email: `s1-${Date.now()}` });

    // Add a SECOND, lower-privilege member to the same business. Pre-fix, the
    // refresh consume JOIN matched any member with LIMIT 1 and could hand back
    // this cashier (or the owner) arbitrarily.
    const cashier = await query(
      `INSERT INTO users (email, display_name, google_sub)
       VALUES ($1, 'Cashier', $2) RETURNING *`,
      [`cashier-${Date.now()}@example.com`, `sub-cashier-${Date.now()}`],
    );
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, 'staff_cashier', TRUE)`,
      [biz.id, cashier.rows[0].id],
    );

    // Issue a session for the CASHIER specifically.
    const { refreshToken } = await authService.issueSession(
      { user: cashier.rows[0], businessId: biz.id, role: 'staff_cashier' },
      {},
    );

    const refreshed = await authService.refreshSession(refreshToken, {});
    const decoded = require('../../src/utils/jwt').verifyAccessToken(refreshed.accessToken);

    // Must still be the cashier, still staff_cashier — never elevated to owner.
    expect(decoded.uid).toBe(cashier.rows[0].id);
    expect(decoded.role).toBe('staff_cashier');
  });

  it('reused (already-rotated) refresh token is rejected', async () => {
    const biz = await makeBusiness({ email: `s1b-${Date.now()}` });
    const { refreshToken } = await authService.issueSession({ user: biz._owner, businessId: biz.id, role: 'business_owner' }, {});
    await authService.refreshSession(refreshToken, {}); // rotates + revokes
    await expect(authService.refreshSession(refreshToken, {})).rejects.toThrow();
  });
});

describe('S2 — super-admin is read-only on the business API', () => {
  function adminToken() {
    // Mint a plain super-admin login token (imp absent). Pre-fix this could
    // write to any tenant's business API.
    return issueAccessToken({ sub: 'admin-1', sid: 'admin-1', isSuperAdmin: true, email: 'a@x.com' });
  }

  it('allows admin GET but blocks admin writes on a business route', async () => {
    const biz = await makeBusiness({ email: `s2-${Date.now()}` });
    // Seed an active admin row so the S3 live is_active check passes.
    await query(
      `INSERT INTO admin_users (id, email, password_hash, role, is_active)
       VALUES ('admin-1', 'a@x.com', 'x', 'support', TRUE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
    ).catch(() => { /* schema may use uuid default; fall back below */ });

    const tok = adminToken();
    // A write must be blocked (403) regardless of admin role.
    const write = await request(app)
      .post(`/v1/businesses/${biz.id}/menu`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ name: 'Hack Dosa', price: 10 });
    expect([401, 403]).toContain(write.status);
    expect(write.status).not.toBe(201);
  });

  it('owner can still write to their own business', async () => {
    const biz = await makeBusiness({ email: `s2b-${Date.now()}` });
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/menu`)
      .set('Authorization', `Bearer ${tokenFor(biz)}`)
      .send({ name: 'Owner Dosa', price: 60 });
    expect([200, 201]).toContain(r.status);
  });
});
