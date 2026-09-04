// 2026-09-05 — the Pro plan must not advertise unlimited staff while capping
// staff at 10. Migration 090 removes the FEATURE KEY (the false claim), not
// the LIMIT (the enforced truth).
//
// THE BUG THIS LOCKS DOWN. Live `GET /v1/public/plans` shipped, for the
// Rs 799 plan named "Pro":
//
//     limits.staff = 10        featureKeys includes 'staff_unlimited'
//
// so `subscriptionService.enforceLimit('staff')` — which reads
// `plans.limits->>'staff'` and nothing else — refused the 11th staff login on
// a plan whose own feature list promised the opposite. Advanced (Rs 999) and
// Enterprise (Rs 1,999) carry `limits.staff = -1` and are internally
// consistent; they must KEEP the key.
//
// THE TRAP THIS ALSO LOCKS DOWN. `plan_features.tier_kind` holds a plan tier
// CODE, not a tier_kind (migration 040; documented by migration 088), and the
// codes collide with the kinds on the word "pro":
//
//     code 'pro_plan' -> the Rs 799 plan named "Pro"   <-- the row to delete
//     code 'pro'      -> the Rs 1,999 ENTERPRISE plan  <-- must not be touched
//     code 'advanced' -> the Rs 999 Advanced plan      <-- must not be touched
//
// Deleting the 'pro' row instead would strip unlimited staff from the most
// expensive plan on the ladder and leave the actual lie in place. Case 1
// below applies the real migration file to a database seeded with the live
// plan ladder and asserts exactly which of the three rows moved.
//
// Conventions follow the other suites: resetDb / makeBusiness / tokenFor.

jest.setTimeout(120000);

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');

const MIGRATION_090 = path.join(
  __dirname, '..', '..', 'db', 'migrations', '090_pro_staff_claim.sql',
);

let app;

// The LIVE five-plan ladder (verified against
// https://api.namastepos.in/v1/public/plans on 2026-09-05). No migration
// creates 'pro_plan' or 'advanced' — the founder created them through the
// admin plans editor — so a test that wants the production shape has to
// state it, exactly as plan_tier_ladder.test.js does.
//
//   [tier CODE, tier_kind, name, paise, limits.staff, grants staff_unlimited]
const LIVE_LADDER = [
  ['free', 'starter', 'Starter', 0, 1, false],
  ['basic', 'pro', 'Growth', 29900, 5, false],
  ['pro_plan', 'pro_plan', 'Pro', 79900, 10, true],
  ['advanced', 'advanced', 'Advanced', 99900, -1, true],
  ['pro', 'enterprise', 'Enterprise', 199900, -1, true],
];

// Feature keys every plan below carries, so no plan ends up with an empty row
// set (an empty set makes listTierFeatures fall through to its tier_kind
// fallback branch, which would muddy what this suite is measuring).
const BASE_KEYS = ['pos', 'orders', 'menu_basic', 'staff_lite'];

