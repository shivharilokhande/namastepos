// NamastePOS backend — NP-121 revenue-integrity nightly checks (2026-09-03).
//
// Three cheap sanity sweeps over billing data; the founder gets ONE email,
// and only when something actually drifted:
//   1. Plan-price drift — an active gateway subscription whose latest PAID
//      invoice amount equals SOME plan's price (monthly or yearly) that is
//      NOT the subscription's current plan price. Classic symptom: a plan
//      change that never reached Razorpay (or vice versa), so the tenant is
//      being charged for a different tier than the one they hold.
//   2. Refunds stuck 'pending' older than 48 h — the inline gateway call
//      (NP-111), the reconciler, AND the refund webhooks all failed to
//      settle them. Real money in limbo.
//   3. webhook_events rows older than 1 h with NULL response_body — the
//      delivery won the dedup claim then died mid-flight; its event id is
//      burned, so Razorpay retries are replaying "pending" forever and the
//      side effects never ran.
//
// 2026-09-04 (NP-301/302/304) added four more, all "the order committed but a
// side effect did not" escalations. Their detection queries live beside their
// repair sweeps in orderDurabilityService and are re-exported below:
//   6. Orders with no kot_tickets row — billed food the kitchen may never have
//      seen. The cron repairs these; anything left after an hour is escalated.
//   7. Orders carrying `inventory_error` — stock / food-cost understated.
//   8. print_jobs dead-lettered after exhausting their retries — the KDS has
//      the ticket but no paper ever reached the station.
//   9. usage_counters.monthly_orders that still disagrees with COUNT(orders)
//      after the nightly reconciler ran (i.e. counter ABOVE reality, which the
//      reconciler deliberately refuses to lower).
//
// Scheduling lives in cronWorker (nightly 02:02 IST slot), gated on
// REVENUE_INTEGRITY_CRON=true (default OFF). Recipient comes from
// PLATFORM_ALERT_EMAIL — missing while the cron is enabled is a loud error
// at job start, per the no-silent-fallbacks house rule.
//
// The check functions are exported individually so tests can run them
// against seeded rows without touching the scheduler.

const env = require('../config/env');
const { query } = require('../config/db');
const logger = require('../config/logger');
const email = require('./emailService');

const LIST_LIMIT = 50; // keep the email + the queries bounded

/**
 * Check 1 — plan-price drift.
 * Flags active subscriptions (with a razorpay_subscription_id) whose latest
 * paid invoice amount matches a DIFFERENT plan's price (monthly or yearly —
 * yearly falls back to monthly × 10, the same derivation syncPlans uses)
 * while NOT matching their current plan's own prices.
 */
async function checkPlanPriceDrift() {
  const r = await query(
    `SELECT s.id            AS subscription_id,
            s.business_id,
            s.razorpay_subscription_id,
            p.tier           AS current_tier,
            p.price_inr_paise AS current_monthly_paise,
            COALESCE(p.price_yearly_paise, p.price_inr_paise * 10) AS current_yearly_paise,
            li.amount_paise  AS last_paid_paise,
            mp.tier          AS matched_tier
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN LATERAL (
            SELECT i.amount_paise
              FROM invoices i
             WHERE i.subscription_id = s.id AND i.status = 'paid'
             ORDER BY i.paid_at DESC NULLS LAST
             LIMIT 1
       ) li ON TRUE
       JOIN LATERAL (
            SELECT pp.tier
              FROM plans pp
             WHERE pp.id <> p.id
               AND (pp.price_inr_paise = li.amount_paise
                    OR COALESCE(pp.price_yearly_paise, pp.price_inr_paise * 10) = li.amount_paise)
             -- deterministic pick: exact monthly match first, then cheapest
             ORDER BY (pp.price_inr_paise = li.amount_paise) DESC, pp.price_inr_paise ASC
             LIMIT 1
       ) mp ON TRUE
      WHERE s.status = 'active'
        AND s.razorpay_subscription_id IS NOT NULL
        AND li.amount_paise <> p.price_inr_paise
        AND li.amount_paise <> COALESCE(p.price_yearly_paise, p.price_inr_paise * 10)
      LIMIT $1`,
    [LIST_LIMIT],
  );
  return r.rows;
}

