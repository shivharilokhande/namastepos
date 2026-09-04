// Integration tests for the 2026-09-04 commercial batch.
//
//   DECISION 3 — stop gating on menu size. Migration 089 raises Starter and
//     Growth (menu items, monthly orders, tables, staff), leaves the three
//     unlimited plans alone, never lowers anything, and is re-runnable.
//
//   DECISION 5 — a POS must never refuse a bill. `monthly_orders` is a SOFT
//     limit: the order is always accepted, the overage is recorded, and the
//     success body carries a `planLimit` notice with enforcement:'soft' so
//     the pricing cliff still reports itself to analytics. Every other capped
//     metric stays HARD and still 403s with the documented PLAN_LIMIT shape.
//
// Conventions follow the other suites: resetDb / makeBusiness / tokenFor.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');
const subService = require('../../src/services/subscriptionService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

const PERIOD = () => new Date().toISOString().slice(0, 7);

/** Attach a private plan with exactly the caps a test needs. */
async function onPlan(business, tierCode, limits) {
  await query(
    `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                        is_public, business_id, limits)
     VALUES ($1, 'pro', $2, 100, TRUE, FALSE, $3, $4::jsonb)`,
    [tierCode, `Plan ${tierCode}`, business.id, JSON.stringify(limits)],
  );
  const p = await query('SELECT id FROM plans WHERE tier = $1', [tierCode]);
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
    [business.id, p.rows[0].id],
  );
  featureService.clearCache(business.id);
}

// ── 1. The classification itself ─────────────────────────────────────────
//
// The point of these is that soft-vs-hard is DATA in ONE table, not an
// `if (metric === 'monthly_orders')` scattered through the request paths. A
// future metric must be classifiable by editing one row.

describe('soft vs hard enforcement is data in one place', () => {
  it('classifies monthly_orders soft and every other capped metric hard', () => {
    expect(subService.isSoftMetric('monthly_orders')).toBe(true);
    for (const m of ['menu_items', 'staff', 'tables', 'floors', 'businesses']) {
      expect(subService.enforcementOf(m)).toBe('hard');
      expect(subService.isSoftMetric(m)).toBe(false);
    }
  });

  it('fails CLOSED — a metric nobody has classified yet is hard', () => {
    expect(subService.DEFAULT_ENFORCEMENT).toBe('hard');
    expect(subService.enforcementOf('shelves_per_outlet')).toBe('hard');
    expect(subService.isSoftMetric(undefined)).toBe(false);
  });

  it('is one table: every row declares its class and the lookup agrees', () => {
    const policy = subService.METRIC_POLICY;
    expect(Object.keys(policy).length).toBeGreaterThan(0);
    for (const [metric, row] of Object.entries(policy)) {
      expect(['soft', 'hard']).toContain(row.enforcement);
      expect(subService.enforcementOf(metric)).toBe(row.enforcement);
    }
    // Exactly one soft metric today — the only one with a queue in front of it.
    expect(Object.keys(policy).filter((m) => policy[m].enforcement === 'soft'))
      .toEqual(['monthly_orders']);
  });

  it('reports enforcement per metric on the owner-facing usage meter', async () => {
    const biz = await makeBusiness({ email: 'soft-meter@example.com' });
    await onPlan(biz, 'custom-softmeter', { monthly_orders: 4, menu_items: 4 });
    const usage = await subService.usageSummary(biz.id);
    const byMetric = Object.fromEntries(usage.metrics.map((m) => [m.metric, m]));
    expect(byMetric.monthly_orders.enforcement).toBe('soft');
    expect(byMetric.menu_items.enforcement).toBe('hard');
  });
});

// ── 2. A bill is never refused ───────────────────────────────────────────

