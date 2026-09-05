// NamastePOS backend - billing endpoints (subscriptions + Razorpay)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const sub = require('../services/subscriptionService');
const razorpay = require('../services/razorpayService');
const features = require('../services/featureService');
const subInvoice = require('../services/subscriptionInvoiceService');
const churn = require('../services/churnService');
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
  plans: asyncHandler(async (req, res) => {
    // 2026-09-03 custom plans: this route is public (no auth middleware), but
    // when the caller DOES send a valid tenant Bearer token we include that
    // tenant's own custom plan alongside the public catalog so their
    // BillingPage shows the plan they're on. Anonymous callers and other
    // tenants never see it. Best-effort decode — a bad/absent token just
    // yields the public list.
    let forBusinessId = null;
    try {
      const header = req.headers.authorization || '';
      if (header.startsWith('Bearer ')) {
        const { verifyAccessToken } = require('../utils/jwt');
        const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
        if (payload && !payload.isSuperAdmin && payload.bid) forBusinessId = payload.bid;
      }
    } catch (_) { /* anonymous — public list only */ }
    const all = await sub.listPlans({ forBusinessId });
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

  // Current business subscription.
  //
  // 2026-09-04 — this is the route the tenant dashboard (ffApi.subscription)
  // and the mobile app already call on every launch, so the owner-facing
  // usage meter and the past-due grace notice ride along on it rather than
  // needing a new endpoint or new polling. Both are nested INSIDE
  // `subscription` on purpose: every existing client reads
  // `response.data.subscription` and would not see a new sibling key.
  //
  // `usage` — remaining/limit/level per capped metric, so the dashboard can
  //   warn at 80% and at 100% instead of letting the owner discover the cap
  //   as a 403 mid-service. Best-effort: a failure here must never break the
  //   billing read (or the mobile launch check that depends on it).
  // `grace`  — when a charge has failed and we are inside
  //   PAST_DUE_GRACE_DAYS: the amount, the exact date access ends, and a
  //   plain-language line. Null at every other time.
  // `overage` — 2026-09-04 (decision 5): `monthly_orders` is now a SOFT
  //   limit, so a tenant CAN be past their included volume with nothing
  //   blocked. This is the recorded overage for the current period (included
  //   volume, bills taken, how many were over, when it started). Null when
  //   they are inside their plan, which is the normal case.
  current: asyncHandler(async (req, res) => {
    const businessId = req.params.businessId;
    const subscription = await sub.get(businessId);
    if (!subscription) return res.json({ subscription });
    let usage = null;
    try {
      usage = await sub.usageSummary(businessId);
    } catch (e) {
      require('../config/logger').warn(`[billing] usageSummary failed for ${businessId}: ${e.message}`);
    }
    let grace = null;
    // 2026-09-05 (churn batch) — `pause` rides on the same read for the same
    // reason `grace` and `usage` do: every client already fetches this on
    // launch, so the paused banner needs no new endpoint and no new polling.
    // Null whenever the account is not paused, which is the normal case.
    let pause = null;
    // 2026-09-05 (A6) — an admin suspension has its OWN block, never the
    // friendly pause banner: the tenant cannot resume it from Billing.
    let suspension = null;
    try {
      const entitlement = require('../services/planEntitlement');
      const r = await query(
        `SELECT s.status, s.trial_ends_at, s.past_due_at, s.last_dunning_at,
                s.paused_at, s.pause_ends_at, s.pause_months, s.dunning_step,
                s.suspended_at,
                p.price_inr_paise, p.price_yearly_paise, s.billing_period
           FROM subscriptions s
           LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.business_id = $1 LIMIT 1`,
        [businessId],
      );
      const row = r.rows[0];
      if (row && row.status === 'paused') {
        pause = {
          paused: true,
          pausedAt: row.paused_at,
          pauseEndsAt: row.pause_ends_at,
          pauseMonths: row.pause_months,
          message: 'This account is paused. Nothing is deleted and you can read '
            + 'everything you have billed. New bills resume when you do.',
        };
      }
      if (row && row.status === 'suspended') {
        suspension = {
          suspended: true,
          suspendedAt: row.suspended_at || null,
          message: 'Account suspended — contact support.',
        };
      }
      if (row) {
        const paise = row.billing_period === 'yearly'
          ? (row.price_yearly_paise || row.price_inr_paise || 0)
          : (row.price_inr_paise || 0);
        grace = entitlement.graceNotice(row, { amountInr: paise ? paise / 100 : null });
      }
    } catch (e) {
      require('../config/logger').warn(`[billing] grace notice failed for ${businessId}: ${e.message}`);
    }
    let overage = null;
    try {
      overage = await sub.overageFor(businessId, 'monthly_orders');
    } catch (e) {
      require('../config/logger').warn(`[billing] overage read failed for ${businessId}: ${e.message}`);
    }
    res.json({
      subscription: {
        ...subscription, usage, grace, overage, pause, suspension,
      },
    });
  }),

  // Change plan (initiates Razorpay flow for paid plans, immediate for free)
  changePlan: [
    validate({ body: changeBody }),
    asyncHandler(async (req, res) => {
      const { tier, billingPeriod } = req.body;
      // A9 (2026-09-05): free vs paid is decided on the plan's PRICE, not on
      // the literal tier code 'free' (a second ₹0 plan would otherwise have
      // been sent to Razorpay checkout and 400'd on a missing plan id).
      const target = await sub.getPlanByTier(tier); // 404 for unknown tiers
      // A6: a suspended tenant cannot buy their way out of a suspension.
      const cur = await query(
        'SELECT status, suspended_at FROM subscriptions WHERE business_id = $1 LIMIT 1',
        [req.params.businessId],
      );
      sub.assertNotSuspended(cur.rows[0]);
      if (sub.isFreePlan(target)) {
        // A3: when a paid period is running on a gateway mandate the service
        // SCHEDULES the downgrade for period end (subscription.pendingPlan +
        // scheduled/effectiveAt/message) instead of flipping the plan now.
        const subscription = await sub.changePlan(req.params.businessId, tier);
        return res.json({ subscription });
      }
      // Fix (2026-08-24): plan changes used to ALWAYS go through Razorpay, so
      // with no/test payment keys every paid upgrade threw "Razorpay is not
      // configured" — blocking beta testing entirely. When Razorpay isn't
      // configured, fall back to an immediate manual plan change (mirrors how
      // addons activate for free in this phase). When real keys ARE set, we
      // still route through Razorpay so production collects payment.
      //
      // 2026-09-05: the gateway/manual/unavailable decision now lives in ONE
      // place — razorpayService.checkoutMode() — shared with the resume paths,
      // with exactly the semantics this controller had:
      //   'gateway'     LIVE key + webhook secret (requireLive: a test key
      //                 cannot complete charge→webhook→activate);
      //   'manual'      non-production otherwise → instant activation, no charge;
      //   'unavailable' production without a live key → 503, never free.
      const mode = razorpay.checkoutMode({ requireLive: true });
      if (mode === 'unavailable') throw razorpay.paymentsUnavailableError();
      if (mode === 'manual') {
        const subscription = await sub.changePlan(req.params.businessId, tier, { billingPeriod: billingPeriod || 'monthly' });
        return res.json({
          subscription,
          manual: true,
          message: 'Plan activated (payments not configured — no charge collected). [non-production]',
        });
      }
      // FF-402c — pass the cadence through so Razorpay picks the right
      // plan_id (razorpay_plan_id vs razorpay_plan_id_yearly) and
      // subscriptions.billing_period is persisted correctly.
      const checkout = await razorpay.createSubscription(req.params.businessId, tier, { billingPeriod: billingPeriod || 'monthly' });
      res.json(checkout);
    }),
  ],

  // ── Cancel flow (2026-09-05, churn batch) ──────────────────────────────
  //
  // Cancelling used to be one button that flipped a boolean. It is now three
  // explicit steps — reasons → survey+offer → confirm — and each is its own
  // call so a client can abandon the flow at any point without side effects.
  // `POST /cancel` still works exactly as it did for any client that has not
  // been updated (the survey is optional), which is why the mobile app keeps
  // working while it catches up.

  // The five reasons the picker renders. Static; no tenant data.
  cancelReasons: asyncHandler(async (req, res) => {
    res.json({ reasons: churn.reasons() });
  }),

  // Step 1: record the reason, get the offer that reason produces. Does NOT
  // cancel anything.
  cancelSurvey: [
    validate({
      body: Joi.object({
        reason: Joi.string().valid(...Object.keys(churn.CANCEL_REASONS)).required(),
        note: Joi.string().allow('', null).max(4000),
      }),
    }),
    asyncHandler(async (req, res) => {
      const out = await churn.startCancel(req.params.businessId, {
        reason: req.body.reason,
        note: req.body.note,
        userId: req.user?.id || req.user?.sub || null,
      });
      res.json(out);
    }),
  ],

  // Step 2: confirm. Closes the open survey against a REAL cancel, then runs
  // the unchanged cancel-at-period-end path.
  cancel: asyncHandler(async (req, res) => {
    const out = await churn.confirmCancel(req.params.businessId, {
      userId: req.user?.id || req.user?.sub || null,
    });
    res.json({
      success: true,
      message: 'Will cancel at end of period',
      periodEnd: out.periodEnd,
      survey: out.survey,
    });
  }),

  // Resume: un-pause (restoring the same plan) or un-cancel. One button for
  // the owner; churnService decides which of the two it is from the row.
  //
  // 2026-09-05 (A1/A4): for a PAID plan with a gateway configured the reply is
  // `{ requiresCheckout: true, checkout: {...createSubscription payload} }` and
  // NOTHING has changed yet — the client opens Razorpay Checkout with
  // `checkout.checkoutOptions` and the row flips when the first charge lands.
  // `resumed: true` means the change is already in effect. A `trialing` /
  // `past_due` / `cancelled` row is 409 RESUME_NOT_ALLOWED (choose a plan
  // instead); `suspended` is 403 ACCOUNT_SUSPENDED.
  resume: asyncHandler(async (req, res) => {
    const out = await churn.resume(req.params.businessId, {
      userId: req.user?.id || req.user?.sub || null,
    });
    res.json({ success: true, ...out });
  }),

  // Pause 1-3 months. Stops billing, keeps data, restores the same plan.
  pause: [
    validate({
      body: Joi.object({
        months: Joi.number().valid(...churn.PAUSE_MONTHS).default(1),
        reason: Joi.string().valid(...Object.keys(churn.CANCEL_REASONS)).allow(null),
      }),
    }),
    asyncHandler(async (req, res) => {
      const userId = req.user?.id || req.user?.sub || null;
      const out = await churn.pause(req.params.businessId, {
        months: req.body.months,
        reason: req.body.reason || null,
        userId,
      });
      // Only record a SAVE when the pause actually came out of the cancel flow
      // (an open survey exists). A pause started from the Billing page on a
      // quiet Tuesday is not a save and must not inflate the save rate.
      if (!out.alreadyPaused) {
        await churn.acceptOffer(req.params.businessId, {
          action: 'pause',
          reason: req.body.reason || null,
          userId,
          meta: { months: req.body.months },
        }).catch(() => {});
      }
      res.json({ success: true, ...out });
    }),
  ],

  // The owner's own data, on the way out. Owner-gated, NOT plan-gated —
  // see the note in churnService.exportAccount.
  exportAccount: asyncHandler(async (req, res) => {
    const businessId = req.params.businessId;
    const data = await churn.exportAccount(businessId, {
      userId: req.user?.id || req.user?.sub || null,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="namastepos-export-${stamp}.json"`,
    );
    res.send(JSON.stringify(data, null, 2));
  }),

  invoices: asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT * FROM invoices WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.params.businessId],
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

  // GST-compliant subscription invoice PDF — generated on demand and scoped
  // to the owner's own business so one tenant can't pull another's invoice.
  invoicePdf: asyncHandler(async (req, res) => {
    await subInvoice.renderPdf(res, {
      invoiceId: req.params.invoiceId,
      businessId: req.params.businessId,
    });
  }),

  // Razorpay webhook (no auth — signature verified)
  webhook: asyncHandler(async (req, res) => {
    const ok = razorpay.verifyWebhookSignature(req);
    if (!ok) return res.status(400).json({ error: 'INVALID_SIGNATURE' });
    // P1 (Arvind #8): the webhook handler now returns its response body
    // (including replays of already-processed events) so downstream proxies
    // and Razorpay's retry mechanism see a stable result.
    // NP-109: Razorpay sends the event id in this header, not the body —
    // it is the dedup key for retry-safe processing.
    const result = await razorpay.handleWebhook(req.body, req.headers['x-razorpay-event-id']);
    // NP-110 follow-up: concurrent duplicate whose winner is still in flight →
    // 409 so Razorpay retries (a 2xx would end retries while the winner may fail).
    if (result && result.pending === true) return res.status(409).json(result);
    res.json(result || { received: true });
  }),
};
