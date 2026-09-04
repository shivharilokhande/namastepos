// 2026-09-03 — founder-reported: the multi-outlet addon requires "pro" but was
// being sold to a Growth-plan tenant. Root cause: the gate resolved
// `required_plan_tier` ('pro') as a PLAN TIER CODE, and the live config has a
// plan whose code is literally 'pro', so the requirement collapsed to that one
// plan's kind + PRICE — which a mid-tier plan could satisfy. Eligibility is now
// judged on tier_kind rank alone (starter < pro < enterprise).
//
// Also covers: outlet provisioning starts EMPTY (no data bleed between
// outlets), the switcher feed, and addon revocation on downgrade.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const addons = require('../../src/services/addonService');
const subs = require('../../src/services/subscriptionService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  // Mirror the founder's live ladder shape: a mid "growth" plan of tier_kind
  // 'starter' AND a plan whose CODE is 'pro' (the collision that caused the bug).
  await query(
    `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, limits, features)
     VALUES ('growth', 'starter', 'Growth', 99900, TRUE, '{}'::jsonb, '{}'::jsonb)
     ON CONFLICT (tier) DO UPDATE
       SET tier_kind = 'starter', price_inr_paise = 99900, name = 'Growth'`,
  );
  await query(
    `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, limits, features)
     VALUES ('pro', 'enterprise', 'Pro', 49900, TRUE, '{}'::jsonb, '{}'::jsonb)
     ON CONFLICT (tier) DO UPDATE
       SET tier_kind = 'enterprise', price_inr_paise = 49900, name = 'Pro'`,
  );
  // price 0 → activation path is instant (no Razorpay round-trip in tests);
  // eligibility, not payment, is what these cases exercise.
  await query(
    `UPDATE addons SET required_tier_kind = 'pro', is_active = TRUE, price_inr_paise = 0
      WHERE slug = 'multi-outlet'`,
  );
});
afterAll(async () => { await closePool(); });