describe('monthly_orders is a SOFT limit — the bill always goes through', () => {
  let business;
  let token;
  let itemId;
  const orders = [];

  beforeAll(async () => {
    business = await makeBusiness({ email: 'soft-orders@example.com', name: 'Busy Dhaba' });
    token = tokenFor(business);
    // Two bills included, menu uncapped — so the only wall in play is the one
    // under test.
    await onPlan(business, 'custom-softorders', { monthly_orders: 2, menu_items: -1 });
    const m = await request(app)
      .post(`/v1/businesses/${business.id}/menu`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Masala Chai', price: 20, stock: 1000 });
    itemId = m.body.item.id;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const bill = () => request(app)
    .post(`/v1/businesses/${business.id}/orders`)
    .set(auth())
    .send({ items: [{ menuItemId: itemId, name: 'Masala Chai', price: 20, qty: 1 }] });

  it('takes the two bills the plan includes with no notice attached', async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await bill();
      expect(r.status).toBe(201);
      // Inside the plan: nothing to say, so nothing is said.
      expect(r.body.planLimit).toBeUndefined();
      orders.push(r.body.order);
    }
  });

  it('ACCEPTS the bill that passes the cap, and says so in the body', async () => {
    const r = await bill();
    // THE REGRESSION THIS LOCKS DOWN: this used to be a 403. A restaurant
    // that cannot bill during dinner service uninstalls that evening.
    expect(r.status).toBe(201);
    expect(r.body.order.id).toBeTruthy();
    expect(r.body.order.orderNo).toBe(3);

    const n = r.body.planLimit;
    expect(n).toBeTruthy();
    // THE DISTINGUISHING PROPERTY. Without it `plan_limit_hit` cannot tell a
    // refusal from an over-served success, and the pricing cliff stops being
    // measurable the moment we stop blocking.
    expect(n.enforcement).toBe('soft');
    expect(n.code).toBe('PLAN_LIMIT');
    // Same field names as the 403's `details`, so one client parser does both.
    expect(n.metric).toBe('monthly_orders');
    expect(n.limit).toBe(2);
    expect(n.current).toBe(2);
    expect(n.plan).toBe('custom-softorders');
    expect(n.upgradePath).toBe('/billing');
    // This is the bill that crossed the line.
    expect(n.firstBreach).toBe(true);
    expect(n.over).toBe(1);
    orders.push(r.body.order);
  });

  it('marks only the crossing bill as firstBreach, so analytics fires once', async () => {
    const r = await bill();
    expect(r.status).toBe(201);
    expect(r.body.planLimit.enforcement).toBe('soft');
    expect(r.body.planLimit.firstBreach).toBe(false);
    expect(r.body.planLimit.over).toBe(2);
    orders.push(r.body.order);
  });

  it('reads like a NOTICE, not an error — nothing has stopped', async () => {
    const r = await bill();
    const msg = r.body.planLimit.message;
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(30);
    expect(msg).toMatch(/nothing has stopped/i);
    // The old copy said "Billing is paused until you upgrade". It must never
    // come back: it would be a lie now, and it is the sentence that makes a
    // cashier put the phone down mid-service.
    expect(msg).not.toMatch(/paused|blocked|cannot|can't|refus/i);
    expect(msg).not.toMatch(/monthly_orders/);
    orders.push(r.body.order);
  });

  it('records the overage on the counter — count AND overage in one row', async () => {
    const r = await query(
      `SELECT count, soft_limit, overage_count, first_overage_at, last_overage_at
         FROM usage_counters
        WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
      [business.id, PERIOD()],
    );
    const row = r.rows[0];
    expect(row).toBeTruthy();
    // Six bills taken on a two-bill plan.
    expect(row.count).toBe(orders.length);
    expect(row.soft_limit).toBe(2);
    expect(row.overage_count).toBe(orders.length - 2);
    expect(row.first_overage_at).toBeTruthy();
    expect(row.last_overage_at).toBeTruthy();
    // The counter matches reality, so the nightly reconciler has nothing to
    // repair — the CAS that used to refuse the increment is gone for soft.
    const actual = await query(
      'SELECT COUNT(*)::int AS c FROM orders WHERE business_id = $1',
      [business.id],
    );
    expect(row.count).toBe(actual.rows[0].c);
  });

  it('exposes the overage on the billing route the dashboard already calls', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/billing`).set(auth());
    expect(r.status).toBe(200);
    const over = r.body.subscription.overage;
    expect(over).toEqual(expect.objectContaining({
      metric: 'monthly_orders',
      included: 2,
      used: orders.length,
      over: orders.length - 2,
    }));
    // And the usage meter says "critical" but flags it as soft, so the banner
    // can be an amber notice instead of a red outage.
    const meter = r.body.subscription.usage.metrics
      .find((m) => m.metric === 'monthly_orders');
    expect(meter.level).toBe('critical');
    expect(meter.enforcement).toBe('soft');
    expect(meter.over).toBe(orders.length - 2);
    expect(meter.message).not.toMatch(/paused|blocked/i);
  });

  it('drops the deduped upsell task so the breach is a sales signal', async () => {
    const r = await query(
      `SELECT title FROM admin_tasks
        WHERE business_id = $1 AND title LIKE '%[upsell:monthly_orders]%'`,
      [business.id],
    );
    expect(r.rowCount).toBe(1); // deduped: many bills, one task
  });

  it('still bills when the tenant is enormously over the included volume', async () => {
    await query(
      `UPDATE usage_counters SET count = 5000
        WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
      [business.id, PERIOD()],
    );
    const r = await bill();
    expect(r.status).toBe(201);
    expect(r.body.planLimit.enforcement).toBe('soft');
  });
});

// ── 3. Every other cap still refuses ─────────────────────────────────────

describe('menu_items stays a HARD limit with the documented PLAN_LIMIT shape', () => {
  let business;
  let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'hard-menu@example.com', name: 'Capped Cafe' });
    token = tokenFor(business);
    await onPlan(business, 'custom-hardmenu', { menu_items: 1, monthly_orders: -1 });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const menuUrl = () => `/v1/businesses/${business.id}/menu`;

  it('lets the first dish through', async () => {
    const r = await request(app).post(menuUrl()).set(auth())
      .send({ name: 'Masala Chai', price: 20 });
    expect(r.status).toBe(201);
  });

  it('403s the second — a dish is configuration, not a bill in progress', async () => {
    const r = await request(app).post(menuUrl()).set(auth())
      .send({ name: 'Butter Naan', price: 40 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('PLAN_LIMIT');
    // The four keys every existing client parses. Renaming any breaks both
    // the dashboard error path and its plan_limit_hit hook.
    expect(r.body.details).toEqual(expect.objectContaining({
      metric: 'menu_items',
      limit: 1,
      current: 1,
      plan: 'custom-hardmenu',
    }));
    // ...plus the distinguishing property on this side too.
    expect(r.body.details.enforcement).toBe('hard');
    expect(r.body.details.remaining).toBe(0);
    expect(r.body.details.metricLabel).toBe('menu items');
    expect(r.body.message).toMatch(/dish/i);
    expect(r.body.message).not.toMatch(/menu_items/);
  });

  it('refuses a BULK import past the cap with the same hard contract', async () => {
    const r = await request(app).post(`${menuUrl()}/bulk`).set(auth())
      .send({ items: [{ name: 'Idli', price: 30 }, { name: 'Vada', price: 25 }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('PLAN_LIMIT');
    expect(r.body.details.metric).toBe('menu_items');
    expect(r.body.details.enforcement).toBe('hard');
  });

  it('does not attach a soft notice to a hard-capped tenant\'s 2xx responses', async () => {
    const r = await request(app).get(menuUrl()).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.planLimit).toBeUndefined();
  });
});

// ── 4. Migration 089 ─────────────────────────────────────────────────────

describe('migration 089 raises the entry plans and is re-runnable', () => {
  const MIGRATION = path.join(__dirname, '..', '..', 'db', 'migrations', '089_soft_order_limit_and_menu_cap_lift.sql');
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  const limitsByTier = async () => {
    const r = await query('SELECT tier, limits FROM plans ORDER BY tier');
    return Object.fromEntries(r.rows.map((x) => [x.tier, x.limits]));
  };

  it('is additive only — no destructive DDL anywhere in the file', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Prices and feature keys are explicitly out of scope for this decision.
    expect(sql).not.toMatch(/price_inr_paise|price_yearly_paise|plan_features/i);
  });

  it('has raised Starter and Growth (resetDb applies every migration)', async () => {
    const l = await limitsByTier();
    // Starter: menu 10 -> 60, orders 200 -> 500, tables 2 -> 8.
    expect(l.free.menu_items).toBe(60);
    expect(l.free.monthly_orders).toBe(500);
    expect(l.free.tables).toBe(8);
    // Growth: menu 25 -> unlimited, orders 2000 -> 3000, staff 3 -> 5,
    // tables 6 -> at least 12 (this database seeded 30, which is higher and
    // must therefore be left alone).
    expect(l.basic.menu_items).toBe(-1);
    expect(l.basic.monthly_orders).toBe(3000);
    expect(l.basic.staff).toBe(5);
    expect(l.basic.tables).toBeGreaterThanOrEqual(12);
  });

  it('is re-runnable — applying it twice more changes nothing at all', async () => {
    const before = await limitsByTier();
    await query(sql);
    await query(sql);
    expect(await limitsByTier()).toEqual(before);
  });

  it('touches ONLY the two entry plans, on the full live ladder', async () => {
    // Mirror the live five-plan ladder, including the code/kind trap: tier
    // 'pro' is ENTERPRISE and the plan named Pro is 'pro_plan'. If 089 ever
    // wrote by kind, or mistook 'pro' for Pro, this test fails.
    const live = [
      ['pro_plan', 'pro_plan', 'Pro', { staff: 10, floors: 2, tables: -1, businesses: 1, menu_items: -1, monthly_orders: -1 }],
      ['advanced', 'advanced', 'Advanced', { staff: -1, floors: -1, tables: -1, businesses: 3, menu_items: -1, monthly_orders: -1 }],
    ];
    for (const [tier, kind, name, limits] of live) {
      await query(
        `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active, limits)
         VALUES ($1, $2, $3, 99900, TRUE, $4::jsonb)
         ON CONFLICT (tier) DO UPDATE SET limits = EXCLUDED.limits`,
        [tier, kind, name, JSON.stringify(limits)],
      );
    }
    // 'pro' (Enterprise) already exists from migration 002/031 — pin its
    // limits to the live ones so a stray write to it would be visible.
    await query(
      "UPDATE plans SET limits = $1::jsonb WHERE tier = 'pro'",
      [JSON.stringify({
        staff: -1, floors: -1, tables: -1, businesses: 3, menu_items: -1, monthly_orders: -1,
      })],
    );
    // A bespoke per-customer plan with an EMPTY limits object: absent keys mean
    // uncapped, which is more permissive than any number 089 could write, so
    // 089 must leave it empty rather than "raise" it to 60.
    const owner = await makeBusiness({ email: 'mig089-custom@example.com' });
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                          is_public, business_id, limits)
       VALUES ('custom-mig089', 'advanced', 'Bespoke', 150000, TRUE, FALSE, $1, '{}'::jsonb)`,
      [owner.id],
    );

    const before = await limitsByTier();
    await query(sql);
    const after = await limitsByTier();

    // Nothing outside the two entry plans moved.
    const changed = Object.keys(after)
      .filter((t) => JSON.stringify(after[t]) !== JSON.stringify(before[t]));
    expect(changed).toEqual([]); // already at the floor from the first apply
    for (const t of ['pro_plan', 'advanced', 'pro', 'custom-mig089']) {
      expect(after[t]).toEqual(before[t]);
    }
    expect(after['custom-mig089']).toEqual({});
  });

  it('RAISES a below-floor limit and never LOWERS an above-floor one', async () => {
    // Push Starter back below the new floor on one key and above it on
    // another, then re-apply: one goes up, the other is untouched.
    await query(
      `UPDATE plans
          SET limits = limits || '{"menu_items": 10, "monthly_orders": 9000, "tables": 2}'::jsonb
        WHERE tier = 'free'`,
    );
    await query(sql);
    const l = await limitsByTier();
    expect(l.free.menu_items).toBe(60); // raised
    expect(l.free.tables).toBe(8); // raised
    expect(l.free.monthly_orders).toBe(9000); // an admin's higher value survives
  });

  it('leaves -1 (unlimited) as -1 rather than "raising" it to a number', async () => {
    await query(
      'UPDATE plans SET limits = limits || \'{"tables": -1}\'::jsonb WHERE tier = \'free\'',
    );
    await query(sql);
    const l = await limitsByTier();
    expect(l.free.tables).toBe(-1);
  });

  it('added the overage columns to usage_counters', async () => {
    const r = await query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'usage_counters'
          AND column_name IN ('soft_limit', 'overage_count',
                              'first_overage_at', 'last_overage_at')
        ORDER BY column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      'first_overage_at', 'last_overage_at', 'overage_count', 'soft_limit',
    ]);
    const oc = r.rows.find((x) => x.column_name === 'overage_count');
    expect(oc.is_nullable).toBe('NO');
    expect(oc.column_default).toMatch(/0/);
  });
});
