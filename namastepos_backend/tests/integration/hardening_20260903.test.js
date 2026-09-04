// 2026-09-03 — the six known-open bugs from the re-verification pass.
// Each test is the bug, stated as behaviour.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const addons = require('../../src/services/addonService');
const customPlans = require('../../src/services/customPlanService');

let app; let biz;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `hard-${Date.now()}@example.com`, name: 'Hardening' });
});
afterAll(async () => { await closePool(); });

const adminToken = () => issueAccessToken({
  sub: '00000000-0000-0000-0000-0000000000ad', sid: '00000000-0000-0000-0000-0000000000ad',
  isSuperAdmin: true, email: 'ops@namastepos.in', role: 'support',
});

describe('platform staff cannot modify a tenant outlet structure', () => {
  it('a plain admin token is refused on POST /v1/outlet-groups', async () => {
    // This router sits OUTSIDE /businesses/:id, so it never passed through the
    // deny-by-default gate, and the role checks short-circuit for admins —
    // a support agent could create an orphan group inside a tenant's account.
    const r = await request(app)
      .post('/v1/outlet-groups')
      .set({ Authorization: `Bearer ${adminToken()}` })
      .send({ name: 'Sneaky Group' });
    expect([401, 403]).toContain(r.status);
  });

  it('but a plain admin token may still READ the outlet structure (support)', async () => {
    const r = await request(app)
      .get('/v1/outlet-groups')
      .set({ Authorization: `Bearer ${adminToken()}` });
    expect(r.status).not.toBe(403);
  });
});

describe('a downgrade does not confiscate add-on days already paid for', () => {
  it('keeps a paid activation until its period ends, and only then locks it', async () => {
    await query(
      `UPDATE addons SET required_tier_kind = 'enterprise', is_active = TRUE, price_inr_paise = 49900
        WHERE slug = 'multi-outlet'`
    );
    const ent = await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, limits, features)
       VALUES ('ent-hard', 'enterprise', 'Ent', 99900, TRUE, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO UPDATE SET tier_kind = 'enterprise' RETURNING id`
    );
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO UPDATE SET plan_id = $2, status = 'active'`,
      [biz.id, ent.rows[0].id]
    );
    require('../../src/services/featureService').clearCache(biz.id);

    // 20 days of a paid period remaining.
    const addon = await query(`SELECT id FROM addons WHERE slug = 'multi-outlet'`);
    await query(
      `INSERT INTO business_addons
         (business_id, addon_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days')
       ON CONFLICT (business_id, addon_id) DO UPDATE
         SET status = 'active', current_period_end = NOW() + INTERVAL '20 days'`,
      [biz.id, addon.rows[0].id]
    );
    expect(await addons.hasAddon(biz.id, 'multi-outlet')).toBe(true);

    // Downgrade to a starter-kind plan → the addon is no longer included.
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, limits, features)
       VALUES ('start-hard', 'starter', 'Start', 9900, TRUE, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO NOTHING`
    );
    await require('../../src/services/subscriptionService').changePlan(biz.id, 'start-hard');

    const row = await query(
      `SELECT ba.status, ba.cancel_at_period_end, ba.current_period_end
         FROM business_addons ba JOIN addons a ON a.id = ba.addon_id
        WHERE ba.business_id = $1 AND a.slug = 'multi-outlet'`,
      [biz.id]
    );
    // Paid days honoured: flagged to end, NOT switched off today.
    expect(row.rows[0].cancel_at_period_end).toBe(true);
    expect(new Date(row.rows[0].current_period_end).getTime()).toBeGreaterThan(Date.now());
    expect(await addons.hasAddon(biz.id, 'multi-outlet')).toBe(true);

    // Once the paid period lapses, entitlement really is gone.
    await query(
      `UPDATE business_addons SET current_period_end = NOW() - INTERVAL '1 minute'
        WHERE business_id = $1`,
      [biz.id]
    );
    expect(await addons.hasAddon(biz.id, 'multi-outlet')).toBe(false);
  });
});

describe('custom plan tier codes cannot collide across tenants', () => {
  it('uses the full business id, and its feature rows actually persist', async () => {
    const b = await makeBusiness({ email: `cp-${Date.now()}@example.com` });
    const tier = customPlans.customTierFor(b.id);
    expect(tier.length).toBeGreaterThan(30);   // full uuid, not 8 chars
    // The regression this caught: plan_features.tier_kind was VARCHAR(20), so
    // a long tier code created the plan but silently failed to grant features.
    const out = await customPlans.upsertForBusiness(b.id, {
      name: 'Bespoke', priceInrPaise: 123400, tierKind: 'pro',
      limits: {}, extraFeatureKeys: ['kds', 'loyalty'], assign: false,
    });
    expect(out.plan.tier).toBe(tier);
    expect(out.plan.featureKeys).toEqual(expect.arrayContaining(['kds', 'loyalty']));
  });
});

describe('the orders delta poll does not scan the whole order history', () => {
  it('omits channelCounts for delta callers (the chips they never render)', async () => {
    const token = tokenFor(biz);
    const withCounts = await request(app)
      .get(`/v1/businesses/${biz.id}/orders?limit=5`)
      .set({ Authorization: `Bearer ${token}` });
    expect(withCounts.status).toBe(200);
    expect(withCounts.body.channelCounts).toBeDefined();

    const delta = await request(app)
      .get(`/v1/businesses/${biz.id}/orders?limit=5&updatedSince=2026-01-01T00:00:00.000Z`)
      .set({ Authorization: `Bearer ${token}` });
    expect(delta.status).toBe(200);
    expect(delta.body.channelCounts).toBeUndefined();
  });
});
