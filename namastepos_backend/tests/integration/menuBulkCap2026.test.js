// POST /menu/bulk — the plan cap is checked BEFORE any row is written
// (2026-09-04).
//
// THE BUG THIS LOCKS DOWN: the route skipped `sub.enforceLimit` on the false
// premise that menuService.create() was itself limit-checked (it never was —
// the cap lives in the route middleware). So an owner on a 10-item plan
// imported a 45-row menu successfully and only met the wall on item 46: the
// refusal landed AFTER all the work, at the worst possible moment. The same
// route is what the "switch to NamastePOS" migration wizard (/migrate) posts
// its menu step to, so both had the hole and both are fixed by this gate.
//
// The refusal reuses the SAME 403 contract the single-create path uses —
// `error: 'PLAN_LIMIT'` + `details: { metric, limit, current, plan }` — because
// the dashboard's error interceptor and the `plan_limit_hit` analytics hook
// (web api/client.ts, mobile ApiService._maybeTrackPlanLimit) read exactly
// those keys.
//
// Conventions follow the other suites: resetDb / makeBusiness / tokenFor.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

/** A private plan for one tenant + an active subscription onto it. */
async function subscribeToPrivatePlan(businessId, {
  tier, tierKind = 'pro', limits,
}) {
  await query(
    `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                        is_public, business_id, limits)
     VALUES ($1, $2, $3, 29900, TRUE, FALSE, $4, $5::jsonb)`,
    [tier, tierKind, `Plan ${tier}`, businessId, JSON.stringify(limits)],
  );
  const p = await query('SELECT id FROM plans WHERE tier = $1', [tier]);
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
    [businessId, p.rows[0].id],
  );
  featureService.clearCache(businessId);
}

const rows = (n, prefix) => Array.from({ length: n }, (_, i) => ({
  name: `${prefix} ${i + 1}`, price: 50 + i, category: 'Food',
}));

async function activeCount(businessId) {
  const r = await query(
    `SELECT COUNT(*)::int AS c FROM menu_items
      WHERE business_id = $1 AND is_active = TRUE`,
    [businessId],
  );
  return r.rows[0].c;
}

describe('menu bulk import respects the plan cap up front', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'bulk-cap@example.com', name: 'Capped Kitchen' });
    token = tokenFor(business);
    await subscribeToPrivatePlan(business.id, {
      tier: 'custom-bulkcap', tierKind: 'pro', limits: { menu_items: 10 },
    });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const bulk = (items) => request(app)
    .post(`/v1/businesses/${business.id}/menu/bulk`)
    .set(auth())
    .send({ items });

  it('imports a file that fits inside the cap', async () => {
    const r = await bulk(rows(5, 'Fits'));
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(5);
    expect(r.body.errors).toHaveLength(0);
    expect(await activeCount(business.id)).toBe(5);
  });

  it('refuses the WHOLE file when it would breach the cap, and writes zero rows', async () => {
    const before = await activeCount(business.id); // 5 of 10 used
    const r = await bulk(rows(45, 'Overflow'));

    expect(r.status).toBe(403);
    // The four keys every existing reader parses.
    expect(r.body.error).toBe('PLAN_LIMIT');
    expect(r.body.details).toEqual(expect.objectContaining({
      metric: 'menu_items',
      limit: 10,
      current: 5,
      plan: 'custom-bulkcap',
    }));
    expect(typeof r.body.details.limit).toBe('number');
    expect(typeof r.body.details.current).toBe('number');
    // How many they TRIED to add — the number the old wall never reported.
    expect(r.body.details.attempted).toBe(45);
    expect(r.body.details.remaining).toBe(5);
    // Which plan lifts the limit, from the tier ladder — kind 'pro' is Growth,
    // so the next kind up is 'pro_plan', whose owner-facing name is "Pro".
    // Never a guessed plan name.
    expect(r.body.details.requiredTierKind).toBe('pro_plan');
    expect(r.body.details.requiredTierLabel).toBe('Pro');

    // The message states all four numbers an owner needs.
    expect(r.body.message).toMatch(/covers 10 menu items/);
    expect(r.body.message).toMatch(/already have 5/);
    expect(r.body.message).toMatch(/adds 45/);
    expect(r.body.message).toMatch(/Nothing was imported/);
    expect(r.body.message).toMatch(/Upgrade to Pro/);

    // NO PARTIAL IMPORT. This is the whole point: the wall lands before the
    // work, not after it.
    expect(await activeCount(business.id)).toBe(before);
  });

  it('still refuses when the file alone is under the cap but the total is not', async () => {
    // 5 held + 6 incoming = 11 on a 10-item plan.
    const before = await activeCount(business.id);
    const r = await bulk(rows(6, 'Edge'));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('PLAN_LIMIT');
    expect(r.body.details.attempted).toBe(6);
    expect(await activeCount(business.id)).toBe(before);
  });

  it('accepts the file that exactly fills the remaining room', async () => {
    const r = await bulk(rows(5, 'Exact'));
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(5);
    expect(await activeCount(business.id)).toBe(10);
  });

  it('refuses even a single-row file once the cap is full', async () => {
    const r = await bulk(rows(1, 'One'));
    expect(r.status).toBe(403);
    expect(r.body.details.remaining).toBe(0);
    // No trim-the-file advice when there is no room at all.
    expect(r.body.message).toMatch(/deactivate items you no longer sell/);
    expect(await activeCount(business.id)).toBe(10);
  });
});

describe('menu bulk import on an unlimited plan', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'bulk-unlimited@example.com', name: 'Unlimited Kitchen' });
    token = tokenFor(business);
    await subscribeToPrivatePlan(business.id, {
      tier: 'custom-bulkfree', tierKind: 'enterprise', limits: { menu_items: -1 },
    });
  });

  it('imports freely when the cap is -1', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/menu/bulk`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ items: rows(45, 'Free') });
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(45);
    expect(r.body.errors).toHaveLength(0);
    expect(await activeCount(business.id)).toBe(45);
  });
});

describe('what counts towards the bulk cap', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'bulk-counts@example.com', name: 'Counting Kitchen' });
    token = tokenFor(business);
    await subscribeToPrivatePlan(business.id, {
      tier: 'custom-bulkcount', tierKind: 'starter', limits: { menu_items: 3 },
    });
  });

  const bulk = (items) => request(app)
    .post(`/v1/businesses/${business.id}/menu/bulk`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ items });

  it('does not count variant rows or inactive rows against the cap', async () => {
    // 3 active items (the cap exactly) + one variant row that collapses onto
    // a parent + one deliberately inactive row. Only the 3 active parents are
    // new ACTIVE menu items, which is what currentUsage() counts.
    const r = await bulk([
      { name: 'Chai', price: 30 },
      { name: 'Chai', variant_name: 'Large', variant_price: 45 },
      { name: 'Naan', price: 40 },
      { name: 'Paneer Tikka', price: 250 },
      { name: 'Seasonal Thali', price: 300, is_active: 'false' },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(4); // 3 active + the inactive one
    expect(r.body.variants).toBe(1);
    expect(await activeCount(business.id)).toBe(3);
  });

  it('rejects the next import now the active cap is full', async () => {
    const r = await bulk([{ name: 'One More', price: 10 }]);
    expect(r.status).toBe(403);
    expect(r.body.details).toEqual(expect.objectContaining({
      metric: 'menu_items', limit: 3, current: 3,
    }));
    // Starter has somewhere to go: the next kind up is Growth.
    expect(r.body.details.requiredTierLabel).toBe('Growth');
  });
});
