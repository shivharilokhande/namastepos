// Integration tests for the 2026-09-04 conversion/retention batch:
//
//   1. The 7-day trial provisions the plan the SIGNUP CHOSE (not always
//      Starter), and lapsing it is an explicit, recorded downgrade.
//   2. The PLAN_LIMIT 403 carries the metric/limit/current contract the
//      dashboard error path and the `plan_limit_hit` analytics hook read,
//      plus an owner-facing usage meter on the billing route.
//   3. A `past_due` subscription keeps its features for
//      PAST_DUE_GRACE_DAYS and loses them after.
//
// Conventions follow the other suites: resetDb / makeBusiness / tokenFor.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const authService = require('../../src/services/authService');
const featureService = require('../../src/services/featureService');
const subService = require('../../src/services/subscriptionService');
const entitlement = require('../../src/services/planEntitlement');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

// Seed plan ladder in the test DB (migrations 002/031/034):
//   free  → Starter,    tier_kind 'starter', ₹0
//   basic → Pro,        tier_kind 'pro',     ₹299   ← cheapest PAID plan
//   pro   → Enterprise, tier_kind 'enterprise', ₹799
const planIdFor = async (tier) => {
  const r = await query('SELECT id FROM plans WHERE tier = $1', [tier]);
  return r.rows[0].id;
};
const subFor = async (businessId) => {
  const r = await query(
    `SELECT s.*, p.tier AS plan_tier
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1`,
    [businessId],
  );
  return r.rows[0] || null;
};

// ── 1. Trial provisions the chosen plan ──────────────────────────────────

