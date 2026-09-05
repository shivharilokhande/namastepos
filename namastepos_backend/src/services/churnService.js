// NamastePOS backend — churn prevention: exit survey, honest save offers,
// pause/resume, and the account export an owner can take on the way out.
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ══════════════════════════════════════════════════════════════════════════
// Cancelling used to be `POST /billing/cancel` → flip `cancel_at_period_end`.
// No reason captured, no alternative offered, and no way to read afterwards
// why anybody left (retention audit, finding "Cancel is silent", High). This
// service wraps that same cancel with the flow the audit asks for:
//
//     reason (5 + free text)  →  offer branched ON THE REASON  →  confirm
//
// THE BRANCHING IS THE POINT, AND IT IS HONEST ON PURPOSE
//   too_expensive   → a real cheaper path: downgrade to Starter (₹0), pause,
//                     or the yearly price when the plan has one.
//   not_using       → pause, and a founder setup call. Not a discount: money
//                     is not why they stopped.
//   missing_feature → NO OFFER. A note to the founder instead. Discounting
//                     something that does not do the job is an insult with a
//                     price tag on it.
//   switching       → NO OFFER. Ask what they moved to; that answer is worth
//                     more than a saved ₹299.
//   closing_down    → NO OFFER, and this is the one that matters most. A save
//                     offer shown to somebody whose restaurant has shut is
//                     insulting. They get a graceful goodbye and an export
//                     link, and nothing else.
//
// ══════════════════════════════════════════════════════════════════════════
// PAUSE SEMANTICS — the decision, and why
// ══════════════════════════════════════════════════════════════════════════
// A paused account is READ-ONLY on its own history: the owner can sign in,
// read every past bill, report, customer and menu item, and take an export.
// It CANNOT create an order, and it is not entitled to any paid feature.
//
// A paused account that could still bill would simply be a free account, and
// the seasonal outlet that "pauses" every monsoon would never pay again — the
// pause would become the pricing. Blocking new bills is the line that keeps
// pause an alternative to CANCELLING rather than an alternative to PAYING.
// Read access is kept because the whole retention argument (`winback.md` §1)
// is "your data is still there", and a pause that locks the owner out of their
// own GST records at filing time makes that a lie.
//
// Mechanics: `status = 'paused'` (already in the enum since migration 002) is
// not entitled under planEntitlement.classify, so features fall back to the
// free tier automatically — no parallel entitlement logic. The extra
// order-creation block is one middleware, `subscriptionService.blockIfPaused`.
//
// ══════════════════════════════════════════════════════════════════════════
// MONEY SAFETY
// ══════════════════════════════════════════════════════════════════════════
// This is live billing. Every state change here is:
//   • IDEMPOTENT — each write is a conditional UPDATE guarded on the state it
//     expects (`WHERE status = 'active'`, `WHERE status = 'paused'`). A repeat
//     call finds no row and returns the current state instead of acting twice.
//   • NON-REFUNDING — pause and cancel both stop the gateway mandate at CYCLE
//     END. The period already paid for runs out normally. Nothing here issues
//     a refund, so nothing here can double-refund.
//   • AUDITED — every transition writes a `subscription_lifecycle_events` row
//     with the actor, the from/to status and the reason.
// No paid plan is ever activated by this file; `resume` restores the plan the
// tenant was already on and parked in `pause_plan_id`, and cannot invent one.

const { query, withTransaction } = require('../config/db');
const logger = require('../config/logger');
const { BadRequest, Conflict, NotFound } = require('../utils/errors');

const BILLING_URL = 'https://app.namastepos.in/billing';

