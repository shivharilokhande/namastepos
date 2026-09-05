// Round-2 fix batch (2026-09-06), founder billing-policy defaults
// (CONTRACTS header + §5/§6):
//
//   • adminService.suspend cancels the Razorpay mandate AT CYCLE END when the
//     row has one (recorded: cancel flag + lifecycle row); no refunds.
//   • adminService.restore of a PAID plan whose mandate is gone returns
//     { requiresCheckout: true, checkout } instead of flipping to active —
//     period still paid → active + flag kept + first charge at period end;
//     period lapsed → cancelled + checkout charging now. The first charge on
//     the new gateway sub (reactivation marker) is what reactivates.
//   • addonService.cancel on a PAID addon inside its paid period is now
//     cancel-at-period-end: status/period untouched, feature still granted
//     until current_period_end, resume() undoes it without a charge. Free
//     addons (and paid ones with nothing left to honour) cancel immediately.
//
// Conventions from lifecycleBilling2026 / addonResumeBilling2026: env-forced
// gateway/manual mode, createSubscription / cancelSubscription stubbed at the
// module boundary, webhook fired through rz.handleWebhook.

const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const rz = require('../../src/services/razorpayService');
const adminService = require('../../src/services/adminService');
const addonService = require('../../src/services/addonService');
const featureService = require('../../src/services/featureService');
const { issueAccessToken } = require('../../src/utils/jwt');

