// NP-121 (2026-09-03) — revenue-integrity nightly checks.
//
// Unit-tests the three check functions against seeded rows (they're exported
// from revenueIntegrityService for exactly this), NOT the cron scheduler:
//   1. checkPlanPriceDrift — active gateway sub whose latest paid invoice
//      amount matches a DIFFERENT plan's price (monthly or yearly) while not
//      matching its own plan's prices.
//   2. checkStuckRefunds — refunds pending > 48h.
//   3. checkDeadWebhookEvents — webhook_events > 1h old with NULL
//      response_body (the delivery claimed the dedup row and died).
// Plus: runDaily fails loudly when PLATFORM_ALERT_EMAIL is missing.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const integrity = require('../../src/services/revenueIntegrityService');

beforeAll(async () => {
  await resetDb();
  // Deterministic plan prices for the drift check — make pro's prices UNIQUE
  // across the ladder so matched_tier can only ever be 'pro'.
  await query(`UPDATE plans SET price_inr_paise = price_inr_paise + 7,
                                price_yearly_paise = COALESCE(price_yearly_paise, price_inr_paise * 10) + 7
               WHERE tier <> 'pro' AND (price_inr_paise = 29900
                  OR price_inr_paise = 299000
                  OR COALESCE(price_yearly_paise, price_inr_paise * 10) IN (29900, 299000))`);
  await query(`UPDATE plans SET price_inr_paise = 29900, price_yearly_paise = 299000 WHERE tier = 'pro'`);
});
afterAll(async () => { await closePool(); });

async function makeSub(biz, { tier, rzSubId }) {
  const plan = (await query(`SELECT id FROM plans WHERE tier = $1`, [tier])).rows[0];
  const s = await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, razorpay_subscription_id)
     VALUES ($1, $2, 'active', $3) RETURNING id`,
    [biz.id, plan.id, rzSubId]
  );
  return { subId: s.rows[0].id, planId: plan.id };
}

async function payInvoice(biz, subId, amountPaise, { paidAgoDays = 0 } = {}) {
  await query(
    `INSERT INTO invoices
       (business_id, subscription_id, number, status, amount_paise, currency,
        period_start, period_end, paid_at)
     VALUES ($1, $2, $3, 'paid', $4, 'INR', NOW(), NOW() + INTERVAL '1 month',
             NOW() - make_interval(days => $5::int))`,
    [biz.id, subId, `TST-${subId.slice(0, 8)}-${amountPaise}-${Date.now()}`,
      amountPaise, paidAgoDays]
  );
}

describe('checkPlanPriceDrift', () => {
  it('flags an active sub whose latest paid invoice matches a different plan price', async () => {
    const biz = await makeBusiness({ email: `drift-${Date.now()}` });
    // Sub sits on 'free' but the latest paid invoice equals pro monthly.
    const { subId } = await makeSub(biz, { tier: 'free', rzSubId: 'sub_DRIFT_1' });
    await payInvoice(biz, subId, 29900);

    const drift = await integrity.checkPlanPriceDrift();
    const hit = drift.find((d) => d.business_id === biz.id);
    expect(hit).toBeDefined();
    expect(hit.current_tier).toBe('free');
    expect(hit.matched_tier).toBe('pro');
    expect(Number(hit.last_paid_paise)).toBe(29900);
  });

  it('does NOT flag a sub whose invoice matches its own plan price (monthly or yearly)', async () => {
    const bizM = await makeBusiness({ email: `nodrift-m-${Date.now()}` });
    const m = await makeSub(bizM, { tier: 'pro', rzSubId: 'sub_NODRIFT_M' });
    await payInvoice(bizM, m.subId, 29900); // own monthly price

    const bizY = await makeBusiness({ email: `nodrift-y-${Date.now()}` });
    const y = await makeSub(bizY, { tier: 'pro', rzSubId: 'sub_NODRIFT_Y' });
    await payInvoice(bizY, y.subId, 299000); // own yearly price

    const drift = await integrity.checkPlanPriceDrift();
    expect(drift.find((d) => d.business_id === bizM.id)).toBeUndefined();
    expect(drift.find((d) => d.business_id === bizY.id)).toBeUndefined();
  });

  it('only considers the LATEST paid invoice', async () => {
    const biz = await makeBusiness({ email: `latest-${Date.now()}` });
    const { subId } = await makeSub(biz, { tier: 'pro', rzSubId: 'sub_LATEST' });
    await payInvoice(biz, subId, 9999, { paidAgoDays: 40 }); // stale odd amount
    await payInvoice(biz, subId, 29900, { paidAgoDays: 0 }); // latest = own price

    const drift = await integrity.checkPlanPriceDrift();
    expect(drift.find((d) => d.business_id === biz.id)).toBeUndefined();
  });
});

describe('checkStuckRefunds', () => {
  it('flags pending refunds older than 48h and ignores fresh/settled ones', async () => {
    const biz = await makeBusiness({ email: `stuck-${Date.now()}` });
    const old = await query(
      `INSERT INTO refunds (business_id, amount_paise, status, created_at)
       VALUES ($1, 5000, 'pending', NOW() - INTERVAL '3 days') RETURNING id`,
      [biz.id]
    );
    await query(
      `INSERT INTO refunds (business_id, amount_paise, status, created_at)
       VALUES ($1, 4000, 'pending', NOW() - INTERVAL '1 hour')`,
      [biz.id]
    );
    await query(
      `INSERT INTO refunds (business_id, amount_paise, status, created_at, processed_at)
       VALUES ($1, 3000, 'processed', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')`,
      [biz.id]
    );

    const stuck = await integrity.checkStuckRefunds();
    const ids = stuck.map((r) => r.id);
    expect(ids).toContain(old.rows[0].id);
    expect(stuck.filter((r) => r.business_id === biz.id)).toHaveLength(1);
  });
});

describe('checkDeadWebhookEvents', () => {
  it('flags >1h-old rows with NULL response_body and ignores finished/fresh ones', async () => {
    const dead = `evt_dead_${Date.now()}`;
    const fresh = `evt_fresh_${Date.now()}`;
    const done = `evt_done_${Date.now()}`;
    await query(
      `INSERT INTO webhook_events (provider, external_id, event_type, payload, created_at)
       VALUES ('razorpay', $1, 'subscription.charged', '{}'::jsonb, NOW() - INTERVAL '2 hours')`,
      [dead]
    );
    await query(
      `INSERT INTO webhook_events (provider, external_id, event_type, payload, created_at)
       VALUES ('razorpay', $1, 'subscription.charged', '{}'::jsonb, NOW() - INTERVAL '10 minutes')`,
      [fresh]
    );
    await query(
      `INSERT INTO webhook_events (provider, external_id, event_type, payload, created_at, response_body)
       VALUES ('razorpay', $1, 'subscription.charged', '{}'::jsonb, NOW() - INTERVAL '2 hours',
               '{"received":true}'::jsonb)`,
      [done]
    );

    const rows = await integrity.checkDeadWebhookEvents();
    const ids = rows.map((r) => r.external_id);
    expect(ids).toContain(dead);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(done);
  });
});

describe('runDaily fail-loudly guard', () => {
  it('throws when the cron would run without PLATFORM_ALERT_EMAIL', async () => {
    // tests never set PLATFORM_ALERT_EMAIL, so env caches '' — the job must
    // refuse to run silently rather than sweep and tell no one.
    await expect(integrity.runDaily()).rejects.toThrow(/PLATFORM_ALERT_EMAIL/);
  });
});
