// Regression tests for the 2026-09-05 billing-lifecycle fixes (review items
// A1, A3, A4, A6, A8, A10, F4). Every one of these was a way to hold a PAID
// plan without paying, or to undo an admin decision from the tenant side:
//
//   A1  POST /billing/resume flipped ANY status to 'active' (trialing, past_due,
//       cancelled …) → permanent free paid plan. Now it is only an undo-cancel,
//       and a paid plan behind a gateway comes back through checkout.
//   A3  Downgrade to the free plan flipped plan_id but left the Razorpay
//       mandate live; the next `subscription.charged` re-activated the paid
//       plan. Now the downgrade is SCHEDULED for period end and the charged
//       webhook cannot undo it.
//   A4  Pause cancelled the mandate; resume set 'active' with no mandate. Now a
//       paid resume returns checkout and flips only on the first charge; a
//       `subscription.cancelled` for the paused mandate leaves the row paused.
//   A6  Admin suspend wrote 'paused' (tenant could self-resume) and restore
//       wrote 'active' unconditionally. Now a distinct 'suspended' status,
//       refused everywhere, restored to the prior status.
//   A8  Gateway status webhooks now bust the feature cache.
//   A10 A ₹0 plan is 'active', never a perpetual 'trialing'.
//   F4  extendTrial only on a trialing row.
//
// Conventions follow churnPrevention2026.test.js: resetDb / makeBusiness /
// tokenFor, and the gateway is toggled by setting env.RAZORPAY_KEY_ID /
// RAZORPAY_KEY_SECRET (checkoutMode() → 'gateway') with createSubscription /
// cancelSubscription stubbed at the module boundary.

const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const rz = require('../../src/services/razorpayService');
const subs = require('../../src/services/subscriptionService');
const churn = require('../../src/services/churnService');
const adminService = require('../../src/services/adminService');
const customerAdmin = require('../../src/services/customerAdminService');
const featureService = require('../../src/services/featureService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  // Webhook payloads name Razorpay plan ids; give the seed plans some.
  await query("UPDATE plans SET razorpay_plan_id = 'plan_LC_BASIC' WHERE tier = 'basic'");
  await query("UPDATE plans SET razorpay_plan_id = 'plan_LC_PRO' WHERE tier = 'pro'");
});
afterAll(async () => { await closePool(); });
afterEach(() => { jest.restoreAllMocks(); });

const planIdFor = async (tier) => (await query('SELECT id FROM plans WHERE tier = $1', [tier])).rows[0].id;
const subFor = async (businessId) => {
  const r = await query(
    `SELECT s.*, p.tier AS plan_tier FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1`,
    [businessId],
  );
  return r.rows[0] || null;
};
const auth = (biz) => ({ Authorization: `Bearer ${tokenFor(biz)}` });

/** A business with a subscription row in exactly the state under test. */
async function bizWith({
  name, email, tier = 'basic', status = 'active', razorpayId = null,
  cancelAtPeriodEnd = false, trialEndsAt = null, periodEnd = "NOW() + INTERVAL '20 days'",
} = {}) {
  const b = await makeBusiness({ name, email });
  const planId = await planIdFor(tier);
  await query(
    `INSERT INTO subscriptions
       (business_id, plan_id, status, billing_period, razorpay_subscription_id,
        cancel_at_period_end, trial_ends_at,
        current_period_start, current_period_end)
     VALUES ($1, $2, $3::subscription_status, 'monthly', $4, $5, $6,
             NOW() - INTERVAL '10 days', ${periodEnd})
     ON CONFLICT (business_id) DO UPDATE
       SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
           razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           trial_ends_at = EXCLUDED.trial_ends_at,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end`,
    [b.id, planId, status, razorpayId, cancelAtPeriodEnd, trialEndsAt],
  );
  return b;
}

