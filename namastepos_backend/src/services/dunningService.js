// NamastePOS backend — dunning (failed-payment recovery), 4-touch ladder.
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT CHANGED (2026-09-05, retention audit finding "Dunning has retries but
// no voice")
// ══════════════════════════════════════════════════════════════════════════
// This service used to send ONE email template, re-sent on every Razorpay
// `payment.failed` webhook — so a tenant whose bank retried three times got
// the same paragraph three times, and a tenant whose bank retried once got a
// single message and then silence until the grace window closed underneath
// them. The written ladder (`content/emails/dunning-ladder.md`) is four
// escalating touches across the 7-day grace plus a recovery message, WhatsApp
// first, and this file now implements exactly that.
//
// THE STEP COUNTER IS THE WHOLE TRICK
// `dunning_attempts` (migration 065) counts GATEWAY failures. It cannot say
// which owner-facing touch has gone out, which is why the old code could not
// escalate. `subscriptions.dunning_step` (migration 091) is a separate
// monotonic 0..4 counter over the four touches, and it is ONLY ever advanced
// by a conditional UPDATE:
//
//     UPDATE subscriptions SET dunning_step = $n WHERE id = $1 AND dunning_step < $n
//
// If that UPDATE returns no row, somebody else already sent this touch and we
// send nothing. That single line is what makes "fires in order, never repeats"
// hold under a cron tick racing a webhook racing a second instance. There is no
// lock and no queue; the database decides.
//
// CHANNEL: WHATSAPP FIRST, EMAIL FALLBACK
// The ICP lives on WhatsApp. Meta Cloud API is wired (whatsappService), but a
// business-initiated WhatsApp message outside the 24-hour service window MUST
// use a template that Meta has APPROVED, and template names are account-level
// facts we cannot invent from code. So each touch reads its template name from
// env (META_WA_DUN_1_TEMPLATE …, see config/env.js) exactly the way the OTP
// path reads META_WA_OTP_TEMPLATE. Unset name, unconfigured Meta, or a send
// that comes back without a message id ⇒ we DEGRADE TO EMAIL rather than fail.
// A dunning touch that throws would take the Razorpay webhook down with it.
//
// NOTHING HERE MAY THROW. Every send is best-effort; the caller is a webhook or
// a cron tick and both must survive a dead mail server.

const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const email = require('./emailService');
const entitlement = require('./planEntitlement');

const BILLING_URL = 'https://app.namastepos.in/billing';

// ── The ladder ───────────────────────────────────────────────────────────
//
// `at` is the fraction of the grace window at which the touch is due, so the
// schedule follows PAST_DUE_GRACE_DAYS instead of hardcoding a 7-day calendar.
// At the default 7 days that resolves to day 0, 2, 4 and 6 — the schedule in
// `content/emails/dunning-ladder.md` §3, with touch 4 landing on the morning of
// the last day rather than at the instant the grace expires.
//
// `templateEnv` is the env var holding the APPROVED Meta template name. Blank
// (the default, and the state of the account today) ⇒ email.
const LADDER = [
  {
    step: 1,
    at: 0,
    key: 'failed',
    templateEnv: 'META_WA_DUN_1_TEMPLATE',
    subject: (o) => `${o.amount} didn't go through. Nothing has stopped.`,
  },
  {
    step: 2,
    at: 2 / 7,
    key: 'pending',
    templateEnv: 'META_WA_DUN_2_TEMPLATE',
    subject: (o) => `Still pending: ${o.amount} for ${o.planName}`,
  },
  {
    step: 3,
    at: 4 / 7,
    key: 'midpoint',
    templateEnv: 'META_WA_DUN_3_TEMPLATE',
    subject: (o) => `What changes on ${o.graceDate}, in numbers`,
  },
  {
    step: 4,
    at: 6 / 7,
    key: 'last_day',
    templateEnv: 'META_WA_DUN_4_TEMPLATE',
    subject: (o) => `Last day: ${o.amount} due by ${o.graceDate}`,
  },
];

const RECOVERY = {
  step: 0,
  key: 'recovered',
  templateEnv: 'META_WA_DUN_RECOVERED_TEMPLATE',
  subject: (o) => `Payment received. ${o.outlet} is settled.`,
};

/** Highest ladder step whose due-day has passed for a grace window this old. */
function stepDueAfterDays(daysElapsed) {
  const grace = entitlement.graceDays();
  if (!(grace > 0)) return LADDER[LADDER.length - 1].step;
  let due = 0;
  for (const t of LADDER) {
    if (daysElapsed + 1e-9 >= t.at * grace) due = t.step;
  }
  return due;
}

function _inr(paise) {
  if (!paise || paise <= 0) return null;
  return `₹${Number(paise / 100).toLocaleString('en-IN')}`;
}

function _date(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

// Resolve subscription + owner contact from a Razorpay subscription id.
async function _lookupByRazorpayId(razorpaySubId) {
  const r = await query(
    `SELECT s.id AS sub_id, s.business_id, s.dunning_attempts, s.dunning_step,
            s.past_due_at, s.last_dunning_at, s.billing_period,
            s.current_period_end,
            b.name AS business_name, b.email AS business_email, b.phone AS business_phone,
            p.name AS plan_name, p.price_inr_paise, p.price_yearly_paise
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.razorpay_subscription_id = $1
      LIMIT 1`,
    [razorpaySubId],
  );
  return r.rows[0] || null;
}

async function _lookupBySubId(subId) {
  const r = await query(
    `SELECT s.id AS sub_id, s.business_id, s.dunning_attempts, s.dunning_step,
            s.past_due_at, s.last_dunning_at, s.billing_period,
            s.current_period_end,
            b.name AS business_name, b.email AS business_email, b.phone AS business_phone,
            p.name AS plan_name, p.price_inr_paise, p.price_yearly_paise
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.id = $1
      LIMIT 1`,
    [subId],
  );
  return r.rows[0] || null;
}

/** The five owner-facing values every touch interpolates. */
function _vars(info) {
  const paise = info.billing_period === 'yearly'
    ? (info.price_yearly_paise || info.price_inr_paise || 0)
    : (info.price_inr_paise || 0);
  const graceEnds = entitlement.graceEndsAt(info);
  return {
    firstName: info.business_name || 'there',
    outlet: info.business_name || 'your restaurant',
    amount: _inr(paise) || 'your subscription payment',
    planName: info.plan_name || 'your plan',
    graceDate: _date(graceEnds) || 'the end of your grace window',
    nextDebit: _date(info.current_period_end) || 'your next billing date',
    link: BILLING_URL,
    paise,
  };
}

// ── Copy ────────────────────────────────────────────────────────────────
//
// The one line every touch carries, in the words of the copy doc: nothing has
// stopped, and the DATE it would. Never a duration — "7 days" makes the owner
// do arithmetic they get wrong. The date comes from the subscription row via
// planEntitlement.graceEndsAt, so if the grace was extended for any reason the
// message reflects the real date rather than a computed guess.
function _graceLine(v, step) {
  return step >= 4
    ? `Nothing has stopped yet. ${v.outlet} keeps everything it has until ${v.graceDate}.`
    : `Nothing has stopped. ${v.outlet} keeps everything it has until ${v.graceDate}.`;
}

function _bodyFor(step, v) {
  const grace = _graceLine(v, step);
  if (step === 1) {
    return `${v.firstName}, the ${v.amount} payment for ${v.planName} did not go through.

${grace} Billing, KOT, GST invoices, loyalty, reports — all running exactly as they were.

It is usually one of three things: UPI Autopay limit reached, low balance on the debit date, or the bank timed out for a minute. All three fix in one tap.

Pay by UPI, card or netbanking: ${v.link}

The bank will also retry on its own. If it clears either way, ignore this.`;
  }
  if (step === 2) {
    return `${v.firstName}, the ${v.amount} for ${v.planName} is still pending. The bank tried again and declined again.

${grace}

This link takes UPI directly and does not need the mandate: ${v.link}

Two minutes. If it keeps failing at the bank's end, reply here and we will sort it with you rather than send another reminder.`;
  }
  if (step === 3) {
    return `${v.firstName}, ${v.amount} for ${v.planName} is still open.

${grace}

What changes on ${v.graceDate} if it is still unpaid: the account moves to Starter, free. Billing, KOT, QR ordering and offline all keep working. GST tax invoices, loyalty, WhatsApp receipts and the dashboard switch off. Nothing is deleted, and ${v.planName} comes back in full the moment payment clears.

Bills are never refused, on any plan. You will not be stuck at the counter.

Pay: ${v.link}`;
  }
  return `${v.firstName}, last day. ${v.amount} for ${v.planName} is due by ${v.graceDate}.

${grace} After that the account moves to Starter.

Billing, KOT, QR ordering and offline keep working on Starter. GST tax invoices, loyalty, WhatsApp receipts and the dashboard switch off. Nothing is deleted, and ${v.planName} switches back on within minutes of payment — today, next week or next month.

Pay: ${v.link}`;
}

function _recoveryBody(v) {
  return `${v.firstName}, payment received. ${v.amount} for ${v.planName} is settled and ${v.outlet} is fully back on ${v.planName}.

Nothing had stopped, so nothing needs switching back on. Your next debit is ${v.nextDebit}.

Your GST invoice for this payment is in the app under Billing, with your GSTIN on it.`;
}

function _html(text) {
  return text.split('\n\n')
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ── Delivery ────────────────────────────────────────────────────────────

/**
 * WhatsApp first, email second. Returns 'whatsapp' | 'email' | 'none'.
 *
 * NEVER THROWS. A dunning touch is not worth failing a webhook over, and a
 * WhatsApp template that Meta has not approved yet must degrade to email rather
 * than leave the owner with no message at all.
 */
async function _deliver(info, touch, v, text, subject) {
  const templateName = env[touch.templateEnv] || '';
  if (info.business_phone && templateName) {
    try {
      const whatsapp = require('./whatsappService');
      if (whatsapp.isMetaConfigured()) {
        // Variable order is fixed by the copy doc §3 and must match the
        // approved template exactly: name, outlet, amount, plan, date, link.
        const params = [
          v.firstName, v.outlet, v.amount, v.planName,
          touch.step === 0 ? v.nextDebit : v.graceDate,
          v.link,
        ].map((text2) => ({ type: 'text', text: String(text2) }));
        const id = await whatsapp.sendTemplate({
          to: info.business_phone,
          templateName,
          languageCode: env.META_WA_LANG,
          components: [{ type: 'body', parameters: params }],
        });
        if (id) return 'whatsapp';
        logger.info(`dunning: WA template ${templateName} not delivered — falling back to email`);
      }
    } catch (err) {
      logger.warn(`dunning: WhatsApp touch ${touch.step} failed (${err.message}) — falling back to email`);
    }
  }
  if (info.business_email) {
    try {
      await email.sendMail({
        template: `dunning_${touch.key}`,
        recipient: info.business_email,
        subject,
        text,
        html: _html(text),
        businessId: info.business_id,
      });
      return 'email';
    } catch (err) {
      logger.warn(`dunning: email touch ${touch.step} failed for ${info.business_id}: ${err.message}`);
    }
  }
  return 'none';
}

/**
 * Send ladder touch `step` for one subscription, if and only if it has not
 * been sent. Idempotent by construction (see the header): the conditional
 * UPDATE below is the claim, and losing it means somebody else sent it.
 *
 * Returns the channel used, or null when the step was already claimed / the
 * tenant is not on a paid plan.
 */
async function sendStep(info, step) {
  const touch = LADDER.find((t) => t.step === step);
  if (!touch || !info) return null;
  // Free/₹0 plans have nothing to dun. Guarding here rather than at the call
  // sites keeps the rule in one place.
  const v = _vars(info);
  if (!(v.paise > 0)) return null;

  // CLAIM. No row back ⇒ this touch already went out (another cron instance,
  // a webhook retry, or a duplicate Razorpay event). Send nothing.
  const claim = await query(
    `UPDATE subscriptions
        SET dunning_step = $2, dunning_step_at = NOW()
      WHERE id = $1 AND dunning_step < $2
      RETURNING id`,
    [info.sub_id, step],
  );
  if (claim.rowCount === 0) return null;

  const text = _bodyFor(step, v);
  const channel = await _deliver(info, touch, v, text, touch.subject(v));

  await query(
    `INSERT INTO dunning_events
       (business_id, subscription_id, event, attempt_no, step, channel, emailed)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [info.business_id, info.sub_id, `dunning_touch_${step}`,
      info.dunning_attempts || 0, step, channel, channel === 'email'],
  );
  logger.info(`dunning: touch ${step} for business ${info.business_id} via ${channel}`);
  return channel;
}

// ── Webhook entry points ────────────────────────────────────────────────

// A subscription charge failed (payment.failed or subscription.halted).
async function onPaymentFailed(razorpaySubId, { reason, halted = false } = {}) {
  if (!razorpaySubId) return;
  const info = await _lookupByRazorpayId(razorpaySubId);
  if (!info) { logger.info(`dunning: no subscription for ${razorpaySubId}`); return; }

  const attemptNo = (info.dunning_attempts || 0) + 1;
  // 2026-09-04 (retention audit F-02) — stamp the grace anchor on the FIRST
  // transition into past_due and never again. `COALESCE(past_due_at, NOW())`
  // is the whole trick: every dunning retry bumps `last_dunning_at`, so
  // anchoring the grace window there would silently renew it on each retry and
  // the window would never close. Features stay on for PAST_DUE_GRACE_DAYS
  // measured from this instant (planEntitlement.entitledSql), which is what
  // stops one failed card from turning a working restaurant into an outage
  // while the dunning messages are still in flight.
  const upd = await query(
    `UPDATE subscriptions
        SET status = 'past_due',
            dunning_attempts = $2,
            last_dunning_at = NOW(),
            past_due_at = COALESCE(past_due_at, NOW())
      WHERE id = $1
      RETURNING past_due_at`,
    [info.sub_id, attemptNo],
  );
  info.dunning_attempts = attemptNo;
  info.past_due_at = upd.rows[0]?.past_due_at || info.past_due_at;
  // Entitlement just changed shape (active → past_due-in-grace), so drop the
  // cached feature set for this tenant and tell peer nodes. The cached entry
  // is additionally capped at graceEndsAt by featureService, so even a node
  // that never hears this invalidation cannot serve "still in grace" past the
  // deadline.
  try { require('./featureService').clearCache(info.business_id); } catch (_) { /* non-fatal */ }

  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [info.business_id, info.sub_id, halted ? 'halted' : 'payment_failed', attemptNo, reason || null],
  );

  // Touch 1 is due immediately. Retries of the SAME debit re-enter here and
  // find dunning_step already at 1, so they send nothing — that repeated-email
  // behaviour is exactly what this batch removes. Touches 2-4 are the cron
  // ladder's job (ladderTick).
  await sendStep(info, 1).catch((e) => logger.warn(`dunning: touch 1 failed: ${e.message}`));
  logger.info(`dunning: past_due for business ${info.business_id} attempt ${attemptNo}`);
}

// A charge succeeded — clear dunning state and close the loop with the owner.
async function onRecovered(razorpaySubId) {
  if (!razorpaySubId) return;
  const info = await _lookupByRazorpayId(razorpaySubId);
  if (!info) return;
  // Nothing was running ⇒ nothing to clear and, crucially, no recovery message.
  // A "payment received" note to somebody who never saw a failure is noise.
  if ((info.dunning_attempts || 0) === 0 && (info.dunning_step || 0) === 0) return;

  // Clear past_due_at too (2026-09-04): if this account fails again later it
  // must get a FRESH grace window, not the tail of the one it already used.
  // dunning_step resets here and ONLY here, so the next failure starts the
  // ladder at touch 1 again. Conditional on the ladder still running, so two
  // `charged` webhooks for the same payment send one message, not two.
  const cleared = await query(
    `UPDATE subscriptions
        SET dunning_attempts = 0, last_dunning_at = NULL, past_due_at = NULL,
            dunning_step = 0, dunning_step_at = NULL
      WHERE id = $1 AND (dunning_attempts > 0 OR dunning_step > 0)
      RETURNING id`,
    [info.sub_id],
  );
  if (cleared.rowCount === 0) return; // another worker already recovered it
  try { require('./featureService').clearCache(info.business_id); } catch (_) { /* non-fatal */ }

  const v = _vars(info);
  let channel = 'none';
  if (v.paise > 0) {
    channel = await _deliver(
      info, RECOVERY, v, _recoveryBody(v), RECOVERY.subject(v),
    ).catch(() => 'none');
  }

  await query(
    `INSERT INTO dunning_events
       (business_id, subscription_id, event, attempt_no, step, channel, emailed)
     VALUES ($1, $2, 'recovered', 0, 0, $3, $4)`,
    [info.business_id, info.sub_id, channel, channel === 'email'],
  );
  logger.info(`dunning: recovered for business ${info.business_id} (told via ${channel})`);
}

// ── Cron ────────────────────────────────────────────────────────────────

/**
 * Advance the ladder for every past_due subscription whose next touch is due.
 *
 * Bounded by `idx_subscriptions_dunning_ladder` and by LIMIT; normally an empty
 * set. Each row is claimed independently by sendStep's conditional UPDATE, so
 * two instances running this tick at the same time still send each touch once.
 * Steps never skip: we advance ONE step per tick even when several are overdue
 * (an account that went past_due while the worker was down gets the touches in
 * order over the following ticks, not four messages in one minute).
 */
async function ladderTick({ limit = 100 } = {}) {
  const grace = entitlement.graceDays();
  if (!(grace > 0)) return { sent: 0 };
  const due = await query(
    `SELECT s.id AS sub_id, s.business_id, s.dunning_attempts, s.dunning_step,
            s.past_due_at, s.last_dunning_at, s.billing_period,
            s.current_period_end,
            b.name AS business_name, b.email AS business_email, b.phone AS business_phone,
            p.name AS plan_name, p.price_inr_paise, p.price_yearly_paise,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(s.past_due_at, s.last_dunning_at)))
              / 86400.0 AS days_elapsed
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'past_due'
        AND s.dunning_step < $1
        AND COALESCE(s.past_due_at, s.last_dunning_at) IS NOT NULL
        AND COALESCE(p.price_inr_paise, 0) > 0
      ORDER BY COALESCE(s.past_due_at, s.last_dunning_at)
      LIMIT $2`,
    [LADDER[LADDER.length - 1].step, limit],
  );
  let sent = 0;
  for (const row of due.rows) {
    const target = stepDueAfterDays(Number(row.days_elapsed) || 0);
    // One step per tick — never leapfrog the owner from touch 1 to touch 4.
    const next = Math.min((row.dunning_step || 0) + 1, target);
    if (next <= (row.dunning_step || 0)) continue;
    try {
      const channel = await sendStep(row, next);
      if (channel) sent += 1;
    } catch (e) {
      logger.warn(`dunning: ladder touch ${next} failed for ${row.business_id}: ${e.message}`);
    }
  }
  return { sent, scanned: due.rowCount };
}

module.exports = {
  onPaymentFailed,
  onRecovered,
  ladderTick,
  sendStep,
  stepDueAfterDays,
  LADDER,
  // Test seam: the ladder is normally driven by a Razorpay id, but the pause /
  // cancel tests and the cron path both need it by subscription id.
  _lookupBySubId,
};
