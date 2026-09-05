// Round-2 fix batch (2026-09-06), CONTRACTS §3 — tenant API keys.
//
// `api_access` was sold on Enterprise and enforced nowhere. Now:
//   • owner issues / lists / revokes keys at /businesses/:id/api-keys
//     (requireFeature('api_access'), owner only, ≤10 live keys, secret shown
//     once and stored as sha256);
//   • `X-API-Key` authenticates READ-ONLY on /businesses/:id/*: non-GET → 405
//     API_KEY_READ_ONLY, other business → 404, revoked/unknown → 401, plan
//     without api_access → 403 API_ACCESS_NOT_IN_PLAN, 600/min per key,
//     role-gated + non-read staff-perm surfaces stay closed, featureGate rules
//     still apply to the key's business.
//
// Seed plans in the test DB: 'pro' (kind enterprise) carries api_access;
// 'free' does not. Both come from plan_features, not from a tier code.

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const apiKeys = require('../../src/services/apiKeyService');
const featureService = require('../../src/services/featureService');
const auth = require('../../src/middleware/auth');

/**
 * The two routers are mounted in app.js by the orchestrator (BE-A owns
 * app.js). Until that line lands this shim mounts them in front of the real
 * app with the same prefix + featureGate, so the suite is meaningful either
 * way: when app.js has the mount, the real app answers (the shim is skipped).
 */
function appUnderTest() {
  const real = buildApp();
  const mounted = (real._router.stack || []).some((l) => l.regexp && l.regexp.test(`${env.API_PREFIX}/businesses/x/api-keys`)
    && l.name === 'router' && l.handle && l.handle.stack
    && l.handle.stack.some((s) => s.route && s.route.path === '/:keyId'));
  if (mounted) return real;
  const shim = express();
  shim.set('trust proxy', 1);
  shim.use(express.json());
  shim.use(cookieParser());
  shim.use(`${env.API_PREFIX}/businesses/:businessId`, require('../../src/middleware/featureGate')());
  shim.use(`${env.API_PREFIX}/businesses/:businessId/api-keys`, require('../../src/routes/apiKeys.routes'));
  shim.use(real);
  // Errors raised inside the shim-mounted router skip the sub-app (Express
  // routes errors past plain middleware), so the real JSON error handler is
  // mounted here too — exactly the one app.js registers last.
  shim.use(require('../../src/middleware/errorHandler').errorHandler);
  return shim;
}

let app;
let ent; // enterprise-kind plan with api_access
let starter; // free plan, no api_access
let entToken;
const H = (t) => ({ Authorization: `Bearer ${t}` });
const K = (secret) => ({ 'X-API-Key': secret });

async function putOnPlan(biz, tier) {
  const planId = (await query('SELECT id FROM plans WHERE tier = $1', [tier])).rows[0].id;
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '1 month')
     ON CONFLICT (business_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
    [biz.id, planId],
  );
  featureService.clearCache(biz.id);
}

beforeAll(async () => {
  await resetDb();
  apiKeys._resetStateForTests();
  app = appUnderTest();
  ent = await makeBusiness({ name: 'API Keys Enterprise', email: 'apikeys-ent@example.com' });
  starter = await makeBusiness({ name: 'API Keys Starter', email: 'apikeys-free@example.com' });
  await putOnPlan(ent, 'pro');
  await putOnPlan(starter, 'free');
  entToken = tokenFor(ent);
  // Sanity: the seed grants api_access to 'pro' only (feature key, not tier).
  expect(await featureService.hasFeature(ent.id, 'api_access')).toBe(true);
  expect(await featureService.hasFeature(starter.id, 'api_access')).toBe(false);
});
afterAll(async () => { await closePool(); });