function chargedPayload({ subId, planId, payId, amount = 29900 }) {
  return {
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: { id: subId, plan_id: planId, current_end: Math.floor(Date.now() / 1000) + 30 * 86400 },
      },
      payment: { entity: { id: payId, amount, method: 'upi' } },
    },
  };
}
function statusPayload(event, subId) {
  return { event, payload: { subscription: { entity: { id: subId } } } };
}
let evt = 0;
const fire = (payload) => rz.handleWebhook(payload, `evt_lc_${Date.now()}_${evt++}`);

// The developer's .env (dotenv-loaded by config/env) may carry rzp_test_ keys
// into the jest process, so BOTH modes are forced explicitly rather than
// assumed from a clean environment. Plan-level checkout is 'gateway' only with
// a LIVE-prefixed key + webhook secret (checkoutMode({ requireLive: true })).
const ENV_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
async function withEnv(patch, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try { return await fn(); } finally { Object.assign(env, saved); }
}
/** 'gateway' mode for one test body (createSubscription is always stubbed). */
const inGatewayMode = (fn) => withEnv({
  RAZORPAY_KEY_ID: 'rzp_live_lifecycle_fake',
  RAZORPAY_KEY_SECRET: 'lifecycle-secret',
  RAZORPAY_WEBHOOK_SECRET: 'lifecycle-webhook',
}, fn);
/** 'manual' mode (no gateway at all) for one test body. */
const inManualMode = (fn) => withEnv({
  RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '',
}, fn);

/**
 * Stand-in for razorpayService.createSubscription: does the two DB writes the
 * real one does (repoint the gateway pointer + stamp the reactivation marker)
 * and returns the checkout shape, without an HTTPS round trip.
 */
function stubCreateSubscription(rzpId) {
  return jest.spyOn(rz, 'createSubscription').mockImplementation(async (businessId, tier, opts = {}) => {
    await query(
      `UPDATE subscriptions
          SET razorpay_subscription_id = $1::text, reactivation_rzp_subscription_id = $1::text
        WHERE business_id = $2`,
      [rzpId, businessId],
    );
    return {
      subscriptionId: rzpId,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      firstChargeAt: opts.startAt ? new Date(opts.startAt).toISOString() : null,
      plan: { tier, billingPeriod: opts.billingPeriod || 'monthly' },
      checkoutOptions: { key: env.RAZORPAY_KEY_ID, subscription_id: rzpId },
    };
  });
}

// ── A1. POST /billing/resume is ONLY an undo-cancel ─────────────────────