/** Check 2 — refunds stuck 'pending' for more than 48 hours. */
async function checkStuckRefunds() {
  const r = await query(
    `SELECT id, business_id, order_id, payment_id, amount_paise,
            razorpay_refund_id, created_at
       FROM refunds
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '48 hours'
      ORDER BY created_at
      LIMIT $1`,
    [LIST_LIMIT],
  );
  return r.rows;
}

/** Check 3 — webhook deliveries that claimed the dedup row and died. */
async function checkDeadWebhookEvents() {
  const r = await query(
    `SELECT id, external_id, event_type, created_at
       FROM webhook_events
      WHERE response_body IS NULL
        AND created_at < NOW() - INTERVAL '1 hour'
      ORDER BY created_at
      LIMIT $1`,
    [LIST_LIMIT],
  );
  return r.rows;
}

/**
 * Check 4 — delivered food whose REVENUE was never recognised.
 * `fulfilment_state='delivered'` mirrors into POS `collected`, which is what
 * books the money and awards loyalty. If that mirror failed (pool blip, or a
 * human cancelling mid-flight) the order sits delivered-but-unbilled. The
 * cron retries these every tick; anything still stuck after an hour is a
 * human's problem and belongs in this email.
 */
async function checkUnbilledDeliveries() {
  const r = await query(
    `SELECT o.id, o.business_id, b.name AS business_name, o.order_no,
            o.total, o.status, o.delivered_at, o.pos_mirror_error
       FROM orders o
       JOIN businesses b ON b.id = o.business_id
      WHERE o.fulfilment_state = 'delivered'
        AND o.status NOT IN ('collected', 'cancelled')
        AND o.delivered_at < NOW() - INTERVAL '1 hour'
      ORDER BY o.delivered_at ASC
      LIMIT $1`,
    [LIST_LIMIT],
  );
  return r.rows;
}

/**
 * Check 5 — aggregator status callbacks that never reached the provider.
 * Dead-lettered (6 failed attempts) events mean we told the diner's app
 * nothing; aggregators grade us on exactly these SLAs.
 */
async function checkDeadOutboundCallbacks() {
  const r = await query(
    `SELECT e.id, e.business_id, b.name AS business_name, e.provider, e.event,
            e.attempts, e.last_error, e.created_at
       FROM aggregator_outbound_events e
       JOIN businesses b ON b.id = e.business_id
      WHERE e.status = 'failed'
        AND e.created_at > NOW() - INTERVAL '7 days'
      ORDER BY e.created_at DESC
      LIMIT $1`,
    [LIST_LIMIT],
  );
  return r.rows;
}

// ── NP-301/302/304 (2026-09-04) — order-path durability escalations ─────
// The sweeps in orderDurabilityService retry these every cron tick; what is
// still broken after that needs a human, which is what this email is for.
// Detection queries live next to their repairs (one source of truth) and are
// re-exported here so the email and the tests read the same rows.
const orderDurability = require('./orderDurabilityService');

/** Check 6 — billed food the kitchen may never have seen (no KOT rows). */
const checkOrdersMissingKot = (opts) => orderDurability.checkOrdersMissingKot(
  { limit: LIST_LIMIT, ...opts },
);

/** Check 7 — orders whose inventory effects are still unapplied. */
const checkStuckInventoryEffects = (opts) => orderDurability.checkStuckInventoryEffects(
  { limit: LIST_LIMIT, ...opts },
);

/** Check 8 — print jobs that exhausted their retries (no paper reached a station). */
const checkDeadPrintJobs = (opts) => orderDurability.checkDeadPrintJobs(
  { limit: LIST_LIMIT, ...opts },
);

/** Check 9 — monthly_orders quota counters that disagree with reality. */
const checkUsageDrift = (opts) => orderDurability.checkUsageDrift(
  { limit: LIST_LIMIT, ...opts },
);

function _inr(paise) {
  return `₹${(Number(paise || 0) / 100).toFixed(2)}`;
}

