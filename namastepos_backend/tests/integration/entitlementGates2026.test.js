// Entitlements review fixes (2026-09-05, fixer BE-A). One regression test per
// item; each describe names the review ID it pins.
//
//   E1  featuresFor / listTierFeatures: a plan with ZERO plan_features rows
//       whose tier_kind is also a plan CODE ('pro' = Enterprise) must resolve
//       to the EMPTY set, never to Enterprise's rows.
//   A7  an expired paid addon's grants_features no longer flow through
//       hasFeature(); the cache entry is capped at the addon's period end.
//   F1  one assertKnownFeatureKeys() helper rejects unknown keys (400,
//       details.unknownFeatureKeys) on ALL four admin write paths.
//   F2  PUT /admin/tier-features/:code refuses an unknown plan code and
//       refuses to remove 'pos'.
//   F3  plan `limits` are validated: integer >= -1, known metric names only.
//   D1  /ingredients opens for a plan that GRANTS recipe_costing (no addon).
//   B12 aggregator webhook PARKS (202) a new order for a tenant whose plan
//       lacks 'aggregators'; lifecycle events for existing orders still apply.
//   B2/B3/B5/B7/B9 — the repaired featureGate rules 402 a Starter tenant on
//       the routes that used to be open.

jest.setTimeout(120000);

const crypto = require('crypto');
const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');
const featureFlags = require('../../src/services/featureFlagsService');
const planTiers = require('../../src/services/planTiers');

let app;
let biz; let token;
let adminToken;

const auth = (t) => ({ Authorization: `Bearer ${t}`, Cookie: `ff_admin=${t}` });
const url = (p) => `/v1/businesses/${biz.id}${p}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function makeAdminToken() {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ('gates2026-admin@namastepos.in', 'x-not-a-real-hash', 'super_admin', TRUE)
     RETURNING id, email`,
  );
  return issueAccessToken({
    sid: r.rows[0].id, isSuperAdmin: true, email: r.rows[0].email, role: 'super_admin',
  });
}

