// Decision 4 (2026-09-04): TRIAL_PLAN_TIER is set to `pro_plan` on Render, so
// every trial that does not name its own plan provisions on Pro (Rs 799).
//
// `pro_plan` is the value that is easiest to get wrong, because the tier CODE
// namespace collides with the tier KIND namespace on the word "pro":
//
//   plans.tier = 'free'      -> Starter     plans.tier_kind = 'starter'
//   plans.tier = 'basic'     -> Growth      plans.tier_kind = 'pro'      <-- !
//   plans.tier = 'pro_plan'  -> Pro         plans.tier_kind = 'pro_plan'
//   plans.tier = 'advanced'  -> Advanced    plans.tier_kind = 'advanced'
//   plans.tier = 'pro'       -> Enterprise  plans.tier_kind = 'enterprise' <-- !
//
// TRIAL_PLAN_TIER is matched against `plans.tier` (a CODE), so `pro_plan` is
// the plan named Pro — correct. Setting it to `pro` would silently trial
// ENTERPRISE, and setting it to `pro_plan` while reading the KIND column would
// find nothing. These tests pin both halves down.
//
// The env var must be set BEFORE src/config/env is first required, which is
// why it is assigned above the requires rather than in a beforeAll.

process.env.TRIAL_PLAN_TIER = 'pro_plan';