// ── The five reasons ────────────────────────────────────────────────────
//
// Ordered by expected frequency (retention audit §3). `offer` names the branch;
// there is deliberately no default that hands an offer to an unknown reason.
const CANCEL_REASONS = Object.freeze({
  too_expensive: {
    label: 'Too expensive right now',
    offer: 'downgrade_or_pause',
  },
  not_using: {
    label: 'Not using it enough / back to paper',
    offer: 'pause',
  },
  missing_feature: {
    label: 'Missing something I need',
    offer: 'founder_note',
    // A reason that is useless without the detail. The route requires it.
    requiresNote: true,
  },
  switching: {
    label: 'Switching to something else',
    offer: 'founder_note',
  },
  closing_down: {
    label: 'Closing or selling the restaurant',
    offer: 'goodbye',
  },
});

/** The picker the dashboard and the app render. Order is meaningful. */
function reasons() {
  return Object.entries(CANCEL_REASONS).map(([code, r]) => ({
    code,
    label: r.label,
    noteRequired: !!r.requiresNote,
  }));
}

const PAUSE_MONTHS = Object.freeze([1, 2, 3]);
/** One pause per rolling 12 months (retention audit §3). */
const PAUSE_COOLDOWN_MONTHS = 12;

// ── Audit trail ─────────────────────────────────────────────────────────