/** Put `businessId` on the plan with tier code `tier`, active for 30 days. */
async function putOnPlan(businessId, tier) {
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, (SELECT id FROM plans WHERE tier = $2 LIMIT 1), 'active', NOW() + INTERVAL '30 days')
     ON CONFLICT (business_id) DO UPDATE
       SET plan_id = (SELECT id FROM plans WHERE tier = $2 LIMIT 1),
           status = 'active', current_period_end = NOW() + INTERVAL '30 days',
           updated_at = NOW()`,
    [businessId, tier],
  );
  featureService.clearCache(businessId);
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: 'gates2026-owner@example.com', name: 'Gates 2026' });
  token = tokenFor(biz);
  await putOnPlan(biz.id, planTiers.FALLBACK_PLAN_CODE); // Starter
  adminToken = await makeAdminToken();
});

afterAll(async () => {
  await closePool();
});

// ── E1 ────────────────────────────────────────────────────────────────────
describe("E1 — tier_kind fallback can never hand a plan another plan's matrix", () => {
  const EMPTY_GROWTH = 'e1_growth_empty'; // kind 'pro' (Growth) — the trap kind
  let enterpriseKeys;

  beforeAll(async () => {
    // Sanity: the trap is real in this schema — the CODE 'pro' has rows.
    const ent = await query("SELECT feature_key FROM plan_features WHERE tier_kind = 'pro'");
    enterpriseKeys = ent.rows.map((r) => r.feature_key);
    expect(enterpriseKeys.length).toBeGreaterThan(0);
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, is_public, limits, features)
       VALUES ($1, 'pro', 'E1 Growth (no features yet)', 29900, TRUE, TRUE, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO NOTHING`,
      [EMPTY_GROWTH],
    );
  });

  afterAll(async () => {
    await putOnPlan(biz.id, planTiers.FALLBACK_PLAN_CODE);
    await query('DELETE FROM subscriptions WHERE plan_id = (SELECT id FROM plans WHERE tier = $1)', [EMPTY_GROWTH]);
    await query('DELETE FROM plans WHERE tier = $1', [EMPTY_GROWTH]);
    featureService.clearAllCaches();
  });

  it('listTierFeatures(code, kind="pro") with no rows is EMPTY, not Enterprise', async () => {
    const keys = await featureService.listTierFeatures(EMPTY_GROWTH, 'pro');
    expect(keys).toEqual([]);
  });

  it('a tenant on that plan has NO features (was: all of Enterprise)', async () => {
    await putOnPlan(biz.id, EMPTY_GROWTH);
    const summary = await featureService.planSummary(biz.id);
    expect(summary.tier).toBe(EMPTY_GROWTH);
    expect(summary.tierKind).toBe('pro');
    expect(summary.features).toEqual([]);
    for (const k of enterpriseKeys) {
      expect(await featureService.hasFeature(biz.id, k)).toBe(false);
    }
  });

  it('the fallback still serves a kind that is NOT also a plan code (legacy rows)', async () => {
    // A kind string no plan uses as its code: rows keyed by it are genuine
    // legacy kind-defaults and may be used. (Not 'enterprise' — the seed still
    // carries the pre-migration-040 kind rows for it, so the result would not
    // be ours to assert on.)
    await query("INSERT INTO plan_features (tier_kind, feature_key) VALUES ('e1_legacy_kind', 'wastage') ON CONFLICT DO NOTHING");
    try {
      const keys = await featureService.listTierFeatures('e1_no_such_plan', 'e1_legacy_kind');
      expect(keys).toEqual(['wastage']);
    } finally {
      await query("DELETE FROM plan_features WHERE tier_kind = 'e1_legacy_kind'");
    }
  });

  it('never falls back to a kind string that some plan uses as its code, even a minted one', async () => {
    // Super-admin can mint arbitrary codes (migration 039). A plan coded
    // 'platinum' means the kind-ish string 'platinum' is off limits as a fallback.
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, is_public, limits, features)
       VALUES ('platinum', 'advanced', 'Platinum', 1, TRUE, FALSE, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO NOTHING`,
    );
    await query("INSERT INTO plan_features (tier_kind, feature_key) VALUES ('platinum', 'wastage') ON CONFLICT DO NOTHING");
    try {
      expect(await featureService.listTierFeatures('e1_other_plan', 'platinum')).toEqual([]);
    } finally {
      await query("DELETE FROM plan_features WHERE tier_kind = 'platinum'");
      await query("DELETE FROM plans WHERE tier = 'platinum'");
    }
  });
});

// ── A7 ────────────────────────────────────────────────────────────────────
describe('A7 — an expired paid addon no longer grants features', () => {
  let addonId;
  const setPeriodEnd = async (sql) => {
    await query(
      `INSERT INTO business_addons (business_id, addon_id, status, current_period_end)
       VALUES ($1, $2, 'active', ${sql})
       ON CONFLICT (business_id, addon_id) DO UPDATE
         SET status = 'active', cancelled_at = NULL, cancel_at_period_end = FALSE,
             current_period_end = ${sql}`,
      [biz.id, addonId],
    );
    featureService.clearCache(biz.id);
  };

  beforeAll(async () => {
    const a = await query("SELECT id FROM addons WHERE slug = 'whatsapp-marketing'");
    addonId = a.rows[0].id;
    // Starter does not carry whatsapp_marketing on its own.
    expect(await featureService.hasFeature(biz.id, 'whatsapp_marketing')).toBe(false);
  });

  afterAll(async () => {
    await query('DELETE FROM business_addons WHERE business_id = $1 AND addon_id = $2', [biz.id, addonId]);
    featureService.clearCache(biz.id);
  });

  it('status=active but period ended → grants_features are NOT in hasFeature / auth-me set', async () => {
    await setPeriodEnd("NOW() - INTERVAL '1 minute'");
    expect(await featureService.hasFeature(biz.id, 'whatsapp_marketing')).toBe(false);
    expect((await featureService.planSummary(biz.id)).features).not.toContain('whatsapp_marketing');
    // …and the gated route agrees (B2 rule + A7 together).
    const r = await request(app).get(url('/wa/campaigns')).set(auth(token));
    expect(r.status).toBe(402);
    expect(r.body.feature).toBe('whatsapp_marketing');
  });

  it('a running period still grants', async () => {
    // (current_period_end is NOT NULL in the schema; the IS NULL branch in the
    // query is defensive only.)
    await setPeriodEnd("NOW() + INTERVAL '10 days'");
    expect(await featureService.hasFeature(biz.id, 'whatsapp_marketing')).toBe(true);
  });

  it('the cache entry is capped at the addon period end, so the grant lapses ON time', async () => {
    await setPeriodEnd("NOW() + INTERVAL '1500 milliseconds'");
    expect(await featureService.hasFeature(biz.id, 'whatsapp_marketing')).toBe(true);
    // No clearCache: the 60s soft TTL alone would keep saying true.
    await sleep(1700);
    expect(await featureService.hasFeature(biz.id, 'whatsapp_marketing')).toBe(false);
  });
});

// ── F1 ────────────────────────────────────────────────────────────────────
describe('F1 — every admin write path rejects unknown feature keys the same way', () => {
  const expect400 = (r, key) => {
    expect(r.status).toBe(400);
    expect(r.body.details?.unknownFeatureKeys).toEqual([key]);
    expect(r.body.message).toMatch(/feature-catalog/);
  };

  it('assertKnownFeatureKeys: helper contract', async () => {
    await expect(featureService.assertKnownFeatureKeys(['kds', 'nope_key']))
      .rejects.toMatchObject({ statusCode: 400, details: { unknownFeatureKeys: ['nope_key'] } });
    expect(await featureService.assertKnownFeatureKeys(['kds', 'kds', '', null])).toEqual(['kds']);
    expect(await featureService.assertKnownFeatureKeys([])).toEqual([]);
  });

  it('per-business overrides (PUT /admin/customers/:id/feature-overrides)', async () => {
    const r = await request(app)
      .put(`/v1/admin/customers/${biz.id}/feature-overrides`).set(auth(adminToken))
      .send({ overrides: [{ featureKey: 'wastage', mode: 'enable' }, { featureKey: 'wastge', mode: 'enable' }] });
    expect400(r, 'wastge');
    // Nothing was written — the transaction never started.
    const rows = await query('SELECT 1 FROM business_feature_overrides WHERE business_id = $1', [biz.id]);
    expect(rows.rowCount).toBe(0);
    // The service-level single write is covered too (internal callers).
    await expect(featureFlags.override(biz.id, 'wastge', true))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('custom plan extraFeatureKeys (PUT /admin/customers/:id/custom-plan) — no plan row is left behind', async () => {
    const r = await request(app)
      .put(`/v1/admin/customers/${biz.id}/custom-plan`).set(auth(adminToken))
      .send({
        name: 'Bad extras',
        priceInrPaise: 100,
        tierKind: 'pro',
        extraFeatureKeys: ['pos', 'loyaltyy'],
      });
    expect400(r, 'loyaltyy');
    const plan = await query('SELECT 1 FROM plans WHERE business_id = $1', [biz.id]);
    expect(plan.rowCount).toBe(0);
  });

  it('addon grants_features (POST + PUT /admin/addons)', async () => {
    const create = await request(app)
      .post('/v1/admin/addons').set(auth(adminToken))
      .send({
        slug: 'gates2026-addon',
        name: 'Gates addon',
        category: 'operations',
        price_inr_paise: 0,
        grantsFeatures: ['kds', 'kdz'],
      });
    expect400(create, 'kdz');
    expect((await query("SELECT 1 FROM addons WHERE slug = 'gates2026-addon'")).rowCount).toBe(0);

    const update = await request(app)
      .put('/v1/admin/addons/whatsapp-marketing').set(auth(adminToken))
      .send({ grants_features: ['whatsapp_marketting'] });
    expect400(update, 'whatsapp_marketting');
    const row = await query("SELECT grants_features FROM addons WHERE slug = 'whatsapp-marketing'");
    expect(row.rows[0].grants_features).toEqual(['whatsapp_marketing']); // untouched

    // A valid grant still saves (camelCase form).
    const ok = await request(app)
      .put('/v1/admin/addons/whatsapp-marketing').set(auth(adminToken))
      .send({ grantsFeatures: ['whatsapp_marketing', 'auto_whatsapp_order'] });
    expect(ok.status).toBe(200);
    await request(app)
      .put('/v1/admin/addons/whatsapp-marketing').set(auth(adminToken))
      .send({ grantsFeatures: ['whatsapp_marketing'] })
      .expect(200);
  });

  it('plan matrix (PUT /admin/tier-features/:code) — still rejects, via the same helper', async () => {
    const r = await request(app)
      .put('/v1/admin/tier-features/free').set(auth(adminToken))
      .send({ features: ['pos', 'ordersss'] });
    expect400(r, 'ordersss');
  });
});

// ── F2 ────────────────────────────────────────────────────────────────────
describe('F2 — tier-features editor guards', () => {
  it('refuses a tier code no plan has', async () => {
    const r = await request(app)
      .put('/v1/admin/tier-features/no_such_plan_code').set(auth(adminToken))
      .send({ features: ['pos'] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/No plan has the tier code/);
  });

  it("refuses to remove 'pos'; accepts the unchanged set with pos", async () => {
    const before = (await request(app)
      .get('/v1/admin/tier-features/free').set(auth(adminToken))).body.features;
    expect(before).toContain('pos');

    const r = await request(app)
      .put('/v1/admin/tier-features/free').set(auth(adminToken))
      .send({ features: before.filter((k) => k !== 'pos') });
    expect(r.status).toBe(400);
    expect(r.body.details?.missingFeatureKeys).toEqual(['pos']);
    // Nothing changed.
    const after = (await request(app)
      .get('/v1/admin/tier-features/free').set(auth(adminToken))).body.features;
    expect(after).toEqual(before);

    const ok = await request(app)
      .put('/v1/admin/tier-features/free').set(auth(adminToken))
      .send({ features: before });
    expect(ok.status).toBe(200);
    expect(ok.body.features.sort()).toEqual([...before].sort());
  });
});

// ── F3 ────────────────────────────────────────────────────────────────────
describe('F3 — plan limits are validated (no NaN fail-open, no unknown metric)', () => {
  const put = (body) => request(app).put('/v1/admin/plans/free').set(auth(adminToken)).send(body);

  it('rejects a non-numeric value', async () => {
    const r = await put({ limits: { staff: 'ten' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.details)).toMatch(/limits\.staff/);
  });

  it('rejects a typo\'d metric name', async () => {
    const r = await put({ limits: { staf: 5 } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.details)).toMatch(/not a plan limit/);
  });

  it('rejects a fraction and anything below -1', async () => {
    expect((await put({ limits: { tables: 2.5 } })).status).toBe(400);
    expect((await put({ limits: { tables: -2 } })).status).toBe(400);
  });

  it('accepts every known metric including businesses and -1 (unchanged values)', async () => {
    const cur = (await query("SELECT limits FROM plans WHERE tier = 'free'")).rows[0].limits;
    const limits = typeof cur === 'string' ? JSON.parse(cur) : cur;
    const r = await put({ limits: { ...limits, businesses: limits.businesses ?? 1 } });
    expect(r.status).toBe(200);
    const created = await request(app).post('/v1/admin/plans').set(auth(adminToken)).send({
      tier: 'gates2026_plan',
      tier_kind: 'starter',
      name: 'Gates plan',
      limits: { staff: -1, floors: 1, tables: 1, menu_items: 1, monthly_orders: 1, businesses: 2 },
    });
    expect(created.status).toBe(201);
    await query("DELETE FROM plan_features WHERE tier_kind = 'gates2026_plan'");
    await query("DELETE FROM plans WHERE tier = 'gates2026_plan'");
  });

  it('custom-plan limits use the same schema (businesses now settable, typo rejected)', async () => {
    const bad = await request(app)
      .put(`/v1/admin/customers/${biz.id}/custom-plan`).set(auth(adminToken))
      .send({ name: 'x', priceInrPaise: 1, tierKind: 'starter', limits: { staf: 1 } });
    expect(bad.status).toBe(400);
    expect((await query('SELECT 1 FROM plans WHERE business_id = $1', [biz.id])).rowCount).toBe(0);
  });
});

// ── D1 ────────────────────────────────────────────────────────────────────
describe('D1 — /ingredients opens for a plan that grants recipe_costing (no addon needed)', () => {
  afterAll(async () => {
    await featureFlags.remove(biz.id, 'recipe_costing');
  });

  it('Starter: 402 (plan gate) — no addon, no feature', async () => {
    const r = await request(app).get(url('/ingredients')).set(auth(token));
    expect(r.status).toBe(402);
  });

  it('with the plan feature only (override), the router-level addon check passes', async () => {
    await featureFlags.override(biz.id, 'recipe_costing', true);
    const noAddon = await query(
      `SELECT 1 FROM business_addons ba JOIN addons a ON a.id = ba.addon_id
        WHERE ba.business_id = $1 AND a.slug = 'recipe-costing'`,
      [biz.id],
    );
    expect(noAddon.rowCount).toBe(0);
    const r = await request(app).get(url('/ingredients')).set(auth(token));
    expect(r.status).toBe(200); // was 402 ADDON_REQUIRED
    expect(r.body).toHaveProperty('ingredients');
  });
});

// ── B2 / B3 / B5 / B7 / B9 ─────────────────────────────────────────────────
describe('repaired featureGate rules 402 a Starter tenant on the routes that were open', () => {
  const cases = [
    ['B2', 'get', '/wa/campaigns', 'whatsapp_marketing'],
    ['B2', 'post', '/wa/campaigns', 'whatsapp_marketing'],
    ['B3', 'post', '/sessions/00000000-0000-0000-0000-000000000001/split', 'bill_split'],
    ['B3', 'get', '/sessions/00000000-0000-0000-0000-000000000001/splits', 'bill_split'],
    ['B7', 'get', '/fx/INR/USD', 'multi_currency_fx'],
    ['B9', 'post', '/orders/00000000-0000-0000-0000-000000000001/assign-driver', 'driver_mode'],
  ];
  it.each(cases)('%s %s %s → 402 %s', async (_id, method, path, feature) => {
    const r = await request(app)[method](url(path)).set(auth(token)).send({});
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
    expect(r.body.feature).toBe(feature);
  });

  it('B5 qr_ordering: the QR routes follow the key (402 without, open with)', async () => {
    // The live Starter plan grants qr_ordering; the test seed does not. Either
    // way the point is the same: before this fix the rule matched nothing, so
    // granting or removing the key in admin changed nothing on these routes.
    const has = await featureService.hasFeature(biz.id, 'qr_ordering');
    await featureFlags.override(biz.id, 'qr_ordering', !has);
    try {
      const flipped = await request(app).get(url('/ops/qr/settings')).set(auth(token));
      if (has) {
        expect(flipped.status).toBe(402);
        expect(flipped.body.feature).toBe('qr_ordering');
      } else {
        expect(flipped.status).not.toBe(402);
      }
      await featureFlags.override(biz.id, 'qr_ordering', has);
      const back = await request(app).get(url('/ops/qr/settings')).set(auth(token));
      if (has) expect(back.status).not.toBe(402);
      else {
        expect(back.status).toBe(402);
        expect(back.body.feature).toBe('qr_ordering');
      }
    } finally {
      await featureFlags.remove(biz.id, 'qr_ordering');
    }
  });

  it('the wider match strings leave Starter surfaces alone', async () => {
    for (const p of ['/ops/tables', '/wait-list', '/wastage']) {
      const r = await request(app).get(url(p)).set(auth(token));
      // These may be 200 or 402 for their OWN keys — never for the new ones.
      expect(['whatsapp_marketing', 'bill_split', 'qr_ordering', 'multi_currency_fx'])
        .not.toContain(r.body?.feature);
    }
  });
});

// ── B12 ───────────────────────────────────────────────────────────────────
describe('B12 — aggregator webhook parks new orders for a plan without aggregators', () => {
  const SECRET = 'gates2026-hook-secret';
  let outletId;
  let itemId;

  const post = async (payload) => {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return request(app)
      .post('/v1/aggregator-webhooks/zomato')
      .set('Content-Type', 'application/json')
      .set('x-outlet-id', outletId)
      .set('x-zomato-signature', sig)
      .send(raw);
  };
  const orderCount = async () => (await query(
    'SELECT COUNT(*)::int AS c FROM orders WHERE business_id = $1', [biz.id],
  )).rows[0].c;

  beforeAll(async () => {
    outletId = `OUT-${biz.id.slice(0, 8)}`;
    await query(
      `INSERT INTO aggregator_credentials (business_id, provider, outlet_id, api_key, webhook_secret, is_active)
       VALUES ($1, 'zomato', $2, 'k', $3, TRUE)
       ON CONFLICT (business_id, provider) DO UPDATE
         SET outlet_id = EXCLUDED.outlet_id, webhook_secret = EXCLUDED.webhook_secret, is_active = TRUE`,
      [biz.id, outletId, SECRET],
    );
    const m = await query(
      `INSERT INTO menu_items (business_id, name, price, category, is_active, external_skus)
       VALUES ($1, 'Paneer Tikka', 220, 'starter', TRUE, '{"zomato":"ZSKU-1"}'::jsonb) RETURNING id`,
      [biz.id],
    );
    itemId = m.rows[0].id;
    expect(await featureService.hasFeature(biz.id, 'aggregators')).toBe(false);
  });

  afterAll(async () => {
    await featureFlags.remove(biz.id, 'aggregators');
  });

  const newOrder = (id) => ({
    event: 'order.placed',
    order: {
      id, // what _externalIdOf() logs the inbound event under
      order_id: id, // what _normaliseZomato() stamps on the order
      customer: { name: 'Zomato Diner', phone: '9811111111' },
      items: [{ menu_id: 'ZSKU-1', name: 'Paneer Tikka', unit_price: 220, quantity: 1 }],
      taxes_total: 11,
    },
  });

  it('202 + parked, no order row, and the sync badge records WHY', async () => {
    const before = await orderCount();
    const r = await post(newOrder('ZO-PARK-1'));
    expect(r.status).toBe(202);
    expect(r.body.parked).toBe(true);
    expect(r.body.reason).toBe('FEATURE_LOCKED');
    expect(r.body.feature).toBe('aggregators');
    expect(await orderCount()).toBe(before);
    const health = await query(
      "SELECT last_error FROM aggregator_health WHERE business_id = $1 AND provider = 'zomato'", [biz.id],
    );
    expect(health.rows[0].last_error).toMatch(/aggregators/);
    // The inbound event is kept for replay and NOT marked handled.
    const ev = await query(
      "SELECT handled FROM aggregator_inbound_events WHERE business_id = $1 AND external_id = 'ZO-PARK-1'",
      [biz.id],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].handled).toBe(false);
  });

  it('a lifecycle event for an EXISTING order still applies without the feature', async () => {
    const o = await query(
      `INSERT INTO orders (business_id, order_no, source, channel, customer_name, customer_phone,
                           subtotal, tax, discount, total, status, fulfilment_state, aggregator_order_id)
       VALUES ($1, 9901, 'other', 'zomato', 'R', '9800000001', 220, 11, 0, 231, 'pending', 'placed', 'ZO-EXIST-1')
       RETURNING id`,
      [biz.id],
    );
    const r = await post({ event: 'order.cancelled', order_id: 'ZO-EXIST-1', reason: 'diner' });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe('cancelled');
    const row = await query('SELECT fulfilment_state FROM orders WHERE id = $1', [o.rows[0].id]);
    expect(row.rows[0].fulfilment_state).toBe('cancelled');
  });

  it('once the plan grants aggregators, the SAME retried payload is processed (not a duplicate)', async () => {
    await featureFlags.override(biz.id, 'aggregators', true);
    const before = await orderCount();
    const r = await post(newOrder('ZO-PARK-1'));
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(await orderCount()).toBe(before + 1);
    const created = await query(
      "SELECT id FROM orders WHERE business_id = $1 AND aggregator_order_id = 'ZO-PARK-1'", [biz.id],
    );
    expect(created.rowCount).toBe(1);
    expect(itemId).toBeTruthy();
  });
});