describe('issue / list / revoke', () => {
  let issued;

  it('POST issues a key: secret shown once, only sha256 stored, prefix matches', async () => {
    const r = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({ label: 'Zapier' });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^npk_live_[0-9A-Za-z]{32}$/);
    expect(r.body.key).toEqual(expect.objectContaining({ label: 'Zapier', prefix: r.body.secret.slice(0, 15) }));
    expect(r.body.key.id).toMatch(/^[0-9a-f-]{36}$/);
    issued = r.body;
    const row = (await query('SELECT * FROM api_keys WHERE id = $1', [issued.key.id])).rows[0];
    expect(row.key_hash).toBe(apiKeys.hashSecret(issued.secret));
    expect(row.key_hash).not.toContain(issued.secret.slice(9)); // never in clear
    expect(JSON.stringify(row)).not.toContain(issued.secret.slice(9, 41));
    expect(row.business_id).toBe(ent.id);
    expect(row.created_by).toBe(ent._owner.id);
  });

  it('GET lists keys without the secret', async () => {
    const r = await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken));
    expect(r.status).toBe(200);
    expect(r.body.keys).toHaveLength(1);
    expect(r.body.keys[0]).toEqual({
      id: issued.key.id,
      label: 'Zapier',
      prefix: issued.key.prefix,
      createdAt: expect.any(String),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(r.body)).not.toContain(issued.secret.slice(9));
  });

  it('a Starter tenant gets 402 FEATURE_LOCKED on every key route', async () => {
    const t = tokenFor(starter);
    const a = await request(app).get(`/v1/businesses/${starter.id}/api-keys`).set(H(t));
    expect(a.status).toBe(402);
    expect(a.body.error).toBe('FEATURE_LOCKED');
    expect(a.body.feature).toBe('api_access');
    const b = await request(app).post(`/v1/businesses/${starter.id}/api-keys`).set(H(t)).send({ label: 'x' });
    expect(b.status).toBe(402);
  });

  it('staff (non-owner) cannot manage keys', async () => {
    const staff = (await query(
      'INSERT INTO users (email, display_name, google_sub) VALUES (\'apikeys-cashier@example.com\', \'Cashier\', \'sub-apikeys-cashier\') RETURNING id',
    )).rows[0];
    await query(
      'INSERT INTO business_users (business_id, user_id, role, is_active) VALUES ($1, $2, \'staff_cashier\', TRUE)',
      [ent.id, staff.id],
    );
    const t = require('../../src/utils/jwt').issueAccessToken({ sub: staff.id, bid: ent.id, role: 'staff_cashier' });
    const r = await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(H(t));
    expect(r.status).toBe(403);
  });

  it('caps live keys at 10 (409 API_KEY_LIMIT)', async () => {
    for (let i = 0; i < 9; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({ label: `k${i}` });
      expect(r.status).toBe(201);
    }
    const over = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({ label: 'one too many' });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('API_KEY_LIMIT');
    // Revoking one frees a slot.
    const list = (await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken))).body.keys;
    const victim = list.find((k) => k.label === 'k0');
    const del = await request(app).delete(`/v1/businesses/${ent.id}/api-keys/${victim.id}`).set(H(entToken));
    expect(del.status).toBe(204);
    const again = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({ label: 'fits now' });
    expect(again.status).toBe(201);
    const revokedRow = (await query('SELECT revoked_at FROM api_keys WHERE id = $1', [victim.id])).rows[0];
    expect(revokedRow.revoked_at).not.toBeNull();
    // Revoked keys stay listed (with revokedAt) — soft delete.
    const after = (await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken))).body.keys;
    expect(after.find((k) => k.id === victim.id).revokedAt).toEqual(expect.any(String));
  });

  it('DELETE is tenant-scoped: another business\'s key id → 404', async () => {
    const other = await makeBusiness({ name: 'Other Ent', email: 'apikeys-other@example.com' });
    await putOnPlan(other, 'pro');
    const r = await request(app).delete(`/v1/businesses/${other.id}/api-keys/${issued.key.id}`).set(H(tokenFor(other)));
    expect(r.status).toBe(404);
    expect((await query('SELECT revoked_at FROM api_keys WHERE id = $1', [issued.key.id])).rows[0].revoked_at).toBeNull();
  });

  it('rejects a bad body (label required, ≤80)', async () => {
    const r = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({});
    expect(r.status).toBe(400);
  });
});