async function _logLifecycle(client, {
  businessId, subscriptionId = null, event, reason = null,
  fromStatus = null, toStatus = null, planTier = null,
  actorUserId = null, meta = {},
}) {
  const q = client ? client.query.bind(client) : query;
  try {
    await q(
      `INSERT INTO subscription_lifecycle_events
         (business_id, subscription_id, event, reason, from_status, to_status,
          plan_tier, actor_user_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [businessId, subscriptionId, event, reason, fromStatus, toStatus,
        planTier, actorUserId, JSON.stringify(meta || {})],
    );
  } catch (e) {
    // The trail must not be able to fail a billing state change, but a gap in
    // it is a real problem, so it is logged loudly rather than swallowed.
    logger.warn(`[churn] lifecycle log failed (${event}) for ${businessId}: ${e.message}`);
  }
}

async function _subFor(businessId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const r = await q(
    `SELECT s.*, p.tier AS plan_tier, p.name AS plan_name,
            p.price_inr_paise, p.price_yearly_paise
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1
      LIMIT 1`,
    [businessId],
  );
  return r.rows[0] || null;
}

// ── Save offers ─────────────────────────────────────────────────────────

/**
 * Build the offer for one reason. Pure — takes the reason and the current
 * subscription row, returns what the owner should see.
 *
 * `save: false` means we are deliberately NOT trying to save them. The
 * dashboard renders those branches without a "stay" button.
 */
function offerFor(reason, sub, { freeTier = 'free' } = {}) {
  const meta = CANCEL_REASONS[reason];
  if (!meta) throw new BadRequest('Unknown cancellation reason');
  const kind = meta.offer;
  const yearlyPaise = sub?.price_yearly_paise || 0;
  const onFreePlan = !(sub?.price_inr_paise > 0);

  if (kind === 'downgrade_or_pause') {
    const options = [];
    // Downgrade is only an option if they are actually on a paid plan.
    if (!onFreePlan) {
      options.push({
        action: 'downgrade',
        // A9 (2026-09-05): the ₹0 plan's code is looked up by PRICE by the
        // caller (subscriptionService.freePlanRow), not assumed to be 'free'.
        tier: freeTier,
        title: 'Move to Starter, free',
        detail: 'Billing, KOT, QR ordering and offline keep working, with no expiry. '
          + 'Nothing is deleted. Your paid plan switches back on whenever you want it.',
      });
    }
    options.push({
      action: 'pause',
      months: PAUSE_MONTHS,
      title: 'Pause for a month or three',
      detail: 'Billing stops. Your menu, bills, customers and reports stay exactly '
        + 'where they are and you can still read them. New bills pause too. '
        + 'The same plan comes back on the date you pick.',
    });
    if (yearlyPaise > 0) {
      options.push({
        action: 'annual',
        title: `Pay yearly: ₹${Number(yearlyPaise / 100).toLocaleString('en-IN')}`,
        detail: 'Roughly two months free versus the monthly price, and one debit a '
          + 'year instead of twelve.',
      });
    }
    return {
      kind,
      save: true,
      headline: 'A slow month is a reason to spend less, not a reason to leave.',
      options,
    };
  }

  if (kind === 'pause') {
    return {
      kind,
      save: true,
      headline: 'If it is the wrong month rather than the wrong product, pause it.',
      options: [
        {
          action: 'pause',
          months: PAUSE_MONTHS,
          title: 'Pause for a month or three',
          detail: 'Billing stops and nothing is deleted. You can still open the app '
            + 'and read your bills, reports and customer list while it is paused.',
        },
        {
          action: 'founder_call',
          title: '15 minutes with the founder',
          detail: 'We load your menu and train one staff member. No charge, and it is '
            + 'the fix for this reason far more often than a discount is.',
        },
      ],
    };
  }

  if (kind === 'founder_note') {
    // NO OFFER, on purpose. Discounting a product that is missing the thing
    // they came for is an insult with a price tag on it.
    return {
      kind,
      save: false,
      headline: 'No offer for this one — tell us what was missing instead.',
      detail: 'This goes to the founder, not to a queue. If it is a bug we fix it and '
        + 'tell you when it is done, whether or not you ever pay us again.',
      options: [],
    };
  }

  // closing_down — a graceful goodbye and nothing else.
  return {
    kind: 'goodbye',
    save: false,
    headline: 'Sorry to hear it. Genuinely.',
    detail: 'No offer and no pitch. Your data stays yours — take a copy below whenever '
      + 'you want one. If you open somewhere else, log in and it is all still there.',
    exportPath: '/billing/export',
    options: [],
  };
}

// ── 1. Start the cancel flow (survey + offer) ───────────────────────────

/**
 * Record the exit reason and return the offer it produces. This does NOT
 * cancel anything — cancelling is a second, explicit call.
 *
 * Idempotent: one OPEN survey per tenant (partial unique index from migration
 * 091). Re-opening the flow, or changing the reason, updates that row rather
 * than creating a second one, so the reason dataset is not polluted by owners
 * who opened the screen twice.
 */
async function startCancel(businessId, { reason, note = null, userId = null } = {}) {
  const meta = CANCEL_REASONS[reason];
  if (!meta) throw new BadRequest('Pick a reason so we know what to fix');
  const text = note ? String(note).slice(0, 4000).trim() : null;
  if (meta.requiresNote && !text) {
    throw new BadRequest('Tell us what was missing — that is the whole point of this one');
  }

  const sub = await _subFor(businessId);
  if (!sub) throw new NotFound('No subscription');
  let freeTier = 'free';
  try {
    const fp = await require('./subscriptionService').freePlanRow();
    if (fp?.tier) freeTier = fp.tier;
  } catch (_) { /* fall back to the historical code */ }
  const offer = offerFor(reason, sub, { freeTier });

  const r = await query(
    `INSERT INTO cancellation_surveys
       (business_id, subscription_id, reason, reason_note, offer_kind, plan_tier, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id) WHERE resolved_at IS NULL
     DO UPDATE SET reason = EXCLUDED.reason,
                   reason_note = COALESCE(EXCLUDED.reason_note, cancellation_surveys.reason_note),
                   offer_kind = EXCLUDED.offer_kind,
                   plan_tier = EXCLUDED.plan_tier,
                   offer_outcome = 'pending'
     RETURNING *`,
    [businessId, sub.id, reason, text, offer.kind, sub.plan_tier || null, userId],
  );
  const survey = r.rows[0];

  await _logLifecycle(null, {
    businessId,
    subscriptionId: sub.id,
    event: 'cancel_started',
    reason,
    fromStatus: sub.status,
    planTier: sub.plan_tier,
    actorUserId: userId,
    meta: { surveyId: survey.id, offerKind: offer.kind, saveOffered: offer.save },
  });
  if (offer.save) {
    await _logLifecycle(null, {
      businessId,
      subscriptionId: sub.id,
      event: 'save_offer_shown',
      reason,
      planTier: sub.plan_tier,
      actorUserId: userId,
      meta: { offerKind: offer.kind, options: offer.options.map((o) => o.action) },
    });
  }

  // A reason that needs a human gets one. Fire-and-forget: the founder's inbox
  // must never be able to fail an owner's cancel.
  if (offer.kind === 'founder_note' || offer.kind === 'goodbye') {
    try {
      require('./crmService').logActivity({
        businessId,
        kind: 'churn_reason',
        title: `Cancel reason: ${CANCEL_REASONS[reason].label}`,
        body: text || null,
        meta: { reason, surveyId: survey.id, offerKind: offer.kind },
        actorType: 'system',
      }).catch(() => {});
    } catch (_) { /* non-fatal */ }
  }

  return { survey: serializeSurvey(survey), offer };
}

function serializeSurvey(s) {
  return {
    id: s.id,
    reason: s.reason,
    reasonLabel: CANCEL_REASONS[s.reason]?.label || s.reason,
    note: s.reason_note,
    offerKind: s.offer_kind,
    outcome: s.offer_outcome,
    planTier: s.plan_tier,
    createdAt: s.created_at,
    resolvedAt: s.resolved_at,
  };
}

/** Close the open survey with an outcome. Returns the row, or null. */
async function _resolveOpenSurvey(businessId, outcome, client = null) {
  const q = client ? client.query.bind(client) : query;
  const r = await q(
    `UPDATE cancellation_surveys
        SET offer_outcome = $2, resolved_at = NOW()
      WHERE business_id = $1 AND resolved_at IS NULL
      RETURNING *`,
    [businessId, outcome],
  );
  return r.rows[0] || null;
}

/**
 * Confirm the cancellation. The survey (if one is open) is closed as
 * `cancelled` so the reason is retained against a real cancel rather than a
 * browsed offer, then the EXISTING cancel-at-period-end path runs unchanged —
 * this service does not reimplement cancelling, and in particular does not
 * touch the Razorpay mandate itself.
 */
async function confirmCancel(businessId, { userId = null } = {}) {
  const sub = await _subFor(businessId);
  if (!sub) throw new NotFound('No subscription');
  const survey = await _resolveOpenSurvey(businessId, 'cancelled');
  const row = await require('./subscriptionService').cancelAtPeriodEnd(businessId);
  await _logLifecycle(null, {
    businessId,
    subscriptionId: sub.id,
    event: 'cancelled',
    reason: survey?.reason || null,
    fromStatus: sub.status,
    toStatus: sub.status, // access continues to period end; status is unchanged
    planTier: sub.plan_tier,
    actorUserId: userId,
    meta: { surveyId: survey?.id || null, cancelAtPeriodEnd: true, periodEnd: row?.current_period_end },
  });
  return { survey: survey ? serializeSurvey(survey) : null, periodEnd: row?.current_period_end || null };
}

/** Owner took a save offer instead of cancelling. Records which one. */
async function acceptOffer(businessId, { action, reason = null, userId = null, meta = {} } = {}) {
  const outcome = action === 'pause' ? 'accepted_pause' : 'accepted_downgrade';
  const survey = await _resolveOpenSurvey(businessId, outcome);
  const sub = await _subFor(businessId);
  await _logLifecycle(null, {
    businessId,
    subscriptionId: sub?.id || null,
    event: 'save_offer_accepted',
    reason: survey?.reason || reason,
    planTier: sub?.plan_tier || null,
    actorUserId: userId,
    meta: { action, surveyId: survey?.id || null, ...meta },
  });
  return survey ? serializeSurvey(survey) : null;
}

// ── 2. Pause / resume ───────────────────────────────────────────────────

function _monthsOk(months) {
  const n = Number(months);
  if (!PAUSE_MONTHS.includes(n)) {
    throw new BadRequest(`Pause for ${PAUSE_MONTHS.join(', ')} months`);
  }
  return n;
}

/**
 * Pause a subscription for 1-3 months.
 *
 * IDEMPOTENT: the state change is `WHERE status = 'active'`. A second call
 * finds no row and returns the pause already in place instead of re-parking
 * the plan or re-cancelling the mandate.
 *
 * NO REFUND is issued and none is possible here: the gateway mandate is
 * stopped at CYCLE END, so the period already paid for simply runs out. That
 * is also why pause cannot be used to dodge a failed payment — a `past_due`
 * subscription is refused below.
 */
async function pause(businessId, { months = 1, userId = null, reason = null } = {}) {
  const n = _monthsOk(months);
  const before = await _subFor(businessId);
  if (!before) throw new NotFound('No subscription');
  // A6 (2026-09-05): a suspended tenant cannot re-label the suspension as a
  // pause (which would make it self-resumable).
  require('./subscriptionService').assertNotSuspended(before);
  if (before.status === 'paused') {
    // Already paused — say so, do nothing. Not an error: the owner tapping
    // twice on a slow connection must not produce two pauses.
    return { paused: true, alreadyPaused: true, ...serializePause(before) };
  }
  if (before.status !== 'active') {
    throw new Conflict(
      before.status === 'past_due'
        ? 'Settle the pending payment first, then you can pause.'
        : 'Only an active subscription can be paused.',
    );
  }
  if (!(before.price_inr_paise > 0)) {
    throw new Conflict('Starter is already free — there is nothing to pause.');
  }
  if (before.last_pause_at) {
    const monthsSince = (Date.now() - new Date(before.last_pause_at).getTime())
      / (30.44 * 86_400_000);
    if (monthsSince < PAUSE_COOLDOWN_MONTHS) {
      throw new Conflict(
        `Pause is once every ${PAUSE_COOLDOWN_MONTHS} months. Moving to Starter (free) `
        + 'is unlimited and keeps you billing.',
      );
    }
  }

  const updated = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE subscriptions
          SET status = 'paused',
              paused_at = NOW(),
              pause_ends_at = NOW() + make_interval(months => $2::int),
              pause_plan_id = plan_id,
              pause_billing_period = billing_period,
              pause_months = $2::int,
              last_pause_at = NOW(),
              cancel_at_period_end = FALSE,
              updated_at = NOW()
        WHERE business_id = $1 AND status = 'active'
        RETURNING *`,
      [businessId, n],
    );
    if (r.rowCount === 0) return null; // lost the race; caller re-reads
    await _logLifecycle(client, {
      businessId,
      subscriptionId: r.rows[0].id,
      event: 'paused',
      reason,
      fromStatus: 'active',
      toStatus: 'paused',
      planTier: before.plan_tier,
      actorUserId: userId,
      meta: { months: n, pauseEndsAt: r.rows[0].pause_ends_at, refunded: false },
    });
    return r.rows[0];
  });

  if (!updated) {
    const now = await _subFor(businessId);
    return { paused: now?.status === 'paused', alreadyPaused: true, ...serializePause(now) };
  }

  // Stop the gateway mandate at cycle end so no further debit is attempted.
  // Best-effort: if Razorpay is unreachable the local state is still paused and
  // the reactivation guard in razorpayService is the backstop.
  try {
    await require('./razorpayService').cancelSubscription(businessId, { atCycleEnd: true });
  } catch (e) {
    logger.warn(`[churn] gateway pause failed for ${businessId}: ${e.message}`);
  }
  // Entitlement changed (active → paused → free tier), so drop the cache.
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }

  return { paused: true, alreadyPaused: false, ...serializePause(updated) };
}

