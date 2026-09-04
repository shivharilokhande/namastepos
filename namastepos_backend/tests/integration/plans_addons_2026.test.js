// Plans / addons / feature-gating audit fixes (2026-09-03).
//
// Covers:
//   1. business_feature_overrides are enforced (enable adds, disable removes)
//      with immediate cache invalidation, via the new admin endpoints.
//   2. addons.grants_features unlock featureGate'd routes (slug != key), and
//      detach locks them again immediately (clearCache on detach).
//   3. plan-granted 'loyalty' opens the addon-gated /customers routes.
//   4. /v1/outlet-groups is plan-gated on 'multi_outlet' (402 FEATURE_LOCKED).
//   5. tenant changePlan rejects inactive / non-public / another tenant's
//      custom plan with 400 PLAN_NOT_AVAILABLE.
//   6. custom per-customer plans: PUT creates+assigns, tenant /v1/plans
//      includes it, public + other-tenant lists exclude it, DELETE 409s
//      while assigned.
//   7. addon renewal stacks the new period on the remaining one.

jest.setTimeout(120000);

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');
const rz = require('../../src/services/razorpayService');
const env = require('../../src/config/env');

let app;
let bizA; let tokenA;
let bizB; let tokenB;
let adminToken;

async function makeAdminToken() {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ('plans-audit-admin@namastepos.in', 'x-not-a-real-hash', 'super_admin', TRUE)
     RETURNING id, email`,
  );
  return issueAccessToken({
    sid: r.rows[0].id,
    isSuperAdmin: true,
    email: r.rows[0].email,
    role: 'super_admin',
  });
}

async function giveFreeSubscription(businessId) {
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, (SELECT id FROM plans WHERE tier = 'free'), 'active',
             NOW() + INTERVAL '30 days')
     ON CONFLICT (business_id) DO NOTHING`,
    [businessId],
  );
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  bizA = await makeBusiness({ email: 'plans-audit-a@example.com', name: 'Audit A' });
  bizB = await makeBusiness({ email: 'plans-audit-b@example.com', name: 'Audit B' });
  tokenA = tokenFor(bizA);
  tokenB = tokenFor(bizB);
  await giveFreeSubscription(bizA.id);
  await giveFreeSubscription(bizB.id);
  adminToken = await makeAdminToken();
});

afterAll(async () => {
  jest.restoreAllMocks();
  await closePool();
});