describe('X-API-Key principal on business routes', () => {
  let secret; let keyId;

  beforeAll(async () => {
    // The cap test above left the tenant at 10 live keys; free a slot.
    await query('UPDATE api_keys SET revoked_at = NOW() WHERE business_id = $1 AND label <> $2', [ent.id, 'Zapier']);
    const r = await request(app).post(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).send({ label: 'reader' });
    expect(r.status).toBe(201);
    secret = r.body.secret;
    keyId = r.body.key.id;
    // Something to read.
    await request(app).post(`/v1/businesses/${ent.id}/menu`).set(H(entToken)).send({ name: 'Dosa', price: 60 })
      .expect(201);
  });

  it('GET /orders and GET /menu with the key work; principal is read-only api_key', async () => {
    const o = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K(secret));
    expect(o.status).toBe(200);
    expect(o.headers['x-ratelimit-limit']).toBe(String(apiKeys.RATE_LIMIT_PER_MIN));
    const m = await request(app).get(`/v1/businesses/${ent.id}/menu`).set(K(secret));
    expect(m.status).toBe(200);
    expect(JSON.stringify(m.body)).toContain('Dosa');
  });

  it('touches last_used_at (throttled) so the owner sees the key in use', async () => {
    await new Promise((r) => setTimeout(r, 50)); // the touch is fire-and-forget
    const row = (await query('SELECT last_used_at FROM api_keys WHERE id = $1', [keyId])).rows[0];
    expect(row.last_used_at).not.toBeNull();
  });

  it('POST with the key → 405 API_KEY_READ_ONLY, nothing written', async () => {
    const before = (await query('SELECT COUNT(*)::int AS c FROM menu_items WHERE business_id = $1', [ent.id])).rows[0].c;
    const r = await request(app).post(`/v1/businesses/${ent.id}/menu`).set(K(secret)).send({ name: 'Nope', price: 1 });
    expect(r.status).toBe(405);
    expect(r.body.error).toBe('API_KEY_READ_ONLY');
    const after = (await query('SELECT COUNT(*)::int AS c FROM menu_items WHERE business_id = $1', [ent.id])).rows[0].c;
    expect(after).toBe(before);
    const d = await request(app).delete(`/v1/businesses/${ent.id}/api-keys/${keyId}`).set(K(secret));
    expect(d.status).toBe(405);
  });

  it('another business id → 404 (not 403: existence is not disclosed)', async () => {
    const r = await request(app).get(`/v1/businesses/${starter.id}/orders`).set(K(secret));
    expect(r.status).toBe(404);
    const ghost = await request(app).get('/v1/businesses/00000000-0000-0000-0000-000000000000/orders').set(K(secret));
    expect(ghost.status).toBe(404);
  });

  it('outside /businesses/:id the key is not an identity (401)', async () => {
    const r = await request(app).get('/v1/auth/me').set(K(secret));
    expect(r.status).toBe(401);
  });

  it('Bearer wins when both headers are present', async () => {
    const r = await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(H(entToken)).set(K('npk_live_garbage'));
    expect(r.status).toBe(200); // owner path, key header ignored
  });

  it('owner-only surfaces (billing writes, keys) refuse the key with 403 even on GET', async () => {
    const r = await request(app).get(`/v1/businesses/${ent.id}/api-keys`).set(K(secret));
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/API keys cannot access/);
  });

  it('requireStaffPerm: read perms for orders/menu/reports/customers only', async () => {
    const mw = auth.requireStaffPerm;
    const user = { businessId: ent.id, role: 'api_key', isApiKey: true, readOnly: true, id: null };
    const run = (perm, method) => new Promise((resolve) => {
      mw(perm)({ user: { ...user }, method, params: { businessId: ent.id } }, {}, (err) => resolve(err ? err.statusCode : 200));
    });
    expect(await run('orders', 'GET')).toBe(200);
    expect(await run(['reports', 'register_income'], 'GET')).toBe(200);
    expect(await run('customers', 'HEAD')).toBe(200);
    expect(await run('menu_editor', 'GET')).toBe(200);
    expect(await run('pos', 'GET')).toBe(403);
    expect(await run('staff', 'GET')).toBe(403);
    expect(await run('expenses', 'GET')).toBe(403);
    expect(await run('orders', 'POST')).toBe(403);
    expect([...auth.API_KEY_READ_PERMS].sort()).toEqual(['customers', 'menu_editor', 'orders', 'reports']);
    // Same list as BE-A's wrapper, so the two gates can never disagree.
    expect([...require('../../src/middleware/requireStaffPerm').API_KEY_READ_PERMS].sort()).toEqual([...auth.API_KEY_READ_PERMS].sort());
  });

  it('featureGate rules still apply to the key\'s business (402 on a route the plan lacks)', async () => {
    // Remove `loyalty` from this tenant only via an override, then read a
    // loyalty route with the key: the gate mounted before requireAuth skips
    // key requests, so requireAuth must run the same rule itself.
    await query(
      `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
       VALUES ($1, 'loyalty', FALSE) ON CONFLICT (business_id, feature_key) DO UPDATE SET enabled = FALSE`,
      [ent.id],
    );
    featureService.clearCache(ent.id);
    // '/customers/_settings/loyalty' hits the '/loyalty' FEATURE_RULES row.
    const r = await request(app).get(`/v1/businesses/${ent.id}/customers/_settings/loyalty`).set(K(secret));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
    await query('DELETE FROM business_feature_overrides WHERE business_id = $1', [ent.id]);
    featureService.clearCache(ent.id);
    const ok = await request(app).get(`/v1/businesses/${ent.id}/customers/_settings/loyalty`).set(K(secret));
    expect(ok.status).toBe(200);
  });

  it('plan without api_access → 403 API_ACCESS_NOT_IN_PLAN (no revocation needed)', async () => {
    await putOnPlan(ent, 'free');
    const r = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K(secret));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('API_ACCESS_NOT_IN_PLAN');
    await putOnPlan(ent, 'pro');
    const back = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K(secret));
    expect(back.status).toBe(200);
  });

  it('revoked → 401; unknown / malformed → 401', async () => {
    await request(app).delete(`/v1/businesses/${ent.id}/api-keys/${keyId}`).set(H(entToken)).expect(204);
    const r = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K(secret));
    expect(r.status).toBe(401);
    const bad = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K(`npk_live_${'A'.repeat(32)}`));
    expect(bad.status).toBe(401);
    const junk = await request(app).get(`/v1/businesses/${ent.id}/orders`).set(K('not-a-key'));
    expect(junk.status).toBe(401);
  });

  it('per-key rate limit: 600/min, then 429 with reset headers', () => {
    apiKeys._resetStateForTests();
    const t0 = Date.parse('2026-09-06T10:00:00Z');
    let last;
    for (let i = 0; i < apiKeys.RATE_LIMIT_PER_MIN; i += 1) last = apiKeys.checkRateLimit('k-rl', t0 + i);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
    const over = apiKeys.checkRateLimit('k-rl', t0 + 1000);
    expect(over.allowed).toBe(false);
    expect(over.resetAt).toBe(t0 + 60_000);
    // Next window is clean; other keys are independent.
    expect(apiKeys.checkRateLimit('k-rl', t0 + 60_000).allowed).toBe(true);
    expect(apiKeys.checkRateLimit('k-other', t0 + 1000).allowed).toBe(true);
  });
});