describe('trial provisions the plan the signup chose', () => {
  it('registers onto the requested paid plan, not Starter', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trial-chosen@example.com',
      password: 'correct-horse-battery',
      name: 'Chosen Plan Owner',
      businessName: 'Chosen Cafe',
      // 'pro' is Enterprise (₹799) in the seed ladder — deliberately NOT the
      // cheapest paid plan, so this cannot pass by accidentally hitting the
      // default.
      plan: 'pro',
    });
    expect(r.status).toBe(201);
    const bid = r.body.business.id;

    const sub = await subFor(bid);
    expect(sub).toBeTruthy();
    // THE BUG THIS LOCKS DOWN: this used to be 'free' for every signup,
    // whichever plan card they clicked.
    expect(sub.plan_tier).toBe('pro');
    expect(sub.status).toBe('trialing');
    // Recorded so the expiry downgrade can name what lapsed.
    expect(sub.trial_plan_id).toBe(sub.plan_id);
    // Time-boxed — this is what keeps a trial from being a free activation.
    expect(sub.trial_ends_at).toBeTruthy();
    const days = (new Date(sub.trial_ends_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it('grants the chosen plan\'s features during the trial', async () => {
    const r = await query(
      'SELECT id FROM businesses WHERE email = $1',
      ['trial-chosen@example.com'],
    );
    const bid = r.rows[0].id;
    const summary = await featureService.planSummary(bid);
    // 'pro' → tier_kind 'enterprise' in the seed ladder. The point is that it
    // is NOT the starter feature set the prospect used to be given.
    expect(summary.tierKind).toBe('enterprise');
    expect(summary.features).toContain('wastage');
  });

  it('defaults to the cheapest paid plan when the signup names none', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trial-default@example.com',
      password: 'correct-horse-battery',
      businessName: 'Default Cafe',
    });
    expect(r.status).toBe(201);
    const sub = await subFor(r.body.business.id);
    // basic = ₹299, the cheapest paid public shared plan.
    expect(sub.plan_tier).toBe('basic');
    expect(sub.status).toBe('trialing');
  });

  it('ignores an unknown tier instead of failing signup', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trial-bogus@example.com',
      password: 'correct-horse-battery',
      businessName: 'Bogus Plan Cafe',
      plan: 'no-such-plan',
    });
    expect(r.status).toBe(201);
    const sub = await subFor(r.body.business.id);
    expect(sub.plan_tier).toBe('basic');
  });

  it('refuses to attach another tenant\'s private custom plan', async () => {
    const other = await makeBusiness({ email: 'custom-owner@example.com' });
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, business_id, limits)
       VALUES ('custom-secret', 'enterprise', 'Bespoke', 100, TRUE, FALSE, $1,
               '{"menu_items": -1}'::jsonb)`,
      [other.id],
    );
    const r = await request(app).post('/v1/auth/register').send({
      email: 'plan-thief@example.com',
      password: 'correct-horse-battery',
      businessName: 'Thief Cafe',
      plan: 'custom-secret',
    });
    expect(r.status).toBe(201);
    const sub = await subFor(r.body.business.id);
    expect(sub.plan_tier).not.toBe('custom-secret');
    expect(sub.plan_tier).toBe('basic');
  });
});

// ── 1b. Explicit, recorded downgrade at expiry ───────────────────────────

describe('trial expiry is an explicit recorded downgrade', () => {
  let bid;
  let trialledPlanId;

  beforeAll(async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trial-lapse@example.com',
      password: 'correct-horse-battery',
      businessName: 'Lapsing Cafe',
      plan: 'pro',
    });
    bid = r.body.business.id;
    trialledPlanId = (await subFor(bid)).plan_id;
    // Age the trial past its end.
    await query(
      `UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 hour'
        WHERE business_id = $1`,
      [bid],
    );
    featureService.clearCache(bid);
  });

  it('stops granting the trialled plan the moment the trial lapses', async () => {
    // Entitlement is enforced in the resolution, not by the cron — so the
    // features are gone even before the nightly sweep runs.
    const summary = await featureService.planSummary(bid);
    expect(summary.tierKind).toBe('starter');
    expect(summary.features).not.toContain('wastage');
  });

  it('also stops granting the trialled plan\'s LIMITS', async () => {
    // Regression guard for the hole the trial fix would otherwise open: the
    // subscription row still points at the paid plan until the sweep runs, so
    // a limit gate that read the row directly would hand out unlimited orders
    // for free. effectivePlan() resolves through the same predicate.
    const eff = await subService.effectivePlan(bid);
    expect(eff.entitled).toBe(false);
    expect(eff.reason).toBe('trial_expired');
    expect(eff.plan.tier).toBe('free');
  });

  it('records the downgrade on the subscription row', async () => {
    const downgraded = await authService.expireLapsedTrials();
    expect(downgraded.map((d) => d.business_id)).toContain(bid);

    const sub = await subFor(bid);
    expect(sub.plan_tier).toBe('free');
    expect(sub.status).toBe('active');
    // Recorded, not silent.
    expect(sub.trial_downgraded_at).toBeTruthy();
    // And we still know what they had, so we can re-offer exactly that plan.
    expect(sub.trial_plan_id).toBe(trialledPlanId);
  });

  it('is idempotent — a second sweep does not touch it again', async () => {
    const before = (await subFor(bid)).trial_downgraded_at;
    const again = await authService.expireLapsedTrials();
    expect(again.map((d) => d.business_id)).not.toContain(bid);
    expect((await subFor(bid)).trial_downgraded_at).toEqual(before);
  });

  it('leaves a trial that has NOT expired alone', async () => {
    const r = await request(app).post('/v1/auth/register').send({
      email: 'trial-live@example.com',
      password: 'correct-horse-battery',
      businessName: 'Live Trial Cafe',
      plan: 'pro',
    });
    const liveBid = r.body.business.id;
    await authService.expireLapsedTrials();
    const sub = await subFor(liveBid);
    expect(sub.plan_tier).toBe('pro');
    expect(sub.status).toBe('trialing');
    expect(sub.trial_downgraded_at).toBeNull();
  });
});

// ── 2. The 403 contract + the owner-facing usage meter ───────────────────

describe('PLAN_LIMIT 403 carries the metric/limit/current contract', () => {
  let business;
  let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'cap-403@example.com', name: 'Capped Cafe' });
    token = tokenFor(business);
    // A private plan for this tenant with a 1-item menu cap, so we can trip
    // the wall in one call without mutating the shared ladder.
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, business_id, limits)
       VALUES ('custom-cap403', 'pro', 'Capped', 100, TRUE, FALSE, $1,
               '{"menu_items": 1, "monthly_orders": 5}'::jsonb)`,
      [business.id],
    );
    const planId = await planIdFor('custom-cap403');
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
      [business.id, planId],
    );
    featureService.clearCache(business.id);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const menuUrl = () => `/v1/businesses/${business.id}/menu`;

  it('lets the first item through', async () => {
    const r = await request(app).post(menuUrl()).set(auth())
      .send({ name: 'Masala Chai', price: 30 });
    expect(r.status).toBe(201);
  });

  it('403s the second with error=PLAN_LIMIT and the full details block', async () => {
    const r = await request(app).post(menuUrl()).set(auth())
      .send({ name: 'Butter Naan', price: 40 });
    expect(r.status).toBe(403);
    // The exact two keys the dashboard's error interceptor and its
    // `plan_limit_hit` GA4 hook read. Renaming either breaks both.
    expect(r.body.error).toBe('PLAN_LIMIT');
    expect(r.body.details).toEqual(expect.objectContaining({
      metric: 'menu_items',
      limit: 1,
      current: 1,
      plan: 'custom-cap403',
    }));
    // `current` must be a number, not a string — client does current + 1.
    expect(typeof r.body.details.current).toBe('number');
    expect(typeof r.body.details.limit).toBe('number');
    // And a message an owner can act on, not a column name and a fraction.
    expect(typeof r.body.message).toBe('string');
    expect(r.body.message.length).toBeGreaterThan(20);
    expect(r.body.message).toMatch(/dish/i);
    expect(r.body.message).not.toMatch(/menu_items/);
    // Additive fields — new readers only.
    expect(r.body.details.remaining).toBe(0);
    expect(r.body.details.metricLabel).toBe('menu items');
  });

  it('reports remaining/limit per metric on the billing route the dashboard already calls', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/billing`).set(auth());
    expect(r.status).toBe(200);
    const usage = r.body.subscription.usage;
    expect(usage).toBeTruthy();
    expect(usage.warnAtPct).toBe(80);
    const byMetric = Object.fromEntries(usage.metrics.map((m) => [m.metric, m]));

    // At the wall: critical, so the dashboard shows the non-dismissable banner.
    expect(byMetric.menu_items).toEqual(expect.objectContaining({
      metric: 'menu_items',
      limit: 1,
      current: 1,
      remaining: 0,
      pct: 100,
      level: 'critical',
    }));
    // Under the wall: reported with headroom so the warning can precede it.
    expect(byMetric.monthly_orders).toEqual(expect.objectContaining({
      metric: 'monthly_orders',
      limit: 5,
      current: 0,
      remaining: 5,
      level: 'ok',
    }));
  });

  it('flags warn at 80% of a cap, BEFORE the 403', async () => {
    const period = new Date().toISOString().slice(0, 7);
    await query(
      `INSERT INTO usage_counters (business_id, metric, period, count)
       VALUES ($1, 'monthly_orders', $2, 4)
       ON CONFLICT (business_id, metric, period)
         DO UPDATE SET count = 4`,
      [business.id, period],
    );
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/billing`).set(auth());
    const orders = r.body.subscription.usage.metrics
      .find((m) => m.metric === 'monthly_orders');
    // 4/5 = 80% — warned while the till still works. This is the whole point:
    // it must be impossible to hit the wall without having been told.
    expect(orders.pct).toBe(80);
    expect(orders.level).toBe('warn');
    expect(orders.remaining).toBe(1);
    expect(orders.message).toMatch(/1 of your 5/);
  });

  it('does not report unlimited (-1) metrics as a limit', async () => {
    const unlimited = await makeBusiness({ email: 'cap-unlimited@example.com' });
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
      [unlimited.id, await planIdFor('pro')],
    );
    const usage = await subService.usageSummary(unlimited.id);
    // Seed 'pro' has menu_items/monthly_orders/staff = -1.
    expect(usage.metrics.map((m) => m.metric)).not.toContain('menu_items');
    expect(usage.metrics.map((m) => m.metric)).not.toContain('monthly_orders');
  });
});