// eslint-disable-next-line import/order
const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const authService = require('../../src/services/authService');
const subService = require('../../src/services/subscriptionService');
const featureService = require('../../src/services/featureService');
const planTiers = require('../../src/services/planTiers');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  // The migration-seeded test ladder is free / basic / pro. Add the two rows
  // that make it the LIVE five-plan ladder, so `pro_plan` and the 'pro' trap
  // both exist and can be told apart.
  const live = [
    ['pro_plan', 'pro_plan', 'Pro', 79900, { staff: 10, floors: 2, tables: -1, businesses: 1, menu_items: -1, monthly_orders: -1 }],
    ['advanced', 'advanced', 'Advanced', 99900, { staff: -1, floors: -1, tables: -1, businesses: 3, menu_items: -1, monthly_orders: -1 }],
  ];
  for (const [tier, kind, name, paise, limits] of live) {
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, limits)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, $5::jsonb)
       ON CONFLICT (tier) DO UPDATE
         SET tier_kind = EXCLUDED.tier_kind, name = EXCLUDED.name,
             price_inr_paise = EXCLUDED.price_inr_paise, is_active = TRUE`,
      [tier, kind, name, paise, JSON.stringify(limits)],
    );
  }
  // Enterprise is 'pro' at Rs 1,999 in production; mirror the price so a
  // mis-resolution is unmistakable in the assertions.
  await query("UPDATE plans SET name = 'Enterprise', price_inr_paise = 199900 WHERE tier = 'pro'");
});
afterAll(async () => { await closePool(); });

const subFor = async (businessId) => {
  const r = await query(
    `SELECT s.*, p.tier AS plan_tier, p.tier_kind AS plan_kind, p.name AS plan_name,
            p.price_inr_paise
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1`,
    [businessId],
  );
  return r.rows[0] || null;
};

describe('TRIAL_PLAN_TIER=pro_plan resolves to the plan named Pro', () => {
  it('reads the env value verbatim', () => {
    expect(env.TRIAL_PLAN_TIER).toBe('pro_plan');
  });

  it('resolveTrialPlanId(no request) returns the Pro plan, not Growth or Enterprise', async () => {
    const id = await authService.resolveTrialPlanId(null);
    const r = await query('SELECT tier, tier_kind, name, price_inr_paise FROM plans WHERE id = $1', [id]);
    expect(r.rows[0].tier).toBe('pro_plan');
    expect(r.rows[0].name).toBe('Pro');
    expect(r.rows[0].price_inr_paise).toBe(79900);
    // NOT the cheapest paid plan (Growth, Rs 299) — the env default beats the
    // runtime fallback, which is the whole point of setting it.
    expect(r.rows[0].tier).not.toBe('basic');
    // And NOT Enterprise, whose CODE is the bare string 'pro'.
    expect(r.rows[0].tier_kind).not.toBe('enterprise');
  });

  it('provisions a real signup onto Pro, trialing and time-boxed', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trialtier-default@example.com',
      password: 'correct-horse-battery',
      businessName: 'Env Default Cafe',
    });
    expect(r.status).toBe(201);
    const sub = await subFor(r.body.business.id);
    expect(sub.plan_tier).toBe('pro_plan');
    expect(sub.plan_kind).toBe('pro_plan');
    expect(sub.status).toBe('trialing');
    expect(sub.trial_plan_id).toBe(sub.plan_id);
    expect(sub.trial_ends_at).toBeTruthy();
    const days = (new Date(sub.trial_ends_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(env.TRIAL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(env.TRIAL_DAYS);
  });

  it('gives the trial Pro\'s features AND Pro\'s limits', async () => {
    const b = await query('SELECT id FROM businesses WHERE email = $1', ['trialtier-default@example.com']);
    const bid = b.rows[0].id;
    const summary = await featureService.planSummary(bid);
    expect(summary.tierKind).toBe('pro_plan');
    const eff = await subService.effectivePlan(bid);
    expect(eff.entitled).toBe(true);
    expect(eff.plan.tier).toBe('pro_plan');
    // Unlimited orders and menu during the trial, which is the product we
    // advertise — and what the old 'free'-pinned trial never showed.
    expect(eff.plan.limits.monthly_orders).toBe(-1);
    expect(eff.plan.limits.menu_items).toBe(-1);
  });

  it('an explicit ?plan= choice still beats the env default', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trialtier-chosen@example.com',
      password: 'correct-horse-battery',
      businessName: 'Chosen Cafe',
      plan: 'advanced',
    });
    expect(r.status).toBe(201);
    expect((await subFor(r.body.business.id)).plan_tier).toBe('advanced');
  });

  it('falls back safely if the operator ever typos the env value', async () => {
    const original = env.TRIAL_PLAN_TIER;
    env.TRIAL_PLAN_TIER = 'pro_plann';
    try {
      const id = await authService.resolveTrialPlanId(null);
      const r = await query('SELECT tier FROM plans WHERE id = $1', [id]);
      // Cheapest PAID public shared plan — Growth. Signup never fails, and a
      // typo can never grant a plan nobody chose.
      expect(r.rows[0].tier).toBe('basic');
    } finally {
      env.TRIAL_PLAN_TIER = original;
    }
  });

  it('a Pro trial that lapses still downgrades to the FREE plan', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trialtier-lapse@example.com',
      password: 'correct-horse-battery',
      businessName: 'Lapsing Pro Cafe',
    });
    const bid = r.body.business.id;
    const trialled = (await subFor(bid)).plan_id;
    expect((await subFor(bid)).plan_tier).toBe('pro_plan');

    await query(
      "UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 hour' WHERE business_id = $1",
      [bid],
    );
    featureService.clearCache(bid);

    // Entitlement stops immediately, before the nightly sweep — so a lapsed
    // Pro trial cannot keep unlimited orders for a day for free.
    const eff = await subService.effectivePlan(bid);
    expect(eff.entitled).toBe(false);
    expect(eff.reason).toBe('trial_expired');
    expect(eff.plan.tier).toBe(planTiers.FALLBACK_PLAN_CODE);
    expect(eff.plan.tier).toBe('free');

    // And the sweep moves the row itself onto the free plan.
    const downgraded = await authService.expireLapsedTrials();
    expect(downgraded.map((d) => d.business_id)).toContain(bid);
    const after = await subFor(bid);
    expect(after.plan_tier).toBe('free');
    expect(after.status).toBe('active');
    expect(after.trial_downgraded_at).toBeTruthy();
    expect(after.trial_plan_id).toBe(trialled); // we still know Pro lapsed
  });

  it('the post-downgrade tenant can STILL bill past the free cap (decision 5)', async () => {
    // The two decisions have to compose: a lapsed Pro trial lands on Starter's
    // 500 included bills, and passing that must not stop the restaurant.
    const b = await query('SELECT id FROM businesses WHERE email = $1', ['trialtier-lapse@example.com']);
    const bid = b.rows[0].id;
    const eff = await subService.effectivePlan(bid);
    expect(eff.plan.limits.monthly_orders).toBe(500);
    expect(subService.isSoftMetric('monthly_orders')).toBe(true);
  });
});