async function seedLiveLadder() {
  for (const [tier, kind, name, paise, staff, unlimited] of LIVE_LADDER) {
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, limits, features)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, $5::jsonb, '{}'::jsonb)
       ON CONFLICT (tier) DO UPDATE
         SET tier_kind = EXCLUDED.tier_kind,
             name = EXCLUDED.name,
             price_inr_paise = EXCLUDED.price_inr_paise,
             limits = EXCLUDED.limits,
             is_active = TRUE,
             is_public = TRUE`,
      [tier, kind, name, paise,
        JSON.stringify({ staff, menu_items: -1, monthly_orders: -1, businesses: 1 })],
    );
    // Written through setTierFeatures because that is what the admin plans
    // editor calls (PUT /v1/admin/tier-features/:tierKind), i.e. this is how
    // the production rows were actually created.
    await featureService.setTierFeatures(
      tier, unlimited ? [...BASE_KEYS, 'staff_unlimited'] : BASE_KEYS,
    );
  }
  featureService.clearAllCaches();
}

const grantsUnlimited = async (tierCode) => {
  const r = await query(
    `SELECT 1 FROM plan_features
      WHERE tier_kind = $1 AND feature_key = 'staff_unlimited'`,
    [tierCode],
  );
  return r.rowCount > 0;
};

const staffLimitOf = async (tierCode) => {
  const r = await query(
    `SELECT (limits->>'staff')::int AS staff
       FROM plans WHERE tier = $1`,
    [tierCode],
  );
  return r.rows[0].staff;
};

const applyMigration090 = () => query(fs.readFileSync(MIGRATION_090, 'utf8'));

beforeAll(async () => {
  // resetDb applies every migration including 090 — against a schema with no
  // 'pro_plan' plan, where 090 is a legitimate no-op. Case 1 then seeds the
  // pre-migration production state and applies 090 for real.
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

// ── 1. The migration moves exactly one row ────────────────────────────────

describe('migration 090 deletes the Pro staff_unlimited grant and nothing else',
  () => {
    beforeAll(async () => { await seedLiveLadder(); });

    it('starts from the contradictory live state', async () => {
      // Guard the guard: if this ever fails the rest of the suite is testing
      // a state production never had.
      expect(await grantsUnlimited('pro_plan')).toBe(true);
      expect(await staffLimitOf('pro_plan')).toBe(10);
      expect(await grantsUnlimited('advanced')).toBe(true);
      expect(await grantsUnlimited('pro')).toBe(true);
    });

    it('removes the grant from tier code pro_plan (the Rs 799 Pro plan)',
      async () => {
        await applyMigration090();
        featureService.clearAllCaches();
        expect(await grantsUnlimited('pro_plan')).toBe(false);
      });

    it('leaves Advanced and Enterprise unlimited-staff', async () => {
      // The row that is one keystroke away from the target. Deleting
      // tier_kind = 'pro' would strip the Rs 1,999 plan.
      expect(await grantsUnlimited('pro')).toBe(true);
      expect(await grantsUnlimited('advanced')).toBe(true);
    });

    it('does NOT raise the Pro staff cap — the ladder stays 1 / 5 / 10 / unlimited',
      async () => {
        expect(await staffLimitOf('free')).toBe(1);
        expect(await staffLimitOf('basic')).toBe(5);
        expect(await staffLimitOf('pro_plan')).toBe(10);
        expect(await staffLimitOf('advanced')).toBe(-1);
        expect(await staffLimitOf('pro')).toBe(-1);
      });

    it('touches no other feature key on any plan', async () => {
      for (const [tier] of LIVE_LADDER) {
        const keys = await featureService.listTierFeatures(tier, tier);
        for (const k of BASE_KEYS) expect(keys).toContain(k);
      }
    });

    it('is re-runnable: a second and third apply change nothing', async () => {
      const snapshot = async () => {
        const r = await query(
          `SELECT tier_kind, feature_key FROM plan_features
            ORDER BY tier_kind, feature_key`,
        );
        return JSON.stringify(r.rows);
      };
      const before = await snapshot();
      await applyMigration090();
      await applyMigration090();
      expect(await snapshot()).toBe(before);
      expect(await grantsUnlimited('pro_plan')).toBe(false);
      expect(await grantsUnlimited('advanced')).toBe(true);
      expect(await grantsUnlimited('pro')).toBe(true);
    });
  });

// ── 2. The public feed the landing page renders from ──────────────────────

describe('the public plans feed no longer over-claims on Pro', () => {
  let feed;

  beforeAll(async () => {
    const r = await request(app).get('/v1/public/plans');
    expect(r.status).toBe(200);
    feed = r.body.plans;
  });

  const byName = (n) => feed.find((p) => p.name === n);

  it('serves the live five-plan lineup', () => {
    expect(feed.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Starter', 'Growth', 'Pro', 'Advanced', 'Enterprise']),
    );
  });

  it('Pro: staff cap 10 and NO staff_unlimited claim', () => {
    const pro = byName('Pro');
    expect(pro.tier).toBe('pro_plan');
    expect(pro.limits.staff).toBe(10);
    // The two halves of the contradiction, asserted together so neither can
    // be "fixed" by drifting the other.
    expect(pro.featureKeys).not.toContain('staff_unlimited');
  });

  it('Advanced and Enterprise: unlimited cap AND the claim, still consistent',
    () => {
      for (const name of ['Advanced', 'Enterprise']) {
        const p = byName(name);
        expect([name, p.limits.staff]).toEqual([name, -1]);
        expect([name, p.featureKeys.includes('staff_unlimited')])
          .toEqual([name, true]);
      }
    });

  it('every plan in the feed is internally consistent about staff', () => {
    // The general rule, so the next plan added cannot reintroduce the defect:
    // claim unlimited staff only if the enforced limit is unlimited.
    for (const p of feed) {
      const claims = p.featureKeys.includes('staff_unlimited');
      const enforcedUnlimited = p.limits.staff === -1
        || p.limits.staff === undefined || p.limits.staff === null;
      expect([p.name, claims && !enforcedUnlimited]).toEqual([p.name, false]);
    }
  });
});

// ── 3. What the owner actually hits ───────────────────────────────────────

describe('enforcement matches the claim', () => {
  // Fill a business with N active non-owner staff. The owner is excluded from
  // the cap (currentUsage('staff') filters role <> 'business_owner'), so N is
  // the number that counts.
  async function fillStaff(businessId, n) {
    for (let i = 0; i < n; i += 1) {
      const u = await query(
        `INSERT INTO users (email, display_name, google_sub)
         VALUES ($1, $2, $3) RETURNING id`,
        [`seat-${i}-${businessId}@example.com`, `Seat ${i}`, `sub-seat-${i}-${businessId}`],
      );
      await query(
        `INSERT INTO business_users (business_id, user_id, role, is_active)
         VALUES ($1, $2, 'staff_waiter', TRUE)`,
        [businessId, u.rows[0].id],
      );
    }
  }

  async function onPlan(businessId, tierCode) {
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, (SELECT id FROM plans WHERE tier = $2), 'active',
               NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO UPDATE
         SET plan_id = (SELECT id FROM plans WHERE tier = $2),
             status = 'active',
             current_period_end = NOW() + INTERVAL '30 days'`,
      [businessId, tierCode],
    );
    featureService.clearCache(businessId);
  }

  // `phone` is the unique key for a PIN staff member, so it is required.
  const newStaff = (pin) => ({
    displayName: `Hire ${pin}`, role: 'staff_waiter', pin, phone: `9${pin}00000`,
  });

  it('a Pro business is REFUSED the 11th staff with the documented PLAN_LIMIT 403',
    async () => {
      const biz = await makeBusiness({ email: 'pro-staff-cap@example.com', name: 'Pro Dhaba' });
      const token = tokenFor(biz);
      await onPlan(biz.id, 'pro_plan');
      await fillStaff(biz.id, 10); // exactly at the cap

      const r = await request(app)
        .post(`/v1/businesses/${biz.id}/staff/pin`)
        .set({ Authorization: `Bearer ${token}` })
        .send(newStaff('1111'));

      expect(r.status).toBe(403);
      // The four keys the dashboard error interceptor and the
      // `plan_limit_hit` analytics hook read — never rename or drop them
      // (namastepos_dashboard/src/api/client.ts).
      expect(r.body.error).toBe('PLAN_LIMIT');
      expect(r.body.details).toMatchObject({
        metric: 'staff',
        limit: 10,
        current: 10,
        plan: 'pro_plan',
      });
      // Refused, not over-served: staff is a HARD metric.
      expect(r.body.details.enforcement).toBe('hard');
    });

  it('so the plan must not claim staff_unlimited — and no longer does',
    async () => {
      // Ties case 3 back to case 1: the refusal above is legitimate ONLY
      // because the plan has stopped promising otherwise.
      const keys = await featureService.listTierFeatures('pro_plan', 'pro_plan');
      expect(keys).not.toContain('staff_unlimited');
    });

  it('lets a Pro business add staff while still under the cap', async () => {
    const biz = await makeBusiness({ email: 'pro-staff-room@example.com', name: 'Pro Cafe' });
    const token = tokenFor(biz);
    await onPlan(biz.id, 'pro_plan');
    await fillStaff(biz.id, 9); // one seat left

    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/staff/pin`)
      .set({ Authorization: `Bearer ${token}` })
      .send(newStaff('2222'));
    expect(r.status).toBe(201);
  });

  it('an Advanced business is NOT refused the 11th staff', async () => {
    const biz = await makeBusiness({ email: 'adv-staff-cap@example.com', name: 'Advanced Hotel' });
    const token = tokenFor(biz);
    await onPlan(biz.id, 'advanced');
    await fillStaff(biz.id, 10); // where Pro walls off

    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/staff/pin`)
      .set({ Authorization: `Bearer ${token}` })
      .send(newStaff('3333'));
    expect(r.status).toBe(201);
  });

  it('nor is an Enterprise business', async () => {
    const biz = await makeBusiness({ email: 'ent-staff-cap@example.com', name: 'Enterprise Chain' });
    const token = tokenFor(biz);
    await onPlan(biz.id, 'pro'); // tier code 'pro' IS Enterprise
    await fillStaff(biz.id, 10);

    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/staff/pin`)
      .set({ Authorization: `Bearer ${token}` })
      .send(newStaff('4444'));
    expect(r.status).toBe(201);
  });
});