// ── 3. past_due grace window ─────────────────────────────────────────────

describe('past_due keeps features inside the grace window', () => {
  let business;
  let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'grace@example.com', name: 'Grace Cafe' });
    token = tokenFor(business);
    // Paid plan whose feature set (tier_kind 'pro') includes `wastage`, and a
    // roomy menu cap so the lapse is visible as a cap change too.
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, business_id, limits)
       VALUES ('custom-grace', 'pro', 'Grace Plan', 29900, TRUE, FALSE, $1,
               '{"menu_items": 500, "monthly_orders": 5000}'::jsonb)`,
      [business.id],
    );
    // 2026-09-05 (review E1): a plan with NO plan_features rows no longer
    // inherits rows by tier_kind when that kind string is also a live plan
    // CODE ('pro' is Enterprise's code) — that fallback was how an empty plan
    // silently became Enterprise. Give the plan its own rows, as every real
    // plan has since migration 040.
    await query(
      `INSERT INTO plan_features (tier_kind, feature_key)
       SELECT 'custom-grace', feature_key FROM plan_features WHERE tier_kind = 'pro'
       ON CONFLICT DO NOTHING`,
    );
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
      [business.id, await planIdFor('custom-grace')],
    );
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const setPastDue = async (daysAgo) => {
    await query(
      `UPDATE subscriptions
          SET status = 'past_due',
              past_due_at = NOW() - make_interval(days => $2),
              last_dunning_at = NOW()
        WHERE business_id = $1`,
      [business.id, daysAgo],
    );
    // The real path (dunningService) invalidates this for us; the test writes
    // straight to the row, so it invalidates explicitly.
    featureService.clearCache(business.id);
  };

  it('grants features while active', async () => {
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(true);
  });

  it('KEEPS features 2 days into a 7-day grace window', async () => {
    await setPastDue(2);
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(true);
    const summary = await featureService.planSummary(business.id);
    expect(summary.tierKind).toBe('pro');
    // A gated route still answers — the restaurant is still working.
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/wastage`).set(auth());
    expect(r.status).not.toBe(402);
  });

  it('keeps the paid plan\'s LIMITS inside grace too', async () => {
    const eff = await subService.effectivePlan(business.id);
    expect(eff.entitled).toBe(true);
    expect(eff.reason).toBe('grace');
    expect(eff.plan.tier).toBe('custom-grace');
    expect(eff.plan.limits.menu_items).toBe(500);
  });

  it('tells the owner the amount and the exact date access ends', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/billing`).set(auth());
    expect(r.status).toBe(200);
    const grace = r.body.subscription.grace;
    expect(grace).toBeTruthy();
    expect(grace.inGrace).toBe(true);
    expect(grace.graceDays).toBe(7);
    expect(grace.graceDaysLeft).toBe(5);
    expect(grace.amountInr).toBe(299);
    expect(new Date(grace.graceEndsAt).getTime()).toBeGreaterThan(Date.now());
    expect(grace.message).toMatch(/2,?99/);
  });

  it('LOSES features once the grace window has passed', async () => {
    await setPastDue(8);
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(false);
    const summary = await featureService.planSummary(business.id);
    expect(summary.tierKind).toBe('starter');
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/wastage`).set(auth());
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('FEATURE_LOCKED');
  });

  it('falls back to the free plan\'s limits past grace', async () => {
    const eff = await subService.effectivePlan(business.id);
    expect(eff.entitled).toBe(false);
    expect(eff.reason).toBe('grace_expired');
    expect(eff.plan.tier).toBe('free');
  });

  it('drops the grace notice past grace', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/billing`).set(auth());
    expect(r.body.subscription.grace).toBeNull();
  });

  it('cannot serve a stale "still in grace" answer once grace ends', async () => {
    // The in-process Map has a 60s soft TTL and the Redis pub/sub channel only
    // fires on an EXPLICIT change — neither of them notices a deadline passing.
    // So a cached entry's lifetime is capped at the deadline itself, which
    // every node derives from the same row without talking to any other node.
    //
    // Grace ends ~2 seconds from now. We warm the cache while still inside it,
    // then re-ask AFTER it lapses with no invalidation of any kind. A 60s TTL
    // would answer "yes" here; the capped entry re-resolves and answers "no".
    await query(
      `UPDATE subscriptions
          SET status = 'past_due',
              past_due_at = NOW() - INTERVAL '7 days' + INTERVAL '2 seconds',
              last_dunning_at = NOW()
        WHERE business_id = $1`,
      [business.id],
    );
    featureService.clearCache(business.id);

    const resolved = await featureService.resolveTierKind(business.id);
    expect(resolved.reason).toBe('grace');
    // The deadline, not now + TTL.
    expect(resolved.expiresAtMs).toBeGreaterThan(Date.now());
    expect(resolved.expiresAtMs).toBeLessThan(Date.now() + 10_000);

    // Warm the cache inside the window.
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(true);

    await new Promise((r) => setTimeout(r, 2600));

    // No clearCache, no Redis message — and the answer is already correct.
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(false);
  });

  it('anchors grace to the FIRST failure, so retries cannot extend it', async () => {
    // last_dunning_at moves on every retry; past_due_at must not.
    const row = {
      status: 'past_due',
      past_due_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      last_dunning_at: new Date().toISOString(),
    };
    expect(entitlement.classify(row).entitled).toBe(false);
  });

  it('recovers to entitled when the charge finally succeeds', async () => {
    await query(
      `UPDATE subscriptions
          SET status = 'active', past_due_at = NULL, last_dunning_at = NULL,
              dunning_attempts = 0
        WHERE business_id = $1`,
      [business.id],
    );
    featureService.clearCache(business.id);
    expect(await featureService.hasFeature(business.id, 'wastage')).toBe(true);
  });
});