async function putOnPlan(businessId, tier) {
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, (SELECT id FROM plans WHERE tier = $2), 'active', NOW() + INTERVAL '30 days')
     ON CONFLICT (business_id) DO UPDATE
       SET plan_id = (SELECT id FROM plans WHERE tier = $2), status = 'active'`,
    [businessId, tier],
  );
  try { require('../../src/services/featureService').clearCache(businessId); } catch (_) {}
}

describe('addon plan eligibility is tier_kind-based (founder bug)', () => {
  it('REJECTS a Pro-only addon on a starter-kind Growth plan', async () => {
    const biz = await makeBusiness({ email: `growth-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'growth');
    await expect(addons.subscribe(biz.id, 'multi-outlet'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('ALLOWS it on an enterprise-kind plan even though that plan is CHEAPER', async () => {
    // The old gate also compared price, so a cheap-but-higher-kind plan was
    // wrongly rejected. Kind is the only axis now.
    const biz = await makeBusiness({ email: `proplan-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'pro');
    const r = await addons.subscribe(biz.id, 'multi-outlet');
    expect(r).toBeTruthy();
  });

  it('revokes an ineligible addon when the plan is downgraded', async () => {
    const biz = await makeBusiness({ email: `downgrade-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'pro');
    await addons.subscribe(biz.id, 'multi-outlet');
    expect(await addons.hasAddon(biz.id, 'multi-outlet')).toBe(true);

    await subs.changePlan(biz.id, 'growth');
    expect(await addons.hasAddon(biz.id, 'multi-outlet')).toBe(false);
  });
});

describe('outlets: provisioning + switcher feed + isolation', () => {
  it('my-outlets is NOT plan-gated and lists the tenant itself', async () => {
    const biz = await makeBusiness({ email: `solo-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'growth'); // no multi_outlet feature
    const r = await request(app)
      .get('/v1/outlet-groups/my-outlets')
      .set('Authorization', `Bearer ${tokenFor(biz)}`);
    expect(r.status).toBe(200);
    expect(r.body.outlets.length).toBeGreaterThanOrEqual(1);
    expect(r.body.outlets.some((o) => o.businessId === biz.id && o.current)).toBe(true);
  });

  it('provisioning an outlet is 402 without the multi_outlet feature', async () => {
    const biz = await makeBusiness({ email: `nogate-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'growth');
    const r = await request(app)
      .post('/v1/outlet-groups/outlets/provision')
      .set('Authorization', `Bearer ${tokenFor(biz)}`)
      .send({ name: 'Andheri Branch' });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
  });

  it('a provisioned outlet is a SEPARATE tenant with NO data from the parent', async () => {
    const biz = await makeBusiness({ email: `hq-${Date.now()}@example.com` });
    await putOnPlan(biz.id, 'pro');
    await query(
      `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
       VALUES ($1, 'multi_outlet', TRUE)
       ON CONFLICT (business_id, feature_key) DO UPDATE SET enabled = TRUE`,
      [biz.id],
    );
    require('../../src/services/featureService').clearCache(biz.id);

    // Parent has a menu item; the new outlet must NOT see it.
    await query(
      `INSERT INTO menu_items (business_id, name, price, category, is_active)
       VALUES ($1, 'HQ Only Thali', 120, 'main', TRUE)`,
      [biz.id],
    );

    const prov = await request(app)
      .post('/v1/outlet-groups/outlets/provision')
      .set('Authorization', `Bearer ${tokenFor(biz)}`)
      .send({ name: 'Andheri Branch', label: 'Andheri', city: 'Mumbai' });
    if (prov.status !== 201) {
      // Surface the real reason instead of a bare status mismatch.
      throw new Error(`provision failed ${prov.status}: ${JSON.stringify(prov.body)}`);
    }
    expect(prov.status).toBe(201);
    const outletId = prov.body.outlet.id;
    expect(outletId).not.toBe(biz.id);

    // Same group, own row, zero inherited rows.
    const grouped = await query('SELECT outlet_group_id FROM businesses WHERE id IN ($1, $2)', [biz.id, outletId]);
    const gids = grouped.rows.map((x) => x.outlet_group_id);
    expect(gids[0]).toBe(gids[1]);
    expect(gids[0]).toBeTruthy();

    for (const table of ['menu_items', 'orders', 'expenses', 'customers']) {
      // eslint-disable-next-line no-await-in-loop
      const c = await query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE business_id = $1`, [outletId]);
      expect(c.rows[0].c).toBe(0);
    }

    // Switching yields a token scoped to the outlet, and that token sees the
    // outlet's (empty) menu — never the parent's.
    const sw = await request(app)
      .post('/v1/auth/switch-business')
      .set('Authorization', `Bearer ${tokenFor(biz)}`)
      .send({ businessId: outletId });
    expect(sw.status).toBe(200);
    expect(sw.body.token).toBeTruthy();
    expect(sw.body.business.id).toBe(outletId);

    const menu = await request(app)
      .get(`/v1/businesses/${outletId}/menu`)
      .set('Authorization', `Bearer ${sw.body.token}`);
    expect(menu.status).toBe(200);
    const items = menu.body.items ?? menu.body.menu ?? [];
    expect(items.length).toBe(0);

    // And the outlet token cannot read the parent's data.
    const cross = await request(app)
      .get(`/v1/businesses/${biz.id}/menu`)
      .set('Authorization', `Bearer ${sw.body.token}`);
    expect([401, 403]).toContain(cross.status);
  });

  it('refuses to switch into a business the user does not belong to', async () => {
    const a = await makeBusiness({ email: `a-${Date.now()}@example.com` });
    const b = await makeBusiness({ email: `b-${Date.now()}@example.com` });
    const r = await request(app)
      .post('/v1/auth/switch-business')
      .set('Authorization', `Bearer ${tokenFor(a)}`)
      .send({ businessId: b.id });
    expect([401, 403]).toContain(r.status);
  });
});
