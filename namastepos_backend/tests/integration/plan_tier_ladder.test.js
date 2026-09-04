// 2026-09-04 — the plan tier-kind ladder must never drift from the database.
//
// THE BUG THIS WOULD HAVE CAUGHT. `createPlanBody.tier_kind` was
// `Joi.string().valid('starter','pro','enterprise')` and the custom-plan
// schema's `tierKind` the same three values, while the live ladder has FIVE
// tier kinds (starter / pro / pro_plan / advanced / enterprise). So:
//   * POST /v1/admin/plans at Pro or Advanced level -> 400
//   * a STANDALONE custom plan (no basePlanTier, which must therefore state
//     its own tierKind) at Pro or Advanced level -> impossible
// Both schemas now derive their .valid() list from
// services/planTiers.TIER_KIND_LADDER, and this file asserts the derivation
// holds against whatever tier kinds actually exist in `plans`.
//
// The addonService rank table and the featureService upsell ladder had the
// same stale three-entry list; both now come from the same module, so the
// ordering assertions below cover them too.

jest.setTimeout(120000);

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');
const planTiers = require('../../src/services/planTiers');
const featureService = require('../../src/services/featureService');
const addonService = require('../../src/services/addonService');

// The Joi schemas under test, reached the way a request reaches them.
const adminController = require('../../src/controllers/adminController');

let app;
let adminToken;
let biz;

const auth = (t) => ({ Authorization: `Bearer ${t}`, Cookie: `ff_admin=${t}` });

async function makeAdminToken() {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ('tier-ladder-admin@namastepos.in', 'x-not-a-real-hash', 'super_admin', TRUE)
     RETURNING id, email`,
  );
  return issueAccessToken({
    sid: r.rows[0].id,
    isSuperAdmin: true,
    email: r.rows[0].email,
    role: 'super_admin',
  });
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  adminToken = await makeAdminToken();
  biz = await makeBusiness({ email: `tier-ladder-${Date.now()}@example.com` });

  // Mirror the LIVE production ladder into the test database, including the
  // two kinds the old hardcoded lists were missing and the code/kind
  // collision on 'pro' (code 'pro' = Enterprise, kind 'pro' = Growth, and
  // the plan named Pro is 'pro_plan' in both columns). Without these rows
  // the DB-vs-code assertion below has nothing to catch.
  const live = [
    ['free', 'starter', 'Starter', 0],
    ['basic', 'pro', 'Growth', 29900],
    ['pro_plan', 'pro_plan', 'Pro', 79900],
    ['advanced', 'advanced', 'Advanced', 99900],
    ['pro', 'enterprise', 'Enterprise', 199900],
  ];
  for (const [tier, kind, name, paise] of live) {
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          limits, features)
       VALUES ($1, $2, $3, $4, TRUE, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO UPDATE
         SET tier_kind = EXCLUDED.tier_kind,
             name = EXCLUDED.name,
             price_inr_paise = EXCLUDED.price_inr_paise,
             is_active = TRUE`,
      [tier, kind, name, paise],
    );
  }
});

afterAll(async () => { await closePool(); });