describe('A1: resume refuses every status except active + cancel_at_period_end', () => {
  const cases = [
    ['trialing', { status: 'trialing', trialEndsAt: new Date(Date.now() + 5 * 86400000) }],
    ['expired trial', { status: 'trialing', trialEndsAt: new Date(Date.now() - 5 * 86400000) }],
    ['past_due', { status: 'past_due' }],
    ['cancelled', { status: 'cancelled' }],
    ['expired', { status: 'expired' }],
    ['active without a pending cancel', { status: 'active', cancelAtPeriodEnd: false }],
  ];

  it.each(cases)('%s → 409 RESUME_NOT_ALLOWED and the row is untouched', async (label, state) => {
    const b = await bizWith({ name: `A1 ${label}`, email: `a1-${label.replace(/\W+/g, '')}@example.com`, tier: 'pro', ...state });
    const before = await subFor(b.id);
    const r = await request(app).post(`/v1/businesses/${b.id}/billing/resume`).set(auth(b));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('RESUME_NOT_ALLOWED');
    expect(r.body.details?.upgradePath).toBe('/billing');
    const after = await subFor(b.id);
    // THE BUG THIS LOCKS DOWN: this used to become 'active' on the paid plan.
    expect(after.status).toBe(before.status);
    expect(after.plan_tier).toBe('pro');
  });

  it('undo-cancel with no gateway subscription clears the flag and keeps the period', async () => {
    const b = await bizWith({ name: 'A1 undo', email: 'a1-undo@example.com', cancelAtPeriodEnd: true });
    await query('UPDATE subscriptions SET cancelled_at = NOW() WHERE business_id = $1', [b.id]);
    const before = await subFor(b.id);
    const r = await request(app).post(`/v1/businesses/${b.id}/billing/resume`).set(auth(b));
    expect(r.status).toBe(200);
    expect(r.body.resumed).toBe(true);
    expect(r.body.requiresCheckout).toBe(false);
    const after = await subFor(b.id);
    expect(after.status).toBe('active');
    expect(after.cancel_at_period_end).toBe(false);
    expect(after.cancelled_at).toBeNull();
    expect(after.current_period_end).toEqual(before.current_period_end); // not extended
  });

  it('undo-cancel of a PAID plan behind a gateway returns checkout and changes nothing until the charge lands', async () => {
    const b = await bizWith({
      name: 'A1 gateway', email: 'a1-gw@example.com', razorpayId: 'sub_a1_old', cancelAtPeriodEnd: true,
    });
    await query('UPDATE subscriptions SET cancelled_at = NOW() WHERE business_id = $1', [b.id]);
    const before = await subFor(b.id);

    await inGatewayMode(async () => {
      const spy = stubCreateSubscription('sub_a1_new');
      const r = await request(app).post(`/v1/businesses/${b.id}/billing/resume`).set(auth(b));
      expect(r.status).toBe(200);
      expect(r.body.requiresCheckout).toBe(true);
      expect(r.body.resumed).toBe(false);
      expect(r.body.checkout.checkoutOptions.subscription_id).toBe('sub_a1_new');
      // The paid days are honoured: the new mandate's first charge is scheduled
      // at the current period end rather than now.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(new Date(spy.mock.calls[0][2].startAt).getTime())
        .toBe(new Date(before.current_period_end).getTime());
      expect(r.body.checkout.firstChargeAt).toBeTruthy();
    });

    // Nothing has changed yet — a dismissed checkout must leave the cancel in place.
    const mid = await subFor(b.id);
    expect(mid.cancel_at_period_end).toBe(true);
    expect(mid.cancelled_at).not.toBeNull();
    expect(mid.razorpay_subscription_id).toBe('sub_a1_new');
    expect(mid.reactivation_rzp_subscription_id).toBe('sub_a1_new');

    // A stray charge on the OLD mandate still does not reactivate.
    await fire(chargedPayload({ subId: 'sub_a1_old', planId: 'plan_LC_BASIC', payId: 'pay_a1_stray' }));
    expect((await subFor(b.id)).cancel_at_period_end).toBe(true);

    // The first charge on the NEW mandate does.
    await fire(chargedPayload({ subId: 'sub_a1_new', planId: 'plan_LC_BASIC', payId: 'pay_a1_new' }));
    const after = await subFor(b.id);
    expect(after.status).toBe('active');
    expect(after.cancel_at_period_end).toBe(false);
    expect(after.cancelled_at).toBeNull();
    expect(after.reactivation_rzp_subscription_id).toBeNull(); // consumed: one reactivation only
    expect(after.plan_tier).toBe('basic');
    const trail = await query(
      "SELECT 1 FROM subscription_lifecycle_events WHERE business_id = $1 AND event = 'uncancelled'",
      [b.id],
    );
    expect(trail.rowCount).toBe(1);
  });

  it('a tenant who cancelled and later re-subscribes through checkout gets the plan (marker path)', async () => {
    // Pre-existing hole closed by the same marker: status='cancelled' + a NEW
    // checkout used to be "charged, never activated".
    const b = await bizWith({ name: 'A1 rebuy', email: 'a1-rebuy@example.com', status: 'cancelled', razorpayId: 'sub_a1_dead' });
    await query('UPDATE subscriptions SET cancelled_at = NOW() WHERE business_id = $1', [b.id]);
    await query(
      `UPDATE subscriptions SET razorpay_subscription_id = 'sub_a1_rebuy',
              reactivation_rzp_subscription_id = 'sub_a1_rebuy' WHERE business_id = $1`,
      [b.id],
    );
    await fire(chargedPayload({ subId: 'sub_a1_rebuy', planId: 'plan_LC_PRO', payId: 'pay_a1_rebuy', amount: 79900 }));
    const after = await subFor(b.id);
    expect(after.status).toBe('active');
    expect(after.plan_tier).toBe('pro');
    expect(after.cancelled_at).toBeNull();
  });
});

