// Round-2 fix batch (2026-09-06), CONTRACTS §5 — admin surface.
//
//   GET /admin/customers/:id/effective-features  plan ∪ addon grants ∪
//       overrides with the SOURCE of every key (admin review F-03)
//   GET /admin/ops/review-checks                 the eight post-deploy checks,
//       SQL included, super-admin only
//   serializePlan.offersYearly                   raw truth of price_yearly_paise
//       (admin review F-02)
//   custom plan limits                           `businesses` accepted; a
//       standalone plan's missing limits default to the cheapest public plan,
//       never to "uncapped" (admin review F-06)

const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');
const sub = require('../../src/services/subscriptionService');
const featureService = require('../../src/services/featureService');
const adminService = require('../../src/services/adminService');

let app;
let biz; let ownerToken;
let superToken; let supportToken;

async function makeAdmin(email, role) {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ($1, 'x-not-a-real-hash', $2, TRUE) RETURNING id, email, role`,
    [email, role],
  );
  return issueAccessToken({
    sid: r.rows[0].id, isSuperAdmin: true, email: r.rows[0].email, role: r.rows[0].role,
  });
}
const admin = (t) => ({ Cookie: `ff_admin=${t}` });
const H = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  superToken = await makeAdmin('r2b-super@example.com', 'super_admin');
  supportToken = await makeAdmin('r2b-support@example.com', 'support');
  biz = await makeBusiness({ name: 'Effective Features Cafe', email: 'r2b-eff@example.com' });
  ownerToken = tokenFor(biz);
  const basic = (await query("SELECT id FROM plans WHERE tier = 'basic'")).rows[0].id;
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '1 month')`,
    [biz.id, basic],
  );
});
afterAll(async () => { await closePool(); });

describe('GET /admin/customers/:id/effective-features', () => {
  it('lists plan keys with source plan, addon grants with addon:<slug>, overrides both ways', async () => {
    // An addon grant + one enable override + one disable override on a plan key.
    const addon = (await query(
      `INSERT INTO addons (slug, name, price_inr_paise, billing_period, is_active, display_order, grants_features)
       VALUES ('r2b-granter', 'R2B Granter', 0, 'monthly', TRUE, 998, ARRAY['forecast'])
       ON CONFLICT (slug) DO UPDATE SET grants_features = ARRAY['forecast'] RETURNING id`,
    )).rows[0];
    await query(
      `INSERT INTO business_addons (business_id, addon_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '10 days')`,
      [biz.id, addon.id],
    );
    await query(
      `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
       VALUES ($1, 'tds_tcs', TRUE), ($1, 'aggregators', FALSE)`,
      [biz.id],
    );
    featureService.clearCache(biz.id);

    const r = await request(app).get(`/v1/admin/customers/${biz.id}/effective-features`).set(admin(supportToken));
    expect(r.status).toBe(200);
    expect(r.body.plan).toEqual(expect.objectContaining({ code: 'basic', tierKind: 'pro', name: expect.any(String) }));
    expect(r.body.planVersion).toMatch(/^[0-9a-f]{12}$/);
    const byKey = Object.fromEntries(r.body.features.map((f) => [f.key, f]));
    // plan key (basic carries aggregators in the seed — but it is disabled below)
    const planKeys = await featureService.listTierFeatures('basic', 'pro');
    const somePlanKey = planKeys.find((k) => k !== 'aggregators');
    expect(byKey[somePlanKey].sources).toEqual(['plan']);
    expect(byKey[somePlanKey]).toEqual(expect.objectContaining({ label: expect.any(String), group: expect.any(String) }));
    // addon grant + the slug pseudo-key
    expect(byKey.forecast.sources).toEqual(['addon:r2b-granter']);
    expect(byKey['r2b-granter'].sources).toEqual(['addon:r2b-granter']);
    // enable override
    expect(byKey.tds_tcs.sources).toEqual(['override:enable']);
    // disable override removes a plan key and reports what would have granted it
    expect(byKey.aggregators).toBeUndefined();
    expect(r.body.disabled).toEqual([
      expect.objectContaining({ key: 'aggregators', source: 'override:disable', wouldBeGrantedBy: ['plan'] }),
    ]);
    // It agrees with what the gates enforce.
    const live = await featureService.planSummary(biz.id);
    expect(new Set(r.body.features.map((f) => f.key))).toEqual(new Set(live.features));
  });

  it('404 for an unknown customer; 403 for a tenant token; 401 unauthenticated', async () => {
    const a = await request(app).get('/v1/admin/customers/00000000-0000-0000-0000-000000000000/effective-features').set(admin(superToken));
    expect(a.status).toBe(404);
    const b = await request(app).get(`/v1/admin/customers/${biz.id}/effective-features`).set(H(ownerToken));
    expect([401, 403]).toContain(b.status);
    const c = await request(app).get(`/v1/admin/customers/${biz.id}/effective-features`);
    expect(c.status).toBe(401);
  });
});