// ── 1. Feature overrides ──────────────────────────────────────────────────
describe('business_feature_overrides enforcement + admin API', () => {
  it('free tenant is FEATURE_LOCKED on a pro feature (wastage)', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${bizA.id}/wastage`).set(auth(tokenA));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
    expect(r.body.feature).toBe('wastage');
  });

  it('admin PUT override enable opens the gate immediately', async () => {
    const put = await request(app)
      .put(`/v1/admin/customers/${bizA.id}/feature-overrides`)
      .set(auth(adminToken))
      .send({ overrides: [{ featureKey: 'wastage', mode: 'enable' }] });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toHaveLength(1);
    expect(put.body.overrides[0].mode).toBe('enable');

    const r = await request(app)
      .get(`/v1/businesses/${bizA.id}/wastage`).set(auth(tokenA));
    expect(r.status).toBe(200); // no 60s stale-cache window
  });

  it('mode=disable removes a feature the plan grants', async () => {
    expect(await featureService.hasFeature(bizA.id, 'expenses')).toBe(true);
    const put = await request(app)
      .put(`/v1/admin/customers/${bizA.id}/feature-overrides`)
      .set(auth(adminToken))
      .send({ overrides: [
        { featureKey: 'wastage', mode: 'enable' },
        { featureKey: 'expenses', mode: 'disable' },
      ] });
    expect(put.status).toBe(200);
    expect(await featureService.hasFeature(bizA.id, 'expenses')).toBe(false);
    expect(await featureService.hasFeature(bizA.id, 'wastage')).toBe(true);
  });

  it('admin GET lists the overrides; owner read route returns overrides + merged features', async () => {
    const adminGet = await request(app)
      .get(`/v1/admin/customers/${bizA.id}/feature-overrides`).set(auth(adminToken));
    expect(adminGet.status).toBe(200);
    const keys = adminGet.body.overrides.map((o) => o.featureKey).sort();
    expect(keys).toEqual(['expenses', 'wastage']);

    const ownerGet = await request(app)
      .get(`/v1/businesses/${bizA.id}/feature-overrides`).set(auth(tokenA));
    expect(ownerGet.status).toBe(200);
    expect(Array.isArray(ownerGet.body.features)).toBe(true);
    expect(ownerGet.body.features).toContain('wastage');
    expect(ownerGet.body.features).not.toContain('expenses');
  });

  it('DELETE one override re-locks that feature immediately', async () => {
    const del = await request(app)
      .delete(`/v1/admin/customers/${bizA.id}/feature-overrides/wastage`)
      .set(auth(adminToken));
    expect(del.status).toBe(200);
    const r = await request(app)
      .get(`/v1/businesses/${bizA.id}/wastage`).set(auth(tokenA));
    expect(r.status).toBe(402);
    // Clean the remaining 'expenses' disable so later tests see plan defaults.
    await request(app)
      .delete(`/v1/admin/customers/${bizA.id}/feature-overrides/expenses`)
      .set(auth(adminToken));
    expect(await featureService.hasFeature(bizA.id, 'expenses')).toBe(true);
  });

  it('owner token cannot write overrides', async () => {
    const r = await request(app)
      .put(`/v1/admin/customers/${bizA.id}/feature-overrides`)
      .set(auth(tokenA))
      .send({ overrides: [{ featureKey: 'wastage', mode: 'enable' }] });
    expect([401, 403]).toContain(r.status);
  });
});

// ── 2. Addon grants + outlet-groups gate ─────────────────────────────────
describe('addon grants_features unlock gated routes; /v1/outlet-groups is gated', () => {
  it('outlet-groups 402 FEATURE_LOCKED without multi_outlet', async () => {
    const r = await request(app).get('/v1/outlet-groups').set(auth(tokenB));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
    expect(r.body.feature).toBe('multi_outlet');
  });

  it('attaching the multi-outlet addon opens outlet-groups (grants, not slug)', async () => {
    const attach = await request(app)
      .post(`/v1/admin/customers/${bizB.id}/addons/multi-outlet/attach`)
      .set(auth(adminToken));
    expect(attach.status).toBe(200);
    const r = await request(app).get('/v1/outlet-groups').set(auth(tokenB));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('groups');
  });

  it('whatsapp-marketing addon merges its grants + slug into the feature set', async () => {
    await request(app)
      .post(`/v1/admin/customers/${bizB.id}/addons/whatsapp-marketing/attach`)
      .set(auth(adminToken))
      .expect(200);
    const summary = await featureService.planSummary(bizB.id);
    expect(summary.features).toContain('whatsapp_marketing'); // grants_features
    expect(summary.features).toContain('whatsapp-marketing'); // slug back-compat
  });

  it('recipe-costing addon opens the addon-gated ingredients routes', async () => {
    const before = await request(app)
      .get(`/v1/businesses/${bizB.id}/ingredients`).set(auth(tokenB));
    expect(before.status).toBe(402);
    await request(app)
      .post(`/v1/admin/customers/${bizB.id}/addons/recipe-costing/attach`)
      .set(auth(adminToken))
      .expect(200);
    const after = await request(app)
      .get(`/v1/businesses/${bizB.id}/ingredients`).set(auth(tokenB));
    expect(after.status).toBe(200);
  });

  it('detach re-locks immediately (clearCache on detach)', async () => {
    await request(app)
      .post(`/v1/admin/customers/${bizB.id}/addons/multi-outlet/detach`)
      .set(auth(adminToken))
      .expect(200);
    const r = await request(app).get('/v1/outlet-groups').set(auth(tokenB));
    expect(r.status).toBe(402);
  });

  it('plan-granted multi_outlet also opens outlet-groups', async () => {
    await query(`INSERT INTO plan_features (tier_kind, feature_key)
                 VALUES ('free', 'multi_outlet') ON CONFLICT DO NOTHING`);
    featureService.clearAllCaches();
    const r = await request(app).get('/v1/outlet-groups').set(auth(tokenA));
    expect(r.status).toBe(200);
    await query(`DELETE FROM plan_features
                  WHERE tier_kind = 'free' AND feature_key = 'multi_outlet'`);
    featureService.clearAllCaches();
  });
});

// ── 3. Plan-granted loyalty opens /customers without the addon ───────────
describe('requireAddon orFeature: plan-granted loyalty opens /customers', () => {
  it('402 without addon or feature', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${bizA.id}/customers`).set(auth(tokenA));
    expect(r.status).toBe(402);
  });

  it('200 once the plan grants the loyalty feature (no addon purchase)', async () => {
    await query(`INSERT INTO plan_features (tier_kind, feature_key)
                 VALUES ('free', 'loyalty') ON CONFLICT DO NOTHING`);
    featureService.clearAllCaches();
    const r = await request(app)
      .get(`/v1/businesses/${bizA.id}/customers`).set(auth(tokenA));
    expect(r.status).toBe(200);
    await query(`DELETE FROM plan_features
                  WHERE tier_kind = 'free' AND feature_key = 'loyalty'`);
    featureService.clearAllCaches();
  });
});

