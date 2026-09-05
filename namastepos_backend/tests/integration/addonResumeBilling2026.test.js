// Regression tests for review item A2 (2026-09-05): POST /addons/:slug/resume.
//
// addonService.resume() used to set `status='active', current_period_end =
// NOW() + 100 years` for ANY business_addons row. Buy a paid addon for one
// month → cancel → resume ⇒ a century of the feature for ₹0; it also brought
// back addons revokeIneligibleAddons had removed after a downgrade.
//
// Now: eligibility is re-checked (revoked stays revoked), a paid addon behind a
// gateway goes back through the purchase path (Razorpay order, nothing
// activated here), production without a gateway is a 503, a paid addon whose
// period has ended is 409 ADDON_EXPIRED_REBUY, and only a FREE addon — or a
// paid one still inside its original period in non-prod manual mode — reopens,
// never past the period it already had.

const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const rz = require('../../src/services/razorpayService');
const addonService = require('../../src/services/addonService');

let app;
let biz;
let paidAddon; // online-orders: paid, no plan requirement
let freeAddon; // inserted here: ₹0
let proAddon; // multi-outlet: paid, requires pro kind

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ name: 'Addon Resume Cafe', email: 'addon-resume@example.com' });
  const basic = (await query("SELECT id FROM plans WHERE tier = 'basic'")).rows[0].id;
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '1 month')`,
    [biz.id, basic],
  );
  await query(
    `INSERT INTO addons (slug, name, price_inr_paise, billing_period, is_active, display_order)
     VALUES ('test-free-tool', 'Free Tool', 0, 'monthly', TRUE, 999)
     ON CONFLICT (slug) DO NOTHING`,
  );
  paidAddon = (await query("SELECT * FROM addons WHERE slug = 'online-orders'")).rows[0];
  freeAddon = (await query("SELECT * FROM addons WHERE slug = 'test-free-tool'")).rows[0];
  proAddon = (await query("SELECT * FROM addons WHERE slug = 'multi-outlet'")).rows[0];
});
afterAll(async () => { await closePool(); });
afterEach(() => { jest.restoreAllMocks(); });

const auth = () => ({ Authorization: `Bearer ${tokenFor(biz)}` });
const rowFor = async (addonId) => (await query(
  'SELECT * FROM business_addons WHERE business_id = $1 AND addon_id = $2',
  [biz.id, addonId],
)).rows[0] || null;
const setRow = (addonId, { status, periodEnd, cancelAtPeriodEnd = false, cancelledAt = null }) => query(
  `INSERT INTO business_addons
     (business_id, addon_id, status, current_period_end, cancel_at_period_end, cancelled_at)
   VALUES ($1, $2, $3::addon_status, ${periodEnd}, $4, $5)
   ON CONFLICT (business_id, addon_id) DO UPDATE
     SET status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         cancelled_at = EXCLUDED.cancelled_at`,
  [biz.id, addonId, status, cancelAtPeriodEnd, cancelledAt],
);
const yearsOut = (d) => (new Date(d).getTime() - Date.now()) / (365 * 86400000);

// The developer's .env (dotenv-loaded by config/env) may carry rzp_test_ keys
// into the jest process, so BOTH modes are forced explicitly. Addon checkout
// is 'gateway' with ANY key outside prod (checkoutMode() default).
async function withEnv(patch, fn) {
  const keys = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'NODE_ENV'];
  const saved = Object.fromEntries(keys.map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try { return await fn(); } finally { Object.assign(env, saved); }
}
const inGatewayMode = (fn) => withEnv({ RAZORPAY_KEY_ID: 'rzp_test_addons', RAZORPAY_KEY_SECRET: 'addons-secret' }, fn);
const inManualMode = (fn) => withEnv({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' }, fn);

describe('A2: resuming a cancelled PAID addon', () => {
  it('behind a gateway returns a Razorpay order and activates NOTHING (the 100-year hole)', async () => {
    // Bought for a month, cancelled (cancel() ends the period immediately).
    await setRow(paidAddon.id, { status: 'cancelled', periodEnd: "NOW() - INTERVAL '1 minute'", cancelAtPeriodEnd: true, cancelledAt: new Date() });
    await inGatewayMode(async () => {
      const orderSpy = jest.spyOn(rz, 'createOneTimeOrder').mockResolvedValue({
        id: 'order_resume_paid', amount: paidAddon.price_inr_paise, currency: 'INR',
      });
      const r = await request(app)
        .post(`/v1/businesses/${biz.id}/addons/${paidAddon.slug}/resume`).set(auth());
      expect(r.status).toBe(200);
      // addonController ships a checkout payload top-level (same shape as
      // POST /addons/subscribe) and only wraps real activations in
      // { activation }.
      const body = r.body;
      expect(body.requiresPayment).toBe(true);
      expect(body.activated).toBe(false);
      expect(body.razorpayOrder.id).toBe('order_resume_paid');
      expect(orderSpy).toHaveBeenCalledTimes(1);
      expect(orderSpy.mock.calls[0][0].amountPaise).toBe(paidAddon.price_inr_paise);
    });
    const row = await rowFor(paidAddon.id);
    expect(row.status).toBe('cancelled'); // THE BUG THIS LOCKS DOWN: used to be 'active' + 100 years
    expect(new Date(row.current_period_end).getTime()).toBeLessThan(Date.now());
    expect(await addonService.hasAddon(biz.id, paidAddon.slug)).toBe(false);
  });

  it('whose period has ended, with no gateway (manual mode), is 409 ADDON_EXPIRED_REBUY', async () => {
    await setRow(paidAddon.id, { status: 'cancelled', periodEnd: "NOW() - INTERVAL '1 minute'", cancelAtPeriodEnd: true, cancelledAt: new Date() });
    const r = await inManualMode(() => request(app)
      .post(`/v1/businesses/${biz.id}/addons/${paidAddon.slug}/resume`).set(auth()));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ADDON_EXPIRED_REBUY');
    expect((await rowFor(paidAddon.id)).status).toBe('cancelled');
  });

  it('still inside its original period (manual mode) reopens but is NEVER extended', async () => {
    await setRow(paidAddon.id, { status: 'active', periodEnd: "NOW() + INTERVAL '12 days'", cancelAtPeriodEnd: true, cancelledAt: new Date() });
    const before = await rowFor(paidAddon.id);
    const r = await inManualMode(() => request(app)
      .post(`/v1/businesses/${biz.id}/addons/${paidAddon.slug}/resume`).set(auth()));
    expect(r.status).toBe(200);
    const row = await rowFor(paidAddon.id);
    expect(row.status).toBe('active');
    expect(row.cancel_at_period_end).toBe(false);
    expect(row.cancelled_at).toBeNull();
    expect(new Date(row.current_period_end).getTime()).toBe(new Date(before.current_period_end).getTime());
    expect(yearsOut(row.current_period_end)).toBeLessThan(1);
  });

  it('is idempotent on a row that is already live', async () => {
    const before = await rowFor(paidAddon.id);
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/addons/${paidAddon.slug}/resume`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.activation.status).toBe('active');
    expect(new Date((await rowFor(paidAddon.id)).current_period_end).getTime())
      .toBe(new Date(before.current_period_end).getTime());
  });

  it('in production without a live gateway is 503, never free', async () => {
    await setRow(paidAddon.id, { status: 'cancelled', periodEnd: "NOW() - INTERVAL '1 minute'", cancelAtPeriodEnd: true, cancelledAt: new Date() });
    // Production + a TEST key (not rzp_live_) is exactly the misconfiguration
    // that must never hand the addon out for free.
    const r = await withEnv({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'x' }, () => request(app)
      .post(`/v1/businesses/${biz.id}/addons/${paidAddon.slug}/resume`).set(auth()));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('PAYMENTS_UNAVAILABLE');
    expect((await rowFor(paidAddon.id)).status).toBe('cancelled');
  });
});

