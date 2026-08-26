// NamastePOS backend - billing endpoints (subscriptions + Razorpay)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const sub = require('../services/subscriptionService');
const razorpay = require('../services/razorpayService');
const features = require('../services/featureService');
const { query } = require('../config/db');

const changeBody = Joi.object({
  // Push 18a — plan tiers are arbitrary VARCHAR; the service rejects unknown
  // tiers with a 404 from `plans` lookup. Validation only guards the shape.
  tier: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).required(),
  // FF-402c — cadence is a sibling arg. Blank ⇒ backend defaults to
  // monthly. Ignored on `tier === 'free'`.
  billingPeriod: Joi.string().valid('monthly', 'yearly'),
});

module.exports = {
  // Public: list all plans (used by dashboard pricing page + mobile).
  // Push 14f — enrich each plan with the feature set from plan_features
  // matrix (keyed by tier_kind). This way the dashboard + mobile show the
  // exact same features the super-admin configured; no more hardcoded
  // marketing copy that drifts from the actual gating.
  plans: asyncHandler(async (_req, res) => {
    const all = await sub.listPlans();
    // Push 18b: features are stored per-plan keyed by `plan.tier`, with a
    // fallback to `tier_kind` defaults (starter/pro/enterprise) when a plan
    // has no overrides. Pass `p.tier` first so the admin-picker selections
    // win; the service will fall back to tier_kind on its own.
    const enriched = await Promise.all(all.map(async (p) => ({
      ...p,
      featureKeys: p.tier
        ? await features.listTierFeatures(p.tier, p.tierKind)
        : (p.tierKind ? await features.listTierFeatures(p.tierKind) : []),
    })));
    res.json({ plans: enriched });
  }),

  // Current business subscription
  current: asyncHandler(async (req, res) => {
    const subscription = await sub.get(req.params.businessId);
    res.json({ subscription });
  }),

  // Change plan (initiates Razorpay flow for paid plans, immediate for free)
  changePlan: [
    validate({ body: changeBody }),
    asyncHandler(async (req, res) => {
      const { tier, billingPeriod } = req.body;
      if (tier === 'free') {
        const subscription = await sub.changePlan(req.params.businessId, 'free');
        return res.json({ subscription });
      }
      // Fix (2026-08-24): plan changes used to ALWAYS go through Razorpay, so
      // with no/test payment keys every paid upgrade threw "Razorpay is not
      // configured" — blocking beta testing entirely. When Razorpay isn't
      // configured, fall back to an immediate manual plan change (mirrors how
      // addons activate for free in this phase). When real keys ARE set, we
      // still route through Razorpay so production collects payment.
      const env = require('../config/env');
      // Only route through Razorpay when configured with a LIVE key. Blank or
      // test keys (rzp_test_) — and, in this beta, a missing webhook secret —
      // can't complete the charge→webhook→activate loop, so we activate the
      // plan immediately (no charge) instead of throwing a Razorpay error.
      const razorpayReady = !!(env.RAZORPAY_KEY_ID
        && env.RAZORPAY_KEY_SECRET
        && env.RAZORPAY_KEY_ID.startsWith('rzp_live_')
        // A live charge is worthless without the webhook secret that
        // completes charge→webhook→activate, so require it too.
        && env.RAZORPAY_WEBHOOK_SECRET);
      if (!razorpayReady) {
        // SECURITY (2026-08-26): the free "manual activation" fallback is a
        // BETA-only convenience. In production a missing/mis-set/rotated key
        // must NEVER silently hand out a paid plan for free — fail loudly so
        // the misconfig is caught instead of leaking revenue. The fallback is
        // therefore gated to non-production environments only.
        if (env.isProd()) {
          const { HttpError } = require('../utils/errors');
          throw new HttpError(
            503,
            'Payments are temporarily unavailable. Please try again shortly.',
            'PAYMENTS_UNAVAILABLE'
          );
        }
        const subscription = await sub.changePlan(
          req.params.businessId, tier, { billingPeriod: billingPeriod || 'monthly' }
        );
        return res.json({
          subscription,
          manual: true,
          message: 'Plan activated (payments not configured — no charge collected). [non-production]',
        });
      }
      // FF-402c — pass the cadence through so Razorpay picks the right
      // plan_id (razorpay_plan_id vs razorpay_plan_id_yearly) and
      // subscriptions.billing_period is persisted correctly.
      const checkout = await razorpay.createSubscription(
        req.params.businessId, tier, { billingPeriod: billingPeriod || 'monthly' }
      );
      res.json(checkout);
    }),
  ],

  cancel: asyncHandler(async (req, res) => {
    await sub.cancelAtPeriodEnd(req.params.businessId);
    res.json({ success: true, message: 'Will cancel at end of period' });
  }),

  resume: asyncHandler(async (req, res) => {
    await sub.resume(req.params.businessId);
    res.json({ success: true });
  }),

  invoices: asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT * FROM invoices WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.params.businessId]
    );
    res.json({
      invoices: r.rows.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        amount: i.amount_paise / 100,
        currency: i.currency,
        periodStart: i.period_start,
        periodEnd: i.period_end,
        dueAt: i.due_at,
        paidAt: i.paid_at,
        pdfUrl: i.pdf_url,
        createdAt: i.created_at,
      })),
    });
  }),

  // Razorpay webhook (no auth — signature verified)
  webhook: asyncHandler(async (req, res) => {
    const ok = razorpay.verifyWebhookSignature(req);
    if (!ok) return res.status(400).json({ error: 'INVALID_SIGNATURE' });
    // P1 (Arvind #8): the webhook handler now returns its response body
    // (including replays of already-processed events) so downstream proxies
    // and Razorpay's retry mechanism see a stable result.
    const result = await razorpay.handleWebhook(req.body);
    res.json(result || { received: true });
  }),
};