function serializePause(s) {
  if (!s) return { pausedAt: null, pauseEndsAt: null, pausePlanTier: null };
  return {
    status: s.status,
    pausedAt: s.paused_at || null,
    pauseEndsAt: s.pause_ends_at || null,
    pauseMonths: s.pause_months || null,
  };
}

/**
 * Resume a paused subscription onto THE SAME PLAN it was paused from.
 *
 * `pause_plan_id` is read back from the row; there is no lookup by tier and no
 * fallback to a catalog default, so this cannot promote a tenant onto a plan
 * they were not already paying for. `WHERE status = 'paused'` makes it
 * idempotent, and a non-paused subscription falls through to the ordinary
 * `subscriptionService.resume` (un-cancel) it always had.
 *
 * MONEY (2026-09-05, A4). Pause cancelled the Razorpay mandate at cycle end,
 * so there is nothing left at the gateway to bill the resumed plan. The old
 * body set `status = 'active'` with a fresh month anyway — which meant either
 * the gateway's later `subscription.cancelled` webhook knocked the resumed
 * customer back off their plan, or (webhook missed) a paid plan ran unbilled
 * forever. Now, when the parked plan is PAID and a gateway is configured, the
 * owner gets a Razorpay checkout (`requiresCheckout: true`) and the row STAYS
 * paused until `_onChargeSuccess` sees the first charge on that new
 * subscription — the same rule every other paid activation follows. Free
 * plans, and non-prod with no gateway (manual mode), restore immediately as
 * before. The nightly auto-resume cannot open a checkout for the owner, so in
 * gateway mode it sends the "your pause has ended" nudge instead and asks
 * again in a week.
 */