describe('A2: revoked-by-downgrade addons stay revoked', () => {
  it('refuses to resume an addon the current plan cannot hold (403, names the plan needed)', async () => {
    // multi-outlet requires the 'pro' tier KIND. A Starter-kind tenant (the
    // free plan) is the unambiguous "downgraded below it" case.
    const starter = await makeBusiness({ name: 'Starter Stall', email: 'addon-starter@example.com' });
    const free = (await query("SELECT id FROM plans WHERE tier = 'free'")).rows[0].id;
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '1 month')`,
      [starter.id, free],
    );
    // What revokeIneligibleAddons leaves behind for a paid row: cancel flag,
    // cancelled_at, status still active until the paid period ends.
    await query(
      `INSERT INTO business_addons
         (business_id, addon_id, status, current_period_end, cancel_at_period_end, cancelled_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '9 days', TRUE, NOW())`,
      [starter.id, proAddon.id],
    );
    const r = await request(app)
      .post(`/v1/businesses/${starter.id}/addons/${proAddon.slug}/resume`)
      .set({ Authorization: `Bearer ${tokenFor(starter)}` });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/plan or higher/i);
    const row = (await query(
      'SELECT * FROM business_addons WHERE business_id = $1 AND addon_id = $2',
      [starter.id, proAddon.id],
    )).rows[0];
    expect(row.cancel_at_period_end).toBe(true); // untouched
    expect(yearsOut(row.current_period_end)).toBeLessThan(1);
  });
});

describe('A2: a FREE addon may be reopened', () => {
  it('cancel → resume brings a ₹0 addon back with the free far-future window', async () => {
    await addonService.subscribe(biz.id, freeAddon.slug);
    await request(app).post(`/v1/businesses/${biz.id}/addons/${freeAddon.slug}/cancel`).set(auth());
    expect((await rowFor(freeAddon.id)).status).toBe('cancelled');
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/addons/${freeAddon.slug}/resume`).set(auth());
    expect(r.status).toBe(200);
    const row = await rowFor(freeAddon.id);
    expect(row.status).toBe('active');
    expect(row.cancel_at_period_end).toBe(false);
    expect(yearsOut(row.current_period_end)).toBeGreaterThan(50); // nothing to bill, nothing to honour
    expect(await addonService.hasAddon(biz.id, freeAddon.slug)).toBe(true);
  });

  it('resume of an addon never subscribed is 404', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/addons/custom-branding/resume`).set(auth());
    expect(r.status).toBe(404);
  });
});