// ── A3. Downgrade to the free plan is scheduled, and the mandate is stopped ──

describe('A3: downgrade to a ₹0 plan cancels the mandate at cycle end and lands at period end', () => {
  let biz; let freeId;

  beforeAll(async () => {
    freeId = await planIdFor('free');
    biz = await bizWith({ name: 'A3 Downgrade', email: 'a3@example.com', tier: 'basic', razorpayId: 'sub_a3_paid' });
  });

  it('schedules instead of flipping, and tells Razorpay to stop at cycle end', async () => {
    const cancelSpy = jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/change`).set(auth(biz)).send({ tier: 'free' });
    expect(r.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledWith(biz.id, { atCycleEnd: true });
    expect(r.body.subscription.scheduled).toBe(true);
    expect(r.body.subscription.plan.tier).toBe('basic'); // still on what they paid for
    expect(r.body.subscription.pendingPlan.tier).toBe('free');
    expect(r.body.subscription.cancelAtPeriodEnd).toBe(true);
    expect(r.body.subscription.prorationInr).toBe(0);
    const sub = await subFor(biz.id);
    expect(sub.plan_tier).toBe('basic');
    expect(sub.pending_plan_id).toBe(freeId);
    expect(sub.cancel_at_period_end).toBe(true);
    expect(sub.status).toBe('active');
  });

  it('the billing read shows the pending plan', async () => {
    const r = await request(app).get(`/v1/businesses/${biz.id}/billing`).set(auth(biz));
    expect(r.status).toBe(200);
    expect(r.body.subscription.pendingPlan.tier).toBe('free');
  });

  it('a subscription.charged on the old mandate does NOT put them back on the paid plan', async () => {
    // THE BUG THIS LOCKS DOWN.
    await fire(chargedPayload({ subId: 'sub_a3_paid', planId: 'plan_LC_BASIC', payId: 'pay_a3_late' }));
    const sub = await subFor(biz.id);
    expect(sub.pending_plan_id).toBe(freeId);
    expect(sub.cancel_at_period_end).toBe(true);
    // The money is still in the ledger — they were charged.
    const pay = await query("SELECT 1 FROM payments WHERE razorpay_payment_id = 'pay_a3_late'");
    expect(pay.rowCount).toBe(1);
  });

  it('resume undoes the scheduled downgrade (no gateway checkout needed when the mandate is still ours)', async () => {
    // Manual mode (no keys): the undo simply clears the flag + pending plan.
    const r = await inManualMode(() => request(app)
      .post(`/v1/businesses/${biz.id}/billing/resume`).set(auth(biz)));
    expect(r.status).toBe(200);
    const sub = await subFor(biz.id);
    expect(sub.pending_plan_id).toBeNull();
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.plan_tier).toBe('basic');
  });

  it('the gateway cancelled/completed webhook lands the downgrade on the free plan as active', async () => {
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await request(app).post(`/v1/businesses/${biz.id}/billing/change`).set(auth(biz)).send({ tier: 'free' });
    const clearSpy = jest.spyOn(featureService, 'clearCache');
    await fire(statusPayload('subscription.cancelled', 'sub_a3_paid'));
    const sub = await subFor(biz.id);
    expect(sub.plan_tier).toBe('free');
    expect(sub.status).toBe('active'); // A10: never 'trialing' / 'cancelled' on the free plan
    expect(sub.pending_plan_id).toBeNull();
    expect(sub.cancel_at_period_end).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(biz.id); // A8
  });

  it('the nightly sweep lands a scheduled downgrade whose period has passed, and closes lapsed cancels', async () => {
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    const b = await bizWith({ name: 'A3 Sweep', email: 'a3-sweep@example.com', tier: 'pro', razorpayId: 'sub_a3_sweep' });
    await request(app).post(`/v1/businesses/${b.id}/billing/change`).set(auth(b)).send({ tier: 'free' });
    expect((await subFor(b.id)).plan_tier).toBe('pro');
    await query("UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '1 hour' WHERE business_id = $1", [b.id]);

    const lapsed = await bizWith({
      name: 'A3 Lapsed',
      email: 'a3-lapsed@example.com',
      cancelAtPeriodEnd: true,
      periodEnd: "NOW() - INTERVAL '5 days'",
    });
    const fresh = await bizWith({
      name: 'A3 Fresh cancel',
      email: 'a3-fresh@example.com',
      cancelAtPeriodEnd: true,
      periodEnd: "NOW() - INTERVAL '1 day'", // inside the 3-day webhook slack
    });

    const out = await subs.sweepPeriodEndTransitions();
    expect(out.downgraded).toBeGreaterThanOrEqual(1);
    expect(out.cancelled).toBeGreaterThanOrEqual(1);
    expect((await subFor(b.id)).plan_tier).toBe('free');
    expect((await subFor(b.id)).status).toBe('active');
    expect((await subFor(lapsed.id)).status).toBe('cancelled');
    expect((await subFor(fresh.id)).status).toBe('active'); // webhook still has time
  });

  it('a downgrade with no paid period to honour (trial / no mandate) still applies immediately, as active', async () => {
    const b = await bizWith({
      name: 'A3 Trial',
      email: 'a3-trial@example.com',
      tier: 'pro',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() - 86400000), // expired trial
    });
    const r = await request(app).post(`/v1/businesses/${b.id}/billing/change`).set(auth(b)).send({ tier: 'free' });
    expect(r.status).toBe(200);
    const sub = await subFor(b.id);
    expect(sub.plan_tier).toBe('free');
    expect(sub.status).toBe('active'); // A10
    expect(sub.pending_plan_id).toBeNull();
  });
});

// ── A4. Pause → resume of a paid plan re-bills through checkout ─────────

describe('A4: resuming a paused PAID plan behind a gateway goes through checkout', () => {
  let biz;

  beforeAll(async () => {
    biz = await bizWith({ name: 'A4 Seasonal', email: 'a4@example.com', tier: 'pro', razorpayId: 'sub_a4_old' });
    await query('UPDATE businesses SET phone = $2 WHERE id = $1', [biz.id, '+919000000004']);
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await churn.pause(biz.id, { months: 1 });
    jest.restoreAllMocks();
  });

  it('the gateway cancelled webhook for the paused mandate leaves the row PAUSED', async () => {
    expect((await subFor(biz.id)).status).toBe('paused');
    // Outcome (a) of the finding: this used to flip the row to 'cancelled'.
    await fire(statusPayload('subscription.cancelled', 'sub_a4_old'));
    expect((await subFor(biz.id)).status).toBe('paused');
  });

  it('resume returns checkout for the parked plan and the row stays paused', async () => {
    await inGatewayMode(async () => {
      const spy = stubCreateSubscription('sub_a4_new');
      const r = await request(app).post(`/v1/businesses/${biz.id}/billing/resume`).set(auth(biz));
      expect(r.status).toBe(200);
      expect(r.body.requiresCheckout).toBe(true);
      expect(r.body.resumed).toBe(false);
      expect(r.body.planTier).toBe('pro');
      expect(spy).toHaveBeenCalledWith(biz.id, 'pro', expect.objectContaining({ billingPeriod: 'monthly' }));
    });
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('paused'); // THE BUG THIS LOCKS DOWN: used to be 'active' with no mandate
    expect(sub.pause_plan_id).toBeTruthy();
    const trail = await query(
      "SELECT 1 FROM subscription_lifecycle_events WHERE business_id = $1 AND event = 'resume_checkout_started'",
      [biz.id],
    );
    expect(trail.rowCount).toBe(1);
  });

  it('a paused account still cannot bill while the checkout is pending', async () => {
    const item = await request(app).post(`/v1/businesses/${biz.id}/menu`).set(auth(biz))
      .send({ name: 'Vada', price: 30, stock: 50 });
    const r = await request(app).post(`/v1/businesses/${biz.id}/orders`).set(auth(biz))
      .send({ items: [{ menuItemId: item.body.item?.id || null, name: 'Vada', price: 30, qty: 1 }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('SUBSCRIPTION_PAUSED');
  });

  it('the first charge on the new mandate restores the SAME plan and clears the pause', async () => {
    await fire(chargedPayload({ subId: 'sub_a4_new', planId: 'plan_LC_PRO', payId: 'pay_a4_new', amount: 79900 }));
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('active');
    expect(sub.plan_tier).toBe('pro');
    expect(sub.paused_at).toBeNull();
    expect(sub.pause_ends_at).toBeNull();
    expect(sub.pause_plan_id).toBeNull();
    expect(sub.reactivation_rzp_subscription_id).toBeNull();
    expect(sub.last_pause_at).toBeTruthy(); // the 12-month cooldown record survives
    const trail = await query(
      "SELECT 1 FROM subscription_lifecycle_events WHERE business_id = $1 AND event = 'resumed'",
      [biz.id],
    );
    expect(trail.rowCount).toBe(1);
  });

  it('the nightly auto-resume cannot open checkout: it nudges the owner and keeps the pause', async () => {
    const b = await bizWith({ name: 'A4 Cron', email: 'a4-cron@example.com', tier: 'basic', razorpayId: 'sub_a4_cron' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await churn.pause(b.id, { months: 1 });
    await query("UPDATE subscriptions SET pause_ends_at = NOW() - INTERVAL '1 day' WHERE business_id = $1", [b.id]);
    const push = require('../../src/services/pushService');
    const pushSpy = jest.spyOn(push, 'sendToBusinessOwners').mockResolvedValue(undefined);
    const createSpy = jest.spyOn(rz, 'createSubscription');
    await inGatewayMode(async () => {
      await churn.autoResumeDue();
    });
    const sub = await subFor(b.id);
    expect(sub.status).toBe('paused');
    expect(createSpy).not.toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalled();
    // Re-asks in a week instead of every night.
    expect(new Date(sub.pause_ends_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
  });

  it('a stray charge on the OLD paused mandate is recorded but does not un-pause', async () => {
    const b = await bizWith({ name: 'A4 Stray', email: 'a4-stray@example.com', tier: 'basic', razorpayId: 'sub_a4_stray' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await churn.pause(b.id, { months: 1 });
    await fire(chargedPayload({ subId: 'sub_a4_stray', planId: 'plan_LC_BASIC', payId: 'pay_a4_stray' }));
    expect((await subFor(b.id)).status).toBe('paused');
    expect((await query("SELECT 1 FROM payments WHERE razorpay_payment_id = 'pay_a4_stray'")).rowCount).toBe(1);
  });

  it('manual mode (no gateway) still restores immediately — the demo/CI path', async () => {
    const b = await bizWith({ name: 'A4 Manual', email: 'a4-manual@example.com', tier: 'basic' });
    await churn.pause(b.id, { months: 1 });
    const r = await inManualMode(() => churn.resume(b.id));
    expect(r.resumed).toBe(true);
    expect((await subFor(b.id)).status).toBe('active');
  });
});

// ── A6. Admin suspension is its own status and the tenant cannot lift it ──

describe('A6: suspend/restore', () => {
  let biz; let idliId;

  beforeAll(async () => {
    biz = await bizWith({
      name: 'A6 Suspended',
      email: 'a6@example.com',
      tier: 'pro',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 5 * 86400000),
    });
    const item = await request(app).post(`/v1/businesses/${biz.id}/menu`).set(auth(biz))
      .send({ name: 'Idli', price: 40, stock: 50 });
    idliId = item.body.item?.id || null;
  });

  it('suspend parks the prior status and busts the feature cache', async () => {
    const clearSpy = jest.spyOn(featureService, 'clearCache');
    const row = await adminService.suspend(biz.id);
    expect(row.status).toBe('suspended');
    expect(row.pre_suspend_status).toBe('trialing');
    expect(clearSpy).toHaveBeenCalledWith(biz.id);
    // Idempotent — a second suspend does not overwrite the parked status.
    expect(await adminService.suspend(biz.id)).toBeNull();
    expect((await subFor(biz.id)).pre_suspend_status).toBe('trialing');
  });

  it('a suspended tenant falls to the Starter feature set', async () => {
    const summary = await featureService.planSummary(biz.id);
    expect(summary.tierKind).toBe('starter');
  });

  it('POST /billing/resume → 403 ACCOUNT_SUSPENDED (this used to undo the suspension)', async () => {
    const r = await request(app).post(`/v1/businesses/${biz.id}/billing/resume`).set(auth(biz));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_SUSPENDED');
    expect((await subFor(biz.id)).status).toBe('suspended');
  });

  it('pause and change-plan are refused too', async () => {
    const p = await request(app).post(`/v1/businesses/${biz.id}/billing/pause`).set(auth(biz)).send({ months: 1 });
    expect(p.status).toBe(403);
    expect(p.body.error).toBe('ACCOUNT_SUSPENDED');
    const c = await request(app).post(`/v1/businesses/${biz.id}/billing/change`).set(auth(biz)).send({ tier: 'basic' });
    expect(c.status).toBe(403);
    expect(c.body.error).toBe('ACCOUNT_SUSPENDED');
  });

  it('new bills are blocked with the suspension message, not the pause one', async () => {
    const r = await request(app).post(`/v1/businesses/${biz.id}/orders`).set(auth(biz))
      .send({ items: [{ menuItemId: idliId, name: 'Idli', price: 40, qty: 1 }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_SUSPENDED');
    expect(r.body.message).toMatch(/suspended/i);
  });

  it('the billing read carries a suspension block and no pause banner', async () => {
    const r = await request(app).get(`/v1/businesses/${biz.id}/billing`).set(auth(biz));
    expect(r.status).toBe(200);
    expect(r.body.subscription.status).toBe('suspended');
    expect(r.body.subscription.suspension.suspended).toBe(true);
    expect(r.body.subscription.pause).toBeNull();
  });

  it('money arriving does not lift a suspension', async () => {
    await query("UPDATE subscriptions SET razorpay_subscription_id = 'sub_a6_paid' WHERE business_id = $1", [biz.id]);
    await fire(chargedPayload({ subId: 'sub_a6_paid', planId: 'plan_LC_PRO', payId: 'pay_a6', amount: 79900 }));
    expect((await subFor(biz.id)).status).toBe('suspended');
    await fire(statusPayload('subscription.activated', 'sub_a6_paid'));
    expect((await subFor(biz.id)).status).toBe('suspended');
    await fire(statusPayload('subscription.paused', 'sub_a6_paid'));
    expect((await subFor(biz.id)).status).toBe('suspended');
  });

  it('restore returns to the parked status (trialing), not to active on a paid plan', async () => {
    const clearSpy = jest.spyOn(featureService, 'clearCache');
    const row = await adminService.restore(biz.id);
    expect(row.status).toBe('trialing');
    expect(clearSpy).toHaveBeenCalledWith(biz.id);
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('trialing');
    expect(sub.pre_suspend_status).toBeNull();
    expect(sub.suspended_at).toBeNull();
    // restore on a row that is not suspended is a no-op
    expect(await adminService.restore(biz.id)).toBeNull();
    expect((await subFor(biz.id)).status).toBe('trialing');
  });
});

// ── A8. Gateway status webhooks bust the feature cache ──────────────────

describe('A8: status webhooks clear the feature cache', () => {
  it('subscription.paused and subscription.cancelled both call clearCache for the tenant', async () => {
    const b = await bizWith({ name: 'A8', email: 'a8@example.com', razorpayId: 'sub_a8' });
    const clearSpy = jest.spyOn(featureService, 'clearCache');
    await fire(statusPayload('subscription.paused', 'sub_a8'));
    expect(clearSpy).toHaveBeenCalledWith(b.id);
    expect((await subFor(b.id)).status).toBe('paused');
    clearSpy.mockClear();
    // An owner-cancelled (not paused) row → cancelled + cache bust.
    await query("UPDATE subscriptions SET status = 'active', cancel_at_period_end = TRUE WHERE business_id = $1", [b.id]);
    await fire(statusPayload('subscription.cancelled', 'sub_a8'));
    expect(clearSpy).toHaveBeenCalledWith(b.id);
    expect((await subFor(b.id)).status).toBe('cancelled');
  });
});

// ── A9/A10/F4. Free-plan status + extendTrial guard ─────────────────────

describe('A10 + F4: admin plan/trial writes', () => {
  it('setPlanManually onto the ₹0 plan is active, and onto a paid plan is active with a rolled period', async () => {
    const b = await bizWith({ name: 'A10', email: 'a10@example.com', tier: 'pro', status: 'trialing', trialEndsAt: new Date(Date.now() + 86400000) });
    await customerAdmin.setPlanManually(b.id, 'free');
    let sub = await subFor(b.id);
    expect(sub.plan_tier).toBe('free');
    expect(sub.status).toBe('active'); // was 'trialing' forever
    await customerAdmin.setPlanManually(b.id, 'basic', { billingPeriod: 'monthly' });
    sub = await subFor(b.id);
    expect(sub.plan_tier).toBe('basic');
    expect(sub.status).toBe('active');
    expect(new Date(sub.current_period_end).getTime()).toBeGreaterThan(Date.now() + 25 * 86400000);
  });

  it('extendTrial only extends a trialing row; an active paying tenant is 409', async () => {
    const trial = await bizWith({
      name: 'F4 trial',
      email: 'f4-trial@example.com',
      tier: 'pro',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 2 * 86400000),
    });
    const before = await subFor(trial.id);
    await customerAdmin.extendTrial(trial.id, 7);
    const after = await subFor(trial.id);
    expect(after.status).toBe('trialing');
    expect(new Date(after.trial_ends_at) - new Date(before.trial_ends_at)).toBeGreaterThan(6.9 * 86400000);

    const paying = await bizWith({ name: 'F4 paying', email: 'f4-paying@example.com', tier: 'basic' });
    await expect(customerAdmin.extendTrial(paying.id, 7)).rejects.toMatchObject({ statusCode: 409, code: 'NOT_TRIALING' });
    expect((await subFor(paying.id)).status).toBe('active'); // THE BUG: used to become 'trialing'
  });

  it('createCustomer on the free plan is active, not a trial', async () => {
    const biz = await customerAdmin.createCustomer({
      email: 'f4-created@example.com', name: 'Created Cafe', planTier: 'free',
    });
    const sub = await subFor(biz.id);
    expect(sub.plan_tier).toBe('free');
    expect(sub.status).toBe('active');
  });
});