async function resume(businessId, { userId = null, auto = false } = {}) {
  const before = await _subFor(businessId);
  if (!before) throw new NotFound('No subscription');
  // A6: an admin suspension is not a pause and the tenant cannot lift it.
  require('./subscriptionService').assertNotSuspended(before);
  if (before.status !== 'paused') {
    // Not paused — this is the plain "undo cancel-at-period-end" path
    // (guarded: only active + cancel_at_period_end rows qualify, see A1).
    const row = await require('./subscriptionService').resume(businessId);
    return {
      resumed: !!row.resumed,
      wasPaused: false,
      status: row.status,
      requiresCheckout: !!row.requiresCheckout,
      ...(row.requiresCheckout ? { checkout: row.checkout, message: row.message } : {}),
    };
  }

  // Which plan comes back, and what it costs — read from the parked columns.
  const parked = await query(
    'SELECT id, tier, name, price_inr_paise FROM plans WHERE id = $1 LIMIT 1',
    [before.pause_plan_id || before.plan_id],
  );
  const parkedPlan = parked.rows[0] || null;
  const paid = Number(parkedPlan?.price_inr_paise) > 0;
  const rzp = require('./razorpayService');
  const mode = rzp.checkoutMode({ requireLive: true }); // plan-level rule
  if (paid && mode === 'unavailable') throw rzp.paymentsUnavailableError();
  if (paid && mode === 'gateway') {
    if (auto) {
      // The cron cannot authorise a mandate on the owner's behalf. Tell them,
      // once a week, and keep the pause in place until they act.
      await _nudgeResumeCheckout(businessId, before, parkedPlan);
      return { resumed: false, wasPaused: true, status: 'paused', requiresCheckout: true, nudged: true };
    }
    const checkout = await rzp.createSubscription(businessId, parkedPlan.tier, {
      billingPeriod: before.pause_billing_period || before.billing_period || 'monthly',
    });
    await _logLifecycle(null, {
      businessId,
      subscriptionId: before.id,
      event: 'resume_checkout_started',
      fromStatus: 'paused',
      toStatus: 'paused',
      planTier: parkedPlan.tier,
      actorUserId: userId,
      meta: { razorpaySubscriptionId: checkout.subscriptionId },
    });
    return {
      resumed: false,
      wasPaused: true,
      status: 'paused',
      requiresCheckout: true,
      planTier: parkedPlan.tier,
      checkout,
      message: `Set up the payment mandate to bring ${parkedPlan.name} back. Your account stays `
        + 'paused until the first payment goes through.',
    };
  }

  const restored = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE subscriptions
          SET status = 'active',
              plan_id = COALESCE(pause_plan_id, plan_id),
              billing_period = COALESCE(pause_billing_period, billing_period),
              current_period_start = NOW(),
              current_period_end = CASE
                WHEN COALESCE(pause_billing_period, billing_period) = 'yearly'
                  THEN NOW() + INTERVAL '1 year'
                ELSE NOW() + INTERVAL '1 month' END,
              paused_at = NULL,
              pause_ends_at = NULL,
              pause_plan_id = NULL,
              pause_billing_period = NULL,
              pause_months = NULL,
              updated_at = NOW()
        WHERE business_id = $1 AND status = 'paused'
        RETURNING *`,
      [businessId],
    );
    if (r.rowCount === 0) return null;
    const tier = await client.query('SELECT tier FROM plans WHERE id = $1', [r.rows[0].plan_id]);
    await _logLifecycle(client, {
      businessId,
      subscriptionId: r.rows[0].id,
      event: auto ? 'auto_resumed' : 'resumed',
      fromStatus: 'paused',
      toStatus: 'active',
      planTier: tier.rows[0]?.tier || null,
      actorUserId: userId,
      meta: { restoredPlanId: r.rows[0].plan_id, auto },
    });
    return { row: r.rows[0], tier: tier.rows[0]?.tier || null };
  });

  if (!restored) {
    const now = await _subFor(businessId);
    return { resumed: now?.status !== 'paused', wasPaused: true, status: now?.status || null };
  }
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return {
    resumed: true,
    wasPaused: true,
    status: 'active',
    planTier: restored.tier,
    currentPeriodEnd: restored.row.current_period_end,
  };
}

/**
 * Gateway mode, pause has run its course, nobody is at the keyboard: tell the
 * owner their pause has ended and that one tap in Billing brings the plan back,
 * then push `pause_ends_at` a week out so the sweep asks again rather than
 * every night. The row stays paused; nothing is activated.
 */
async function _nudgeResumeCheckout(businessId, sub, plan) {
  const upd = await query(
    `UPDATE subscriptions
        SET pause_ends_at = NOW() + INTERVAL '7 days', updated_at = NOW()
      WHERE business_id = $1 AND status = 'paused'
      RETURNING id`,
    [businessId],
  );
  if (upd.rowCount === 0) return;
  try {
    await require('./pushService').sendToBusinessOwners(businessId, {
      title: 'Your pause has ended',
      body: `${plan?.name || 'Your plan'} is ready to come back. Open Billing and tap Resume to `
        + 'set up the payment mandate again — nothing is charged until you do.',
      data: { kind: 'pause_ended_resume', path: '/billing' },
    });
  } catch (_) { /* push is best-effort */ }
  await _logLifecycle(null, {
    businessId,
    subscriptionId: sub.id,
    event: 'auto_resume_checkout_required',
    fromStatus: 'paused',
    toStatus: 'paused',
    planTier: plan?.tier || null,
    meta: { nextNudgeAt: 'NOW()+7d' },
  });
}

/**
 * Nightly sweep: auto-resume pauses that have run their course. The owner
 * picked an end date; honouring it without being asked is the whole promise.
 */
async function autoResumeDue({ limit = 200 } = {}) {
  const due = await query(
    `SELECT business_id FROM subscriptions
      WHERE status = 'paused' AND pause_ends_at IS NOT NULL AND pause_ends_at <= NOW()
      ORDER BY pause_ends_at
      LIMIT $1`,
    [limit],
  );
  let resumed = 0;
  for (const row of due.rows) {
    try {
      const r = await resume(row.business_id, { auto: true });
      if (r.resumed) resumed += 1;
    } catch (e) {
      logger.warn(`[churn] auto-resume failed for ${row.business_id}: ${e.message}`);
    }
  }
  return { resumed, due: due.rowCount };
}

// ── 3. Account export ───────────────────────────────────────────────────
//
// `/v1/me/export` (complianceService.exportUserData) already existed, but it is
// a DPDP PERSONAL-data dump: profile, consents, DSRs, grievances. It contains
// none of the things `winback.md` promises are still there — the menu the owner
// typed, the bills, the customer list, the day-end history. So the promise was
// not true in any way the owner could check.
//
// This is the operational counterpart: the tenant's OWN business data, owner-
// gated, and deliberately NOT plan-gated. An owner on the way out is by
// definition about to stop paying; making the export a paid feature would be
// holding their menu hostage, which is the one thing `winback.md` §5 says we
// will never do.
//
// Every query is scoped by `business_id = $1`, and `order_items` — the one
// table here without a business_id of its own — is joined through `orders` so
// it inherits the same scope. There is no path in this function that can read
// another tenant's row.
const EXPORT_TABLES = Object.freeze([
  'menu_items',
  'customers',
  'orders',
  'expenses',
  'invoices',
  'daily_closings',
  'tables',
]);

/** Rows per section. Generous, but bounded — an export must not OOM the box. */
const EXPORT_LIMIT = 20_000;

async function exportAccount(businessId, { userId = null } = {}) {
  if (!businessId) throw new BadRequest('businessId required');
  const out = {
    exportedAt: new Date().toISOString(),
    businessId,
    note: 'Your NamastePOS data. Nothing here is deleted when you cancel or pause — '
      + 'this is a copy you can keep.',
    sections: {},
    skipped: [],
  };

  const b = await query(
    `SELECT id, name, email, phone, city, category, gstin, fssai, created_at
       FROM businesses WHERE id = $1`,
    [businessId],
  ).catch(() => null);
  out.sections.business = b?.rows?.[0] || null;

  for (const table of EXPORT_TABLES) {
    try {
      // `table` comes only from the frozen whitelist above — never from input.
      const r = await query(
        `SELECT * FROM ${table} WHERE business_id = $1 LIMIT ${EXPORT_LIMIT}`,
        [businessId],
      );
      out.sections[table] = r.rows;
    } catch (e) {
      // A table this deployment does not have is recorded, not fatal — an
      // export that half-fails is worse than an export that says what is
      // missing.
      out.skipped.push({ table, reason: e.message });
    }
  }

  try {
    const oi = await query(
      `SELECT oi.* FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.business_id = $1
        LIMIT ${EXPORT_LIMIT}`,
      [businessId],
    );
    out.sections.order_items = oi.rows;
  } catch (e) {
    out.skipped.push({ table: 'order_items', reason: e.message });
  }

  out.counts = Object.fromEntries(
    Object.entries(out.sections)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => [k, v.length]),
  );

  await _logLifecycle(null, {
    businessId,
    event: 'export_taken',
    actorUserId: userId,
    meta: { counts: out.counts, skipped: out.skipped.map((s) => s.table) },
  });
  return out;
}

module.exports = {
  CANCEL_REASONS,
  PAUSE_MONTHS,
  PAUSE_COOLDOWN_MONTHS,
  reasons,
  offerFor,
  startCancel,
  confirmCancel,
  acceptOffer,
  pause,
  resume,
  autoResumeDue,
  exportAccount,
  serializeSurvey,
  BILLING_URL,
  // 2026-09-05 (A4): razorpayService writes the 'resumed'/'uncancelled' trail
  // row when the re-checkout charge lands, through this same helper.
  logLifecycle: _logLifecycle,
};