describe('GET /admin/ops/review-checks', () => {
  it('is super-admin only (support → 403)', async () => {
    const r = await request(app).get('/v1/admin/ops/review-checks').set(admin(supportToken));
    expect(r.status).toBe(403);
  });

  it('runs all eight checks with SQL + bounded samples', async () => {
    // Seed one hit for the data-driven checks.
    await query(
      `INSERT INTO tax_invoices (business_id, invoice_no, fy, fy_seq, supplier_name, place_of_supply,
         subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, items)
       VALUES ($1, 'R2B/1', '2026-27', 9001, 'Effective Features Cafe', '27', 10000, 0, 0, 0, 10000, '[]'::jsonb)`,
      [biz.id],
    );
    await query(
      'INSERT INTO einvoice_irns (business_id, irn, is_stub) VALUES ($1, $2, TRUE)',
      [biz.id, 'a'.repeat(64)],
    );
    // An aggregator credential on a plan WITHOUT aggregators (disabled by override above).
    await query(
      `INSERT INTO aggregator_credentials (business_id, provider, is_active) VALUES ($1, 'zomato', TRUE)
       ON CONFLICT (business_id, provider) DO UPDATE SET is_active = TRUE`,
      [biz.id],
    );
    const lapsed = await makeBusiness({ name: 'Lapsed Cancel', email: 'r2b-lapsed@example.com' });
    const basic = (await query("SELECT id FROM plans WHERE tier = 'basic'")).rows[0].id;
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, cancel_at_period_end, current_period_end)
       VALUES ($1, $2, 'active', TRUE, NOW() - INTERVAL '5 days')`,
      [lapsed.id, basic],
    );
    const suspended = await makeBusiness({ name: 'Suspended One', email: 'r2b-susp@example.com' });
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '5 days')`,
      [suspended.id, basic],
    );
    await adminService.suspend(suspended.id);

    const r = await request(app).get('/v1/admin/ops/review-checks').set(admin(superToken));
    expect(r.status).toBe(200);
    expect(r.body.generatedAt).toEqual(expect.any(String));
    const ids = r.body.checks.map((c) => c.id);
    expect(ids).toEqual([
      'zero_gst_invoices', 'stub_irns', 'aggregator_without_key', 'lapsed_cancel_rows',
      'suspended_tenants', 'db_ssl_unverified', 'order_tax_mode', 'plans_with_unenforced_keys',
    ]);
    const by = Object.fromEntries(r.body.checks.map((c) => [c.id, c]));
    for (const c of r.body.checks) {
      expect(['critical', 'warn', 'info']).toContain(c.severity);
      expect(typeof c.count).toBe('number');
      expect(typeof c.description).toBe('string');
      expect(Array.isArray(c.sample)).toBe(true);
      expect(c.sample.length).toBeLessThanOrEqual(20);
    }
    expect(by.zero_gst_invoices.count).toBeGreaterThanOrEqual(1);
    expect(by.zero_gst_invoices.sql).toMatch(/cgst_paise \+ sgst_paise \+ igst_paise = 0/);
    expect(by.zero_gst_invoices.sample.some((s) => s.invoice_no === 'R2B/1')).toBe(true);
    expect(by.stub_irns.count).toBeGreaterThanOrEqual(1);
    expect(by.stub_irns.severity).toBe('critical');
    expect(by.stub_irns.sample[0].irn).toMatch(/…$/); // IRNs are truncated in the sample
    expect(by.aggregator_without_key.count).toBeGreaterThanOrEqual(1);
    expect(by.aggregator_without_key.sample.some((s) => s.business_id === biz.id)).toBe(true);
    expect(by.lapsed_cancel_rows.sample.some((s) => s.business_id === lapsed.id)).toBe(true);
    expect(by.suspended_tenants.sample.some((s) => s.business_id === suspended.id)).toBe(true);
    expect(by.db_ssl_unverified.sql).toBeNull();
    expect(by.order_tax_mode.sample[0]).toHaveProperty('ORDER_TAX_ENFORCE');
    expect(by.plans_with_unenforced_keys.sql).toMatch(/ARRAY\[/);
    // The seed grants `pos` (declared ungated) to every plan, so this is non-zero.
    expect(by.plans_with_unenforced_keys.count).toBeGreaterThan(0);
    expect(by.plans_with_unenforced_keys.sample[0]).toEqual(expect.objectContaining({ plan_code: expect.any(String), feature_key: expect.any(String) }));
  });
});