function _renderEmail({
  drift, stuckRefunds, deadEvents, unbilled, deadOutbound,
  missingKot, stuckInventory, deadPrints, usageDrift,
}) {
  const section = (title, rows, renderRow) => (rows.length === 0 ? '' : `
    <h3 style="margin:16px 0 4px">${title} (${rows.length}${rows.length === LIST_LIMIT ? '+' : ''})</h3>
    <ul style="margin:4px 0">${rows.map((row) => `<li>${renderRow(row)}</li>`).join('')}</ul>`);

  const html = `
    <p>Nightly revenue-integrity sweep found problems that need a human:</p>
    ${section('Plan-price drift (charged amount matches a different plan)', drift, (d) => `business <code>${d.business_id}</code> — on <b>${d.current_tier}</b> but last paid `
      + `${_inr(d.last_paid_paise)} (= <b>${d.matched_tier}</b> pricing), `
      + `rzp sub <code>${d.razorpay_subscription_id}</code>`)}
    ${section('Refunds stuck pending > 48h', stuckRefunds, (rf) => `refund <code>${rf.id}</code> — ${_inr(rf.amount_paise)}, business <code>${rf.business_id}</code>, `
      + `created ${new Date(rf.created_at).toISOString()}`)}
    ${section('Webhook events dead in-flight > 1h (claimed, never finished)', deadEvents, (ev) => `<code>${ev.external_id}</code> (${ev.event_type}) — received ${new Date(ev.created_at).toISOString()}`)}
    ${section('DELIVERED but never billed (revenue not recognised)', unbilled, (o) => `${o.business_name}: order #${o.order_no} ${_inr((Number(o.total) || 0) * 100)} still `
      + `<b>${o.status}</b>, delivered ${new Date(o.delivered_at).toISOString()}`
      + `${o.pos_mirror_error ? ` — ${o.pos_mirror_error}` : ''}`)}
    ${section('Aggregator callbacks dead-lettered (SLA risk)', deadOutbound, (e) => `${e.business_name}: ${e.provider} <b>${e.event}</b> failed ${e.attempts}× — ${e.last_error || 'unknown'}`)}
    ${section('BILLED but no kitchen ticket (food may never have been cooked)', missingKot, (o) => `${o.business_name}: order #${o.order_no} ${_inr((Number(o.total) || 0) * 100)} created `
      + `${new Date(o.created_at).toISOString()}${o.kot_error ? ` — repair error: ${o.kot_error}` : ''}`)}
    ${section('Inventory effects never applied (stock / food-cost understated)', stuckInventory, (o) => `${o.business_name}: order #${o.order_no} — ${o.inventory_error}`)}
    ${section('Print jobs dead-lettered (no paper reached the station)', deadPrints, (p) => `${p.business_name}: ${p.kind}${p.order_no ? ` for order #${p.order_no}` : ''} failed `
      + `${p.attempts}× — ${p.error_message || 'unknown'}`)}
    ${section('Usage counters out of step with actual orders (quota drift)', usageDrift, (u) => `${u.business_name}: monthly_orders counter <b>${u.counted}</b> vs actual `
      + `<b>${u.actual_count}</b> order(s)`)}
    <p>Lists are capped at ${LIST_LIMIT} rows each. Check the admin console for the full picture.</p>`;

  const text = [
    'Nightly revenue-integrity sweep found problems:',
    ...drift.map((d) => `[drift] business ${d.business_id}: on ${d.current_tier}, last paid ${_inr(d.last_paid_paise)} (= ${d.matched_tier} pricing), rzp ${d.razorpay_subscription_id}`),
    ...stuckRefunds.map((rf) => `[refund>48h] ${rf.id} ${_inr(rf.amount_paise)} business ${rf.business_id} created ${rf.created_at}`),
    ...deadEvents.map((ev) => `[webhook>1h] ${ev.external_id} (${ev.event_type}) received ${ev.created_at}`),
    ...unbilled.map((o) => `[unbilled-delivery] ${o.business_name} order #${o.order_no} still ${o.status} since ${o.delivered_at}`),
    ...deadOutbound.map((e) => `[callback-dead] ${e.business_name} ${e.provider}/${e.event} after ${e.attempts} attempts`),
    ...missingKot.map((o) => `[no-kot] ${o.business_name} order #${o.order_no} created ${o.created_at}${o.kot_error ? ` (${o.kot_error})` : ''}`),
    ...stuckInventory.map((o) => `[inventory-stuck] ${o.business_name} order #${o.order_no}: ${o.inventory_error}`),
    ...deadPrints.map((p) => `[print-dead] ${p.business_name} ${p.kind} order #${p.order_no || '-'} after ${p.attempts} attempts`),
    ...usageDrift.map((u) => `[usage-drift] ${u.business_name} counter ${u.counted} vs actual ${u.actual_count}`),
  ].join('\n');

  return { html, text };
}