let app;
let superToken;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  await query("UPDATE plans SET razorpay_plan_id = 'plan_R2B_BASIC' WHERE tier = 'basic'");
  const a = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ('r2b-billing-super@example.com', 'x', 'super_admin', TRUE) RETURNING id, email`,
  );
  superToken = issueAccessToken({
    sid: a.rows[0].id, isSuperAdmin: true, email: a.rows[0].email, role: 'super_admin',
  });
});
afterAll(async () => { await closePool(); });
afterEach(() => { jest.restoreAllMocks(); });

const admin = () => ({ Cookie: `ff_admin=${superToken}` });
const auth = (biz) => ({ Authorization: `Bearer ${tokenFor(biz)}` });
const planIdFor = async (tier) => (await query('SELECT id FROM plans WHERE tier = $1', [tier])).rows[0].id;
const subFor = async (businessId) => (await query('SELECT * FROM subscriptions WHERE business_id = $1', [businessId])).rows[0] || null;
const lifecycle = async (businessId, event) => (await query(
  'SELECT * FROM subscription_lifecycle_events WHERE business_id = $1 AND event = $2 ORDER BY created_at DESC',
  [businessId, event],
)).rows;

async function bizWith({
  name, email, tier = 'basic', status = 'active', razorpayId = null,
  cancelAtPeriodEnd = false, periodEnd = "NOW() + INTERVAL '20 days'",
}) {
  const b = await makeBusiness({ name, email });
  await query(
    `INSERT INTO subscriptions
       (business_id, plan_id, status, billing_period, razorpay_subscription_id,
        cancel_at_period_end, current_period_start, current_period_end)
     VALUES ($1, $2, $3::subscription_status, 'monthly', $4, $5, NOW() - INTERVAL '10 days', ${periodEnd})`,
    [b.id, await planIdFor(tier), status, razorpayId, cancelAtPeriodEnd],
  );
  return b;
}

const ENV_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
async function withEnv(patch, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try { return await fn(); } finally { Object.assign(env, saved); }
}
const inGatewayMode = (fn) => withEnv({
  RAZORPAY_KEY_ID: 'rzp_live_r2b_fake', RAZORPAY_KEY_SECRET: 'r2b-secret', RAZORPAY_WEBHOOK_SECRET: 'r2b-webhook',
}, fn);
const inManualMode = (fn) => withEnv({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '' }, fn);

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
      firstChargeAt: opts.startAt ? new Date(opts.startAt).toISOString() : null,
      plan: { tier, billingPeriod: opts.billingPeriod || 'monthly' },
      checkoutOptions: { key: env.RAZORPAY_KEY_ID, subscription_id: rzpId },
    };
  });
}
let evt = 0;
const charged = (subId, payId) => rz.handleWebhook({
  event: 'subscription.charged',
  payload: {
    subscription: { entity: { id: subId, plan_id: 'plan_R2B_BASIC', current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
    payment: { entity: { id: payId, amount: 29900, method: 'upi' } },
  },
}, `evt_r2b_${Date.now()}_${evt++}`);

// ── Suspend cancels the mandate at cycle end ──────────────────────────────

describe('suspend: mandate handling', () => {
  it('cancels the Razorpay mandate at cycle end and records it', async () => {
    const b = await bizWith({ name: 'Susp Mandate', email: 'r2b-susp1@example.com', razorpayId: 'sub_r2b_s1' });
    const cancelSpy = jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true, razorpaySubscriptionId: 'sub_r2b_s1' });
    const r = await request(app).post(`/v1/admin/customers/${b.id}/suspend`).set(admin());
    expect(r.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledWith(b.id, { atCycleEnd: true });
    expect(r.body.subscription.status).toBe('suspended');
    expect(r.body.mandate).toEqual(expect.objectContaining({ cancelled: true }));
    const row = await subFor(b.id);
    expect(row.status).toBe('suspended');
    expect(row.pre_suspend_status).toBe('active');
    expect(row.cancel_at_period_end).toBe(true); // "mandate not to renew" recorded
    expect(row.cancelled_at).not.toBeNull();
    const trail = await lifecycle(b.id, 'suspended');
    expect(trail).toHaveLength(1);
    expect(trail[0].meta.mandateCancelled).toBe(true);
  });

  it('does not call the gateway when there is no mandate (free plan / no gateway sub)', async () => {
    const b = await bizWith({ name: 'Susp NoMandate', email: 'r2b-susp2@example.com', tier: 'free' });
    const cancelSpy = jest.spyOn(rz, 'cancelSubscription');
    const row = await adminService.suspend(b.id);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(row.status).toBe('suspended');
    expect(row.cancel_at_period_end).toBe(false);
    expect(row.mandate.cancelled).toBe(false);
    // Restore of an unpaid plan is the plain flip, no checkout.
    const back = await adminService.restore(b.id);
    expect(back.status).toBe('active');
    expect(back.requiresCheckout).toBe(false);
  });

  it('a gateway failure never blocks the hold (flag still recorded)', async () => {
    const b = await bizWith({ name: 'Susp GwFail', email: 'r2b-susp3@example.com', razorpayId: 'sub_r2b_s3' });
    jest.spyOn(rz, 'cancelSubscription').mockRejectedValue(new Error('razorpay down'));
    const row = await adminService.suspend(b.id);
    expect(row.status).toBe('suspended');
    expect(row.cancel_at_period_end).toBe(true);
    expect(row.mandate).toEqual(expect.objectContaining({ cancelled: false, reason: 'gateway_error' }));
  });

  it('a stray charge on the cancelled mandate is recorded, never reactivates', async () => {
    const b = await bizWith({ name: 'Susp Stray', email: 'r2b-susp4@example.com', razorpayId: 'sub_r2b_s4' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await adminService.suspend(b.id);
    await charged('sub_r2b_s4', 'pay_r2b_s4');
    expect((await subFor(b.id)).status).toBe('suspended');
    const pays = await query('SELECT 1 FROM payments WHERE razorpay_payment_id = $1', ['pay_r2b_s4']);
    expect(pays.rowCount).toBe(1);
  });
});

// ── Restore of a paid plan whose mandate is gone → checkout ───────────────

describe('restore: paid plan, mandate cancelled', () => {
  it('period still paid → active + flag kept, checkout with first charge at period end; charge reactivates', async () => {
    const b = await bizWith({ name: 'Restore InPeriod', email: 'r2b-rest1@example.com', razorpayId: 'sub_r2b_r1' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await adminService.suspend(b.id);
    const periodEnd = (await subFor(b.id)).current_period_end;

    await inGatewayMode(async () => {
      const create = stubCreateSubscription('sub_r2b_r1_new');
      const r = await request(app).post(`/v1/admin/customers/${b.id}/restore`).set(admin());
      expect(r.status).toBe(200);
      expect(r.body.requiresCheckout).toBe(true);
      expect(r.body.checkout.subscriptionId).toBe('sub_r2b_r1_new');
      expect(r.body.checkout.checkoutOptions.subscription_id).toBe('sub_r2b_r1_new');
      expect(r.body.message).toMatch(/set up payment again/i);
      expect(create).toHaveBeenCalledTimes(1);
      expect(new Date(create.mock.calls[0][2].startAt).getTime()).toBe(new Date(periodEnd).getTime());
    });
    const row = await subFor(b.id);
    expect(row.status).toBe('active'); // they own the paid days
    expect(row.cancel_at_period_end).toBe(true); // …but nothing renews until they pay
    expect(row.pre_suspend_status).toBeNull();
    expect(row.suspended_at).toBeNull();
    expect(row.reactivation_rzp_subscription_id).toBe('sub_r2b_r1_new');
    expect(new Date(row.current_period_end).getTime()).toBe(new Date(periodEnd).getTime()); // untouched
    expect((await lifecycle(b.id, 'restored'))[0].meta.requiresCheckout).toBe(true);

    // The tenant sees it as a pending re-authorisation and can get the same checkout from /billing/resume.
    const bill = await request(app).get(`/v1/businesses/${b.id}/billing`).set(auth(b));
    expect(bill.body.subscription.status).toBe('active');
    expect(bill.body.subscription.cancelAtPeriodEnd).toBe(true);
    expect(bill.body.subscription.reactivationPending).toBe(true);

    // First charge on the NEW sub → active, flag cleared, marker consumed.
    await charged('sub_r2b_r1_new', 'pay_r2b_r1');
    const after = await subFor(b.id);
    expect(after.status).toBe('active');
    expect(after.cancel_at_period_end).toBe(false);
    expect(after.reactivation_rzp_subscription_id).toBeNull();
    expect(new Date(after.current_period_end).getTime()).toBeGreaterThan(new Date(periodEnd).getTime());
  });

  it('period already lapsed → cancelled + checkout charging now (never a free active plan)', async () => {
    const b = await bizWith({
      name: 'Restore Lapsed',
      email: 'r2b-rest2@example.com',
      razorpayId: 'sub_r2b_r2',
      periodEnd: "NOW() - INTERVAL '2 days'",
    });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await adminService.suspend(b.id);
    await inGatewayMode(async () => {
      const create = stubCreateSubscription('sub_r2b_r2_new');
      const out = await adminService.restore(b.id);
      expect(out.requiresCheckout).toBe(true);
      expect(out.status).toBe('cancelled');
      expect(create.mock.calls[0][2].startAt).toBeNull(); // charge now — nothing paid remains
    });
    const row = await subFor(b.id);
    expect(row.status).toBe('cancelled');
    expect(await featureService.hasFeature(b.id, 'aggregators')).toBe(false); // basic's key, not entitled
    await charged('sub_r2b_r2_new', 'pay_r2b_r2');
    expect((await subFor(b.id)).status).toBe('active');
  });

  it('manual mode (no gateway, non-prod) → restored to the parked status with the flag cleared', async () => {
    const b = await bizWith({ name: 'Restore Manual', email: 'r2b-rest3@example.com', razorpayId: 'sub_r2b_r3' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await adminService.suspend(b.id);
    const out = await inManualMode(() => adminService.restore(b.id));
    expect(out.requiresCheckout).toBe(false);
    const row = await subFor(b.id);
    expect(row.status).toBe('active');
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('production without a live gateway → 503 PAYMENTS_UNAVAILABLE, row stays suspended', async () => {
    const b = await bizWith({ name: 'Restore Prod', email: 'r2b-rest4@example.com', razorpayId: 'sub_r2b_r4' });
    jest.spyOn(rz, 'cancelSubscription').mockResolvedValue({ cancelled: true });
    await adminService.suspend(b.id);
    const saved = env.NODE_ENV;
    Object.assign(env, { NODE_ENV: 'production' });
    try {
      const r = await withEnv({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'x', RAZORPAY_WEBHOOK_SECRET: '' }, () => request(app)
        .post(`/v1/admin/customers/${b.id}/restore`).set(admin()));
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('PAYMENTS_UNAVAILABLE');
    } finally {
      Object.assign(env, { NODE_ENV: saved });
    }
    expect((await subFor(b.id)).status).toBe('suspended');
  });

  it('restore of a non-suspended row is a no-op (idempotent)', async () => {
    const b = await bizWith({ name: 'Restore Noop', email: 'r2b-rest5@example.com' });
    expect(await adminService.restore(b.id)).toBeNull();
    const r = await request(app).post(`/v1/admin/customers/${b.id}/restore`).set(admin());
    expect(r.status).toBe(200);
    expect(r.body.subscription).toBeNull();
    expect(r.body.requiresCheckout).toBe(false);
  });
});

// ── Paid addon cancel → cancel at period end ──────────────────────────────

describe('paid addon cancel is cancel-at-period-end', () => {
  let biz; let paid; let free;

  beforeAll(async () => {
    biz = await bizWith({ name: 'Addon Cancel Cafe', email: 'r2b-addon@example.com' });
    paid = (await query("SELECT * FROM addons WHERE slug = 'online-orders'")).rows[0];
    expect(Number(paid.price_inr_paise)).toBeGreaterThan(0);
    await query(
      `INSERT INTO addons (slug, name, price_inr_paise, billing_period, is_active, display_order, grants_features)
       VALUES ('r2b-free-tool', 'Free Tool', 0, 'monthly', TRUE, 997, ARRAY['forecast'])
       ON CONFLICT (slug) DO NOTHING`,
    );
    free = (await query("SELECT * FROM addons WHERE slug = 'r2b-free-tool'")).rows[0];
  });
  const rowFor = async (addonId) => (await query(
    'SELECT * FROM business_addons WHERE business_id = $1 AND addon_id = $2', [biz.id, addonId],
  )).rows[0] || null;

  it('inside the paid period: flag up, status + period untouched, feature still on', async () => {
    await query(
      `INSERT INTO business_addons (business_id, addon_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '12 days')`,
      [biz.id, paid.id],
    );
    const before = await rowFor(paid.id);
    const r = await request(app).post(`/v1/businesses/${biz.id}/addons/${paid.slug}/cancel`).set(auth(biz));
    expect(r.status).toBe(200);
    expect(r.body.activation.status).toBe('active');
    expect(r.body.activation.cancelAtPeriodEnd).toBe(true);
    expect(r.body.activation.endsAtPeriodEnd).toBe(true);
    const row = await rowFor(paid.id);
    expect(row.status).toBe('active');
    expect(row.cancel_at_period_end).toBe(true);
    expect(row.cancelled_at).not.toBeNull();
    expect(new Date(row.current_period_end).getTime()).toBe(new Date(before.current_period_end).getTime());
    // Still entitled until the period ends (featureService checks the period).
    expect(await addonService.hasAddon(biz.id, paid.slug)).toBe(true);
    expect(await featureService.hasFeature(biz.id, paid.slug)).toBe(true);
    for (const k of paid.grants_features || []) {
      // eslint-disable-next-line no-await-in-loop
      expect(await featureService.hasFeature(biz.id, k)).toBe(true);
    }
  });

  it('resume before the period ends UNDOES the cancel — no Razorpay order, period unchanged', async () => {
    const before = await rowFor(paid.id);
    await inGatewayMode(async () => {
      const orderSpy = jest.spyOn(rz, 'createOneTimeOrder');
      const r = await request(app).post(`/v1/businesses/${biz.id}/addons/${paid.slug}/resume`).set(auth(biz));
      expect(r.status).toBe(200);
      expect(r.body.activation.cancelAtPeriodEnd).toBe(false);
      expect(orderSpy).not.toHaveBeenCalled();
    });
    const row = await rowFor(paid.id);
    expect(row.cancel_at_period_end).toBe(false);
    expect(row.cancelled_at).toBeNull();
    expect(row.status).toBe('active');
    expect(new Date(row.current_period_end).getTime()).toBe(new Date(before.current_period_end).getTime());
  });

  it('once the period has ended the existing expiry path applies (hasAddon false, feature off)', async () => {
    await request(app).post(`/v1/businesses/${biz.id}/addons/${paid.slug}/cancel`).set(auth(biz)).expect(200);
    await query(
      "UPDATE business_addons SET current_period_end = NOW() - INTERVAL '1 minute' WHERE business_id = $1 AND addon_id = $2",
      [biz.id, paid.id],
    );
    featureService.clearCache(biz.id);
    expect(await addonService.hasAddon(biz.id, paid.slug)).toBe(false);
    expect(await featureService.hasFeature(biz.id, paid.slug)).toBe(false);
    // And a further cancel on the lapsed row is the immediate form.
    const r = await request(app).post(`/v1/businesses/${biz.id}/addons/${paid.slug}/cancel`).set(auth(biz));
    expect(r.status).toBe(200);
    expect(r.body.activation.endsAtPeriodEnd).toBe(false);
    expect((await rowFor(paid.id)).status).toBe('cancelled');
  });

  it('a paid addon on the 100-year free window (manual activation) cancels immediately', async () => {
    await query(
      `UPDATE business_addons SET status = 'active', cancel_at_period_end = FALSE, cancelled_at = NULL,
              current_period_end = NOW() + INTERVAL '100 years'
        WHERE business_id = $1 AND addon_id = $2`,
      [biz.id, paid.id],
    );
    const out = await addonService.cancel(biz.id, paid.slug);
    expect(out.endsAtPeriodEnd).toBe(false);
    expect(out.status).toBe('cancelled');
    expect(await addonService.hasAddon(biz.id, paid.slug)).toBe(false);
  });

  it('free addons cancel immediately, as before', async () => {
    await addonService.subscribe(biz.id, free.slug);
    expect(await featureService.hasFeature(biz.id, 'forecast')).toBe(true);
    const r = await request(app).post(`/v1/businesses/${biz.id}/addons/${free.slug}/cancel`).set(auth(biz));
    expect(r.status).toBe(200);
    expect(r.body.activation.status).toBe('cancelled');
    expect(r.body.activation.endsAtPeriodEnd).toBe(false);
    expect(await featureService.hasFeature(biz.id, 'forecast')).toBe(false);
  });
});