// ── 1. The ladder itself ──────────────────────────────────────────────────
describe('tier-kind ladder is well-formed', () => {
  it('is strictly ordered: rank is unique, gapless, and ascending', () => {
    const ranks = planTiers.TIER_KIND_LADDER.map((k) => planTiers.rankOf(k));
    expect(ranks).toEqual(planTiers.TIER_KIND_LADDER.map((_, i) => i));
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
    expect(new Set(planTiers.TIER_KIND_LADDER).size)
      .toBe(planTiers.TIER_KIND_LADDER.length);
  });

  it('ranks the live ladder cheapest-to-dearest', () => {
    // Guards against someone appending a rung in the wrong position: rank
    // order must match price order for the live five plans.
    expect(planTiers.TIER_KIND_LADDER).toEqual([
      'starter', 'pro', 'pro_plan', 'advanced', 'enterprise',
    ]);
  });

  it('labels every rung (so no UI ever shows a raw "pro_plan")', () => {
    for (const kind of planTiers.TIER_KIND_LADDER) {
      expect(typeof planTiers.TIER_KIND_LABELS[kind]).toBe('string');
      expect(planTiers.TIER_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
    expect(Object.keys(planTiers.TIER_KIND_LABELS).sort())
      .toEqual([...planTiers.TIER_KIND_LADDER].sort());
  });

  it('walks nextKindUp one rung at a time and stops at the top', () => {
    const ladder = planTiers.TIER_KIND_LADDER;
    for (let i = 0; i < ladder.length - 1; i += 1) {
      expect(planTiers.nextKindUp(ladder[i])).toBe(ladder[i + 1]);
    }
    expect(planTiers.nextKindUp(ladder[ladder.length - 1])).toBeNull();
  });

  it('never invents an upsell target for an unknown or custom plan', () => {
    // The old featureService fallback was `: 'pro'`, which pitched Growth
    // (Rs 299) to a Pro (Rs 799) tenant — a downgrade sold as an upgrade.
    expect(featureService.nextTierUp('pro_plan')).toBe('advanced');
    expect(featureService.nextTierUp('advanced')).toBe('enterprise');
    expect(featureService.nextTierUp('enterprise')).toBeNull();
    expect(featureService.nextTierUp('custom-deadbeef')).toBeNull();
    expect(featureService.nextTierUp('nonsense')).toBeNull();
    expect(featureService.nextTierUp(undefined)).toBeNull();
  });

  it('ranks a higher kind above a lower one, and fails closed on unknown', () => {
    expect(planTiers.meetsKind('advanced', 'pro')).toBe(true);
    expect(planTiers.meetsKind('pro_plan', 'pro')).toBe(true);
    expect(planTiers.meetsKind('pro', 'pro_plan')).toBe(false);
    // Unknown ranks lowest — a mis-tagged plan must not grant entitlement.
    expect(planTiers.meetsKind('who_knows', 'pro')).toBe(false);
    expect(planTiers.rankForGate('who_knows')).toBe(0);
  });
});

// ── 2. THE REGRESSION: DB vs code ─────────────────────────────────────────
describe('every tier_kind in the database is known to the code', () => {
  it('has a rank in the ladder', async () => {
    const r = await query(
      'SELECT DISTINCT tier_kind FROM plans WHERE tier_kind IS NOT NULL',
    );
    const kinds = r.rows.map((x) => x.tier_kind);
    expect(kinds.length).toBeGreaterThan(0);
    const unknown = kinds.filter((k) => planTiers.rankOf(k) === null);
    expect(unknown).toEqual([]); // add the kind to TIER_KIND_LADDER
  });

  it('is accepted by the admin create-plan schema', async () => {
    const r = await query(
      'SELECT DISTINCT tier_kind FROM plans WHERE tier_kind IS NOT NULL',
    );
    for (const { tier_kind: kind } of r.rows) {
      const { error } = adminController.createPlanBody.validate({
        tier: 'schema_probe_tier',
        tier_kind: kind,
        name: 'Schema probe',
        price_inr_paise: 10000,
      });
      // A stale .valid() list is exactly what shipped today's bug.
      expect(error ? `${kind}: ${error.message}` : null).toBeNull();
    }
  });

  it('is accepted by the admin custom-plan schema', async () => {
    const r = await query(
      'SELECT DISTINCT tier_kind FROM plans WHERE tier_kind IS NOT NULL',
    );
    for (const { tier_kind: kind } of r.rows) {
      const { error } = adminController.putCustomPlanBody.validate({
        name: 'Schema probe',
        priceInrPaise: 10000,
        tierKind: kind,
      });
      expect(error ? `${kind}: ${error.message}` : null).toBeNull();
    }
  });

  it('is accepted by the addons required_tier_kind CHECK constraint', async () => {
    // Migration 078 pinned that CHECK to the same stale three kinds;
    // migration 088 widened it to the ladder. Assert they agree.
    for (const kind of planTiers.TIER_KIND_LADDER) {
      await expect(query(
        `UPDATE addons SET required_tier_kind = $1
          WHERE slug = (SELECT slug FROM addons LIMIT 1)`,
        [kind],
      )).resolves.toBeTruthy();
    }
  });
});

// ── 3. The two API calls that used to 400 ─────────────────────────────────
describe('admin can create plans at every rung of the ladder', () => {
  it('POST /v1/admin/plans accepts every tier_kind', async () => {
    for (const [i, kind] of planTiers.TIER_KIND_LADDER.entries()) {
      const tier = `ladder_probe_${i}`;
      await query('DELETE FROM plans WHERE tier = $1', [tier]);
      const r = await request(app)
        .post('/v1/admin/plans')
        .set(auth(adminToken))
        .send({
          tier,
          tier_kind: kind,
          name: `Ladder probe ${kind}`,
          price_inr_paise: 50000,
        });
      expect([kind, r.status]).toEqual([kind, 201]);
      expect(r.body.plan.tierKind).toBe(kind);
    }
  });

  it('a STANDALONE custom plan can be created at Pro and Advanced level', async () => {
    // No basePlanTier -> the schema requires priceInrPaise + tierKind, and
    // the only Pro/Advanced values it could be given were rejected outright.
    for (const kind of ['pro_plan', 'advanced']) {
      const r = await request(app)
        .put(`/v1/admin/customers/${biz.id}/custom-plan`)
        .set(auth(adminToken))
        .send({
          name: `Bespoke ${kind}`,
          priceInrPaise: 149900,
          tierKind: kind,
          extraFeatureKeys: ['kds'],
        });
      expect([kind, r.status]).toEqual([kind, 200]);
      expect(r.body.plan.tierKind).toBe(kind);
    }
  });

  it('PUT /v1/admin/plans/:tier still rejects a kind off the ladder', async () => {
    // updatePlan had NO body validation at all — the mirror image of the
    // create path's over-restriction. Both now derive from the ladder.
    const r = await request(app)
      .put('/v1/admin/plans/basic')
      .set(auth(adminToken))
      .send({ tier_kind: 'platinum_deluxe' });
    expect(r.status).toBe(400);
  });
});

// ── 4. Addon eligibility across the whole ladder ──────────────────────────
describe('addon eligibility ranks the full ladder', () => {
  it('a Pro-or-above addon is allowed on Pro, Advanced and Enterprise', async () => {
    // The stale KIND_ORDER had no entry for 'pro_plan' or 'advanced', so
    // both ranked 0 and were REFUSED an addon a Rs 299 Growth tenant could
    // buy. Checked at the service seam, no payment involved.
    for (const kind of ['pro', 'pro_plan', 'advanced', 'enterprise']) {
      const gate = await addonService.checkPlanEligibility(
        biz.id, { required_tier_kind: 'pro' },
      );
      // checkPlanEligibility reads the tenant's live plan, so drive the
      // tenant onto a plan of this kind first.
      expect(gate).toBeTruthy();
      await query(
        `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
         VALUES ($1, (SELECT id FROM plans WHERE tier_kind = $2 AND business_id IS NULL LIMIT 1),
                 'active', NOW() + INTERVAL '30 days')
         ON CONFLICT (business_id) DO UPDATE
           SET plan_id = (SELECT id FROM plans WHERE tier_kind = $2 AND business_id IS NULL LIMIT 1),
               status = 'active'`,
        [biz.id, kind],
      );
      featureService.clearCache(biz.id);
      const after = await addonService.checkPlanEligibility(
        biz.id, { required_tier_kind: 'pro' },
      );
      expect([kind, after.ok]).toEqual([kind, true]);
    }
  });

  it('and refused on the bottom rung', async () => {
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, (SELECT id FROM plans WHERE tier = 'free'), 'active',
               NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO UPDATE
         SET plan_id = (SELECT id FROM plans WHERE tier = 'free'), status = 'active'`,
      [biz.id],
    );
    featureService.clearCache(biz.id);
    const gate = await addonService.checkPlanEligibility(
      biz.id, { required_tier_kind: 'pro' },
    );
    expect(gate.ok).toBe(false);
  });
});