// ── 5. changePlan availability guard ─────────────────────────────────────
describe('changePlan rejects unavailable plans with 400 PLAN_NOT_AVAILABLE', () => {
  beforeAll(async () => {
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, is_public)
       VALUES ('hidden_internal', 'pro', 'Hidden Internal', 9900, TRUE, FALSE)
       ON CONFLICT (tier) DO NOTHING`,
    );
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, is_public)
       VALUES ('retired_x', 'pro', 'Retired', 9900, FALSE, TRUE)
       ON CONFLICT (tier) DO NOTHING`,
    );
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, business_id)
       VALUES ('custom-ofbizb00', 'pro', 'B Only', 9900, TRUE, FALSE, $1)
       ON CONFLICT (tier) DO NOTHING`,
      [bizB.id],
    );
  });

  const change = (tier) => request(app)
    .post(`/v1/businesses/${bizA.id}/billing/change`)
    .set(auth(tokenA))
    .send({ tier });

  it('non-public plan → 400', async () => {
    const r = await change('hidden_internal');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('PLAN_NOT_AVAILABLE');
  });

  it('inactive plan → 400', async () => {
    const r = await change('retired_x');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('PLAN_NOT_AVAILABLE');
  });

  it("another tenant's custom plan → 400", async () => {
    const r = await change('custom-ofbizb00');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('PLAN_NOT_AVAILABLE');
  });

  it('public active plan still works (and back to free)', async () => {
    const up = await change('basic');
    expect(up.status).toBe(200);
    const down = await change('free');
    expect(down.status).toBe(200);
  });

  afterAll(async () => {
    await query('DELETE FROM plans WHERE tier IN (\'hidden_internal\',\'retired_x\',\'custom-ofbizb00\')');
    featureService.clearAllCaches();
  });
});

// ── 6. Custom per-customer plans ─────────────────────────────────────────
describe('custom plans: admin upsert/assign, tenant-scoped visibility, delete', () => {
  // Tier code comes from the service (full UUID since 2026-09-03 — the old
  // 8-char form risked a cross-tenant plan collision), so assert against it
  // rather than re-deriving the format here.
  const expectedTier = () => require('../../src/services/customPlanService').customTierFor(bizB.id);

  it('PUT creates + assigns the custom plan', async () => {
    const r = await request(app)
      .put(`/v1/admin/customers/${bizB.id}/custom-plan`)
      .set(auth(adminToken))
      .send({
        name: 'B Bespoke',
        priceInrPaise: 39900,
        priceYearlyPaise: null,
        limits: { staff: 5, tables: 20, floors: 2, menu_items: 500, monthly_orders: -1 },
        featureKeys: ['pos', 'orders', 'loyalty', 'multi_outlet', 'wastage'],
        tierKind: 'pro',
        assign: true,
      });
    expect(r.status).toBe(200);
    expect(r.body.plan.tier).toBe(expectedTier());
    expect(r.body.plan.isPublic).toBe(false);
    expect(r.body.plan.businessId).toBe(bizB.id);
    expect(r.body.plan.assigned).toBe(true);
    expect(r.body.plan.featureKeys).toContain('loyalty');
  });

  it('GET returns the plan; tenant is actually on it (features live)', async () => {
    const g = await request(app)
      .get(`/v1/admin/customers/${bizB.id}/custom-plan`).set(auth(adminToken));
    expect(g.status).toBe(200);
    expect(g.body.plan.tier).toBe(expectedTier());
    expect(g.body.plan.assigned).toBe(true);

    // Plan-granted loyalty (via the custom plan) opens /customers…
    const cust = await request(app)
      .get(`/v1/businesses/${bizB.id}/customers`).set(auth(tokenB));
    expect(cust.status).toBe(200);
    // …and multi_outlet opens outlet-groups.
    const og = await request(app).get('/v1/outlet-groups').set(auth(tokenB));
    expect(og.status).toBe(200);
  });

  it('tenant /v1/plans includes their custom plan; public + other tenant exclude it', async () => {
    const mine = await request(app).get('/v1/plans').set(auth(tokenB));
    expect(mine.status).toBe(200);
    expect(mine.body.plans.map((p) => p.tier)).toContain(expectedTier());

    const anon = await request(app).get('/v1/plans');
    expect(anon.status).toBe(200);
    expect(anon.body.plans.map((p) => p.tier)).not.toContain(expectedTier());

    const other = await request(app).get('/v1/plans').set(auth(tokenA));
    expect(other.status).toBe(200);
    expect(other.body.plans.map((p) => p.tier)).not.toContain(expectedTier());

    const publicFeed = await request(app).get('/v1/public/plans');
    expect(publicFeed.status).toBe(200);
    expect(publicFeed.body.plans.map((p) => p.tier)).not.toContain(expectedTier());
  });

  it('DELETE 409s while assigned; deletes after reassignment', async () => {
    const conflict = await request(app)
      .delete(`/v1/admin/customers/${bizB.id}/custom-plan`).set(auth(adminToken));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('CUSTOM_PLAN_ASSIGNED');

    await request(app)
      .post(`/v1/admin/customers/${bizB.id}/set-plan`)
      .set(auth(adminToken))
      .send({ tier: 'free' })
      .expect(200);

    const del = await request(app)
      .delete(`/v1/admin/customers/${bizB.id}/custom-plan`).set(auth(adminToken));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const g = await request(app)
      .get(`/v1/admin/customers/${bizB.id}/custom-plan`).set(auth(adminToken));
    expect(g.body.plan).toBeNull();
  });

  it('nextTierUp is null for custom tier codes (upgrade CTA hidden)', () => {
    expect(featureService.nextTierUp('custom-12345678')).toBeNull();
    expect(featureService.nextTierUp('enterprise')).toBeNull();
    expect(featureService.nextTierUp('starter')).toBe('pro');
  });
});

// ── 7. Addon renewal stacking ────────────────────────────────────────────
describe('addon renewal stacks the new period onto the remaining one', () => {
  let addonPrice;

  beforeAll(async () => {
    const a = await query('SELECT id, price_inr_paise FROM addons WHERE slug = \'whatsapp-marketing\'');
    addonPrice = a.rows[0].price_inr_paise;
    await query(
      `INSERT INTO business_addons
         (business_id, addon_id, status, current_period_end, notified_expiry_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '10 days', NOW())
       ON CONFLICT (business_id, addon_id) DO UPDATE
         SET status = 'active', cancelled_at = NULL, cancel_at_period_end = FALSE,
             current_period_end = NOW() + INTERVAL '10 days',
             notified_expiry_at = NOW()`,
      [bizA.id, a.rows[0].id],
    );
    featureService.clearCache(bizA.id);
  });

  afterAll(() => { jest.restoreAllMocks(); });

  it('confirm-payment extends from the CURRENT period end, not from NOW()', async () => {
    jest.spyOn(rz, 'verifyCheckoutSignature').mockReturnValue(true);
    jest.spyOn(rz, 'getOrder').mockResolvedValue({
      id: 'order_renew_1',
      amount: addonPrice,
      notes: { kind: 'addon', addonSlug: 'whatsapp-marketing', businessId: bizA.id },
    });

    const r = await request(app)
      .post(`/v1/businesses/${bizA.id}/addons/whatsapp-marketing/confirm-payment`)
      .set(auth(tokenA))
      .send({
        razorpayPaymentId: 'pay_renew_1',
        razorpayOrderId: 'order_renew_1',
        razorpaySignature: 'sig_renew_1',
      });
    expect(r.status).toBe(200);
    expect(r.body.activated).toBe(true);

    const row = await query(
      `SELECT ba.current_period_end, ba.notified_expiry_at
         FROM business_addons ba JOIN addons a ON a.id = ba.addon_id
        WHERE ba.business_id = $1 AND a.slug = 'whatsapp-marketing'`,
      [bizA.id],
    );
    const days = (new Date(row.rows[0].current_period_end) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(38); // 10 remaining + 30 renewed (was 30 pre-fix)
    expect(days).toBeLessThan(42);
    // Renewal re-arms the expiry notification for the next window.
    expect(row.rows[0].notified_expiry_at).toBeNull();
  });

  it('subscribe on an ACTIVE paid addon returns a renewal order, not 409', async () => {
    const savedKey = env.RAZORPAY_KEY_ID;
    const savedSecret = env.RAZORPAY_KEY_SECRET;
    env.RAZORPAY_KEY_ID = 'rzp_test_mock';
    env.RAZORPAY_KEY_SECRET = 'mock-secret';
    try {
      // online-orders has no required_plan_tier; give A an active activation.
      const a = await query('SELECT id, price_inr_paise FROM addons WHERE slug = \'online-orders\'');
      await query(
        `INSERT INTO business_addons (business_id, addon_id, status, current_period_end)
         VALUES ($1, $2, 'active', NOW() + INTERVAL '10 days')
         ON CONFLICT (business_id, addon_id) DO UPDATE
           SET status = 'active', cancelled_at = NULL, cancel_at_period_end = FALSE,
               current_period_end = NOW() + INTERVAL '10 days'`,
        [bizA.id, a.rows[0].id],
      );
      jest.spyOn(rz, 'createOneTimeOrder').mockResolvedValue({
        id: 'order_renew_2', amount: a.rows[0].price_inr_paise, currency: 'INR',
      });

      const r = await request(app)
        .post(`/v1/businesses/${bizA.id}/addons/subscribe`)
        .set(auth(tokenA))
        .send({ slug: 'online-orders' });
      expect(r.status).toBe(201);
      expect(r.body.requiresPayment).toBe(true);
      expect(r.body.renewal).toBe(true);
      expect(r.body.razorpayOrder.id).toBe('order_renew_2');
    } finally {
      env.RAZORPAY_KEY_ID = savedKey;
      env.RAZORPAY_KEY_SECRET = savedSecret;
    }
  });

  it('nightly expiry scan notifies once per activation window', async () => {
    const addonService = require('../../src/services/addonService');
    const push = require('../../src/services/pushService');
    const pushSpy = jest.spyOn(push, 'sendToBusinessOwners').mockResolvedValue(undefined);

    // whatsapp-marketing activation for A now ends ~40 days out (renewed above)
    // → not in window. Pull it into the 3-day window.
    await query(
      `UPDATE business_addons ba
          SET current_period_end = NOW() + INTERVAL '2 days', notified_expiry_at = NULL
         FROM addons a
        WHERE a.id = ba.addon_id AND ba.business_id = $1 AND a.slug = 'whatsapp-marketing'`,
      [bizA.id],
    );
    const first = await addonService.notifyExpiringActivations();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = pushSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second run: flag is stamped → nothing new for that activation.
    const second = await addonService.notifyExpiringActivations();
    expect(second.notified).toBe(0);
    expect(pushSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