/**
 * Nightly entry point (called from cronWorker inside the 02:02 IST slot,
 * only when env.REVENUE_INTEGRITY_CRON is true). Emails PLATFORM_ALERT_EMAIL
 * ONLY when at least one check found something.
 */
async function runDaily() {
  // Fail loudly: an enabled integrity cron with nowhere to send alerts is
  // worse than no cron — it would "check" and tell no one.
  if (!env.PLATFORM_ALERT_EMAIL) {
    throw new Error(
      'REVENUE_INTEGRITY_CRON is enabled but PLATFORM_ALERT_EMAIL is not set — refusing to run silently',
    );
  }

  const [drift, stuckRefunds, deadEvents, unbilled, deadOutbound,
    missingKot, stuckInventory, deadPrints, usageDrift] = [
    await checkPlanPriceDrift(),
    await checkStuckRefunds(),
    await checkDeadWebhookEvents(),
    await checkUnbilledDeliveries(),
    await checkDeadOutboundCallbacks(),
    // NP-301/302/304
    await checkOrdersMissingKot(),
    await checkStuckInventoryEffects(),
    await checkDeadPrintJobs(),
    await checkUsageDrift(),
  ];

  const total = drift.length + stuckRefunds.length + deadEvents.length
    + unbilled.length + deadOutbound.length
    + missingKot.length + stuckInventory.length + deadPrints.length + usageDrift.length;
  if (total === 0) {
    logger.info('[revenue-integrity] nightly sweep clean — no email sent');
    return {
      clean: true,
      drift: 0,
      stuckRefunds: 0,
      deadEvents: 0,
      unbilled: 0,
      deadOutbound: 0,
      missingKot: 0,
      stuckInventory: 0,
      deadPrints: 0,
      usageDrift: 0,
    };
  }

  const { html, text } = _renderEmail({
    drift,
    stuckRefunds,
    deadEvents,
    unbilled,
    deadOutbound,
    missingKot,
    stuckInventory,
    deadPrints,
    usageDrift,
  });
  await email.sendMail({
    template: 'revenue_integrity_alert',
    recipient: env.PLATFORM_ALERT_EMAIL,
    subject: `[NamastePOS] Revenue integrity: ${total} issue${total === 1 ? '' : 's'} `
      + `(${drift.length} drift / ${stuckRefunds.length} stuck refunds / ${deadEvents.length} dead webhooks`
      + ` / ${unbilled.length} unbilled deliveries / ${deadOutbound.length} dead callbacks`
      + ` / ${missingKot.length} orders with no KOT / ${stuckInventory.length} inventory stuck`
      + ` / ${deadPrints.length} dead prints / ${usageDrift.length} usage drift)`,
    html,
    text,
  });
  logger.warn(
    `[revenue-integrity] drift=${drift.length} stuckRefunds=${stuckRefunds.length} `
    + `deadEvents=${deadEvents.length} missingKot=${missingKot.length} `
    + `stuckInventory=${stuckInventory.length} deadPrints=${deadPrints.length} `
    + `usageDrift=${usageDrift.length} — alert emailed`,
  );
  return {
    clean: false,
    drift: drift.length,
    stuckRefunds: stuckRefunds.length,
    deadEvents: deadEvents.length,
    missingKot: missingKot.length,
    stuckInventory: stuckInventory.length,
    deadPrints: deadPrints.length,
    usageDrift: usageDrift.length,
  };
}

module.exports = {
  runDaily,
  // Exported for unit tests (NP-121): each check runs standalone against
  // seeded rows, no scheduler involved.
  checkPlanPriceDrift,
  checkStuckRefunds,
  checkDeadWebhookEvents,
  checkUnbilledDeliveries,
  checkDeadOutboundCallbacks,
  // NP-301/302/304 order-path durability escalations.
  checkOrdersMissingKot,
  checkStuckInventoryEffects,
  checkDeadPrintJobs,
  checkUsageDrift,
};