describe('serializePlan.offersYearly (F-02)', () => {
  it('is true iff price_yearly_paise is set; priceYearlyInr keeps its 10x default', () => {
    const noYearly = sub.serializePlan({ tier: 'x', tier_kind: 'pro', name: 'X', price_inr_paise: 29900, price_yearly_paise: null, limits: {} });
    expect(noYearly.offersYearly).toBe(false);
    expect(noYearly.priceYearlyInr).toBe(2990); // unchanged compatibility default
    const yearly = sub.serializePlan({ tier: 'y', tier_kind: 'pro', name: 'Y', price_inr_paise: 29900, price_yearly_paise: 250000, limits: {} });
    expect(yearly.offersYearly).toBe(true);
    expect(yearly.priceYearlyInr).toBe(2500);
    const free = sub.serializePlan({ tier: 'z', tier_kind: 'starter', name: 'Z', price_inr_paise: 0, price_yearly_paise: null, limits: {} });
    expect(free.offersYearly).toBe(false);
    expect(free.priceYearlyInr).toBeNull();
  });

  it('is on the wire for the admin plan list', async () => {
    const r = await request(app).get('/v1/admin/plans').set(admin(superToken));
    expect(r.status).toBe(200);
    for (const p of r.body.plans) expect(typeof p.offersYearly).toBe('boolean');
  });
});

describe('custom plan limits (F-06)', () => {
  let target;
  beforeAll(async () => {
    target = await makeBusiness({ name: 'Bespoke Ltd', email: 'r2b-bespoke@example.com' });
  });

  it('a STANDALONE custom plan defaults missing limits from the cheapest public plan', async () => {
    const cheapest = (await query(
      `SELECT limits FROM plans WHERE is_public = TRUE AND is_active = TRUE AND business_id IS NULL
        ORDER BY price_inr_paise ASC, created_at ASC LIMIT 1`,
    )).rows[0].limits;
    expect(Object.keys(cheapest).length).toBeGreaterThan(0);
    const r = await request(app).put(`/v1/admin/customers/${target.id}/custom-plan`).set(admin(superToken))
      .send({ name: 'Bespoke', priceInrPaise: 49900, tierKind: 'pro', limits: { staff: 7 }, extraFeatureKeys: ['loyalty'] });
    expect(r.status).toBe(200);
    expect(r.body.plan.limits.staff).toBe(7); // explicit wins
    for (const [k, v] of Object.entries(cheapest)) {
      if (k === 'staff') continue;
      expect(r.body.plan.limits[k]).toBe(v); // floor, not "uncapped"
    }
  });

  it('accepts limits.businesses and rejects an unknown limit name', async () => {
    const ok = await request(app).put(`/v1/admin/customers/${target.id}/custom-plan`).set(admin(superToken))
      .send({ name: 'Bespoke', priceInrPaise: 49900, tierKind: 'pro', limits: { businesses: 3 } });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.limits.businesses).toBe(3);
    const bad = await request(app).put(`/v1/admin/customers/${target.id}/custom-plan`).set(admin(superToken))
      .send({ name: 'Bespoke', priceInrPaise: 49900, tierKind: 'pro', limits: { outlets: 3 } });
    expect(bad.status).toBe(400);
  });

  it('with a base plan the base limits stay the floor', async () => {
    const base = (await query("SELECT limits FROM plans WHERE tier = 'basic'")).rows[0].limits;
    const r = await request(app).put(`/v1/admin/customers/${target.id}/custom-plan`).set(admin(superToken))
      .send({ name: 'Growth plus', basePlanTier: 'basic', extraFeatureKeys: ['wastage'] });
    expect(r.status).toBe(200);
    for (const [k, v] of Object.entries(base)) expect(r.body.plan.limits[k]).toBe(v);
  });
});
