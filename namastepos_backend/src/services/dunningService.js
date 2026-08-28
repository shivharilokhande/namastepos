// NamastePOS backend — dunning (failed-payment recovery).
//
// When a Razorpay subscription charge fails, we (a) mark the subscription
// past_due, (b) increment an attempt counter, and (c) email the owner a
// recovery nudge with a link to fix their payment method. When a later
// charge succeeds, onRecovered() clears the dunning state. All email is
// best-effort — a mail failure must never fail the webhook.

const { query } = require('../config/db');
const logger = require('../config/logger');
const email = require('./emailService');

const BILLING_URL = 'https://app.namastepos.in/billing';

// Resolve the subscription + owner contact from a Razorpay subscription id.
async function _lookup(razorpaySubId) {
  const r = await query(
    `SELECT s.id AS sub_id, s.business_id, s.dunning_attempts,
            b.name AS business_name, b.email AS business_email,
            p.name AS plan_name, p.price_inr_paise
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.razorpay_subscription_id = $1
      LIMIT 1`,
    [razorpaySubId]
  );
  return r.rows[0] || null;
}

function _emailBody(name, businessName, planName, attemptNo) {
  const subject = attemptNo >= 3
    ? `Action needed: your NamastePOS subscription is at risk`
    : `We couldn't process your NamastePOS payment`;
  const plan = planName ? ` (${planName} plan)` : '';
  const text = `Hi ${name || businessName || 'there'},

We tried to charge your NamastePOS subscription${plan} for ${businessName || 'your restaurant'} but the payment didn't go through.

Please update your payment method to keep your billing, reports and features active:
${BILLING_URL}

If you've already fixed this, you can ignore this message — the next automatic retry will settle it.

— Team NamastePOS`;
  const html = `<p>Hi ${name || businessName || 'there'},</p>
<p>We tried to charge your NamastePOS subscription${plan} for <strong>${businessName || 'your restaurant'}</strong> but the payment didn't go through.</p>
<p>Please update your payment method to keep your billing, reports and features active:</p>
<p><a href="${BILLING_URL}" style="background:#0E7C4A;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Update payment method</a></p>
<p style="color:#5B6B63;font-size:13px">If you've already fixed this, you can ignore this message — the next automatic retry will settle it.</p>
<p>— Team NamastePOS</p>`;
  return { subject, html, text };
}

// A subscription charge failed (payment.failed or subscription.halted).
async function onPaymentFailed(razorpaySubId, { reason, halted = false } = {}) {
  if (!razorpaySubId) return;
  const info = await _lookup(razorpaySubId);
  if (!info) { logger.info(`dunning: no subscription for ${razorpaySubId}`); return; }

  const attemptNo = (info.dunning_attempts || 0) + 1;
  await query(
    `UPDATE subscriptions
        SET status = 'past_due', dunning_attempts = $2, last_dunning_at = NOW()
      WHERE id = $1`,
    [info.sub_id, attemptNo]
  );

  let emailed = false;
  // Only email if we have an owner address and this is a real paid plan.
  if (info.business_email && (info.price_inr_paise || 0) > 0) {
    try {
      const tpl = _emailBody(null, info.business_name, info.plan_name, attemptNo);
      await email.sendMail({
        template: 'dunning_payment_failed',
        recipient: info.business_email,
        subject: tpl.subject, html: tpl.html, text: tpl.text,
        businessId: info.business_id,
      });
      emailed = true;
    } catch (err) {
      logger.warn(`dunning: email failed for ${info.business_id}: ${err.message}`);
    }
  }

  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason, emailed)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [info.business_id, info.sub_id, halted ? 'halted' : 'payment_failed', attemptNo, reason || null, emailed]
  );
  logger.info(`dunning: past_due for business ${info.business_id} attempt ${attemptNo} (emailed=${emailed})`);
}

// A charge succeeded — clear dunning state.
async function onRecovered(razorpaySubId) {
  if (!razorpaySubId) return;
  const info = await _lookup(razorpaySubId);
  if (!info) return;
  if ((info.dunning_attempts || 0) === 0) return; // nothing to clear
  await query(
    `UPDATE subscriptions SET dunning_attempts = 0, last_dunning_at = NULL WHERE id = $1`,
    [info.sub_id]
  );
  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no)
     VALUES ($1, $2, 'recovered', 0)`,
    [info.business_id, info.sub_id]
  );
  logger.info(`dunning: recovered for business ${info.business_id}`);
}

module.exports = { onPaymentFailed, onRecovered };
