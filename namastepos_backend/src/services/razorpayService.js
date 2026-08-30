// NamastePOS backend - Razorpay subscriptions integration
//
// Razorpay's "Subscriptions" product handles auto-recurring billing in
// India via UPI mandates, e-mandates, and card tokenization.
//
// Flow:
//   1. (One-time) Admin creates Razorpay Plans and stores their plan_ids
//      in our `plans.razorpay_plan_id` column.
//   2. Owner clicks "Upgrade to Basic" in the dashboard.
//   3. Backend POST /subscriptions → Razorpay returns a subscription_id.
//   4. Backend returns { subscriptionId, key } to the dashboard.
//   5. Dashboard opens Razorpay Checkout (JS widget) → user pays.
//   6. Razorpay POSTs `subscription.charged` etc. to /v1/webhooks/razorpay.
//   7. Webhook handler updates our `subscriptions.status` and creates invoice/payment rows.

const crypto = require('crypto');
const https = require('https');
const env = require('../config/env');
const logger = require('../config/logger');
const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

// ── Lazy HTTP client (Razorpay's official Node SDK would be cleaner;
//    we use raw HTTPS so this file has zero extra deps for the demo) ─────

function rzCall(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      return reject(new BadRequest('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'));
    }
    const data = body ? JSON.stringify(body) : null;
    const auth = Buffer
      .from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)
      .toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com',
      path,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const json = chunks ? JSON.parse(chunks) : {};
          if (res.statusCode >= 300) {
            // FF-402d — never leak Razorpay's 401 back to our clients as
            // a 401. Our auth interceptor treats 401 as "your session
            // expired" and forces a re-login — but here the failure is
            // upstream (bad/missing RZ key), not with the user's JWT.
            // Remap to 502 so the browser shows a proper "billing
            // provider unavailable" toast instead of silently logging
            // the owner out mid-checkout.
            const upstreamAuthFail = res.statusCode === 401 || res.statusCode === 403;
            const httpStatus = upstreamAuthFail ? 502 : res.statusCode;
            const msg = upstreamAuthFail
              ? 'Payment provider (Razorpay) rejected our request — check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET on the server.'
              : (json.error?.description || 'Razorpay error');
            return reject(Object.assign(new Error(msg), {
              code: httpStatus,
              statusCode: httpStatus,
              body: json,
            }));
          }
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Plans (called once at setup) ─────────────────────────────────────────

/**
 * Push our internal plans to Razorpay (or update existing). Stores the
 * razorpay_plan_id back in our DB so we can reference it later.
 */
async function syncPlans() {
  // FF-313 — sync BOTH monthly and yearly plans. Yearly is priced at
  // 10× monthly (2 months free) which is the go-to lever for annual
  // conversion in Indian SaaS. Plans table has `price_yearly_paise`
  // if set; otherwise we derive it from monthly × 10.
  //
  // Price-change fix (2026-08-25): Razorpay Plans are IMMUTABLE — their
  // amount can never be edited. The old sync only created plans when the
  // id column was NULL, so an admin price change silently kept charging
  // the OLD amount at checkout while the dashboard displayed the new one.
  // Sync is now amount-aware: it fetches the linked Razorpay plan,
  // compares amounts, and creates a REPLACEMENT plan on any mismatch.
  // Existing subscriptions keep their old plan; only new checkouts use
  // the replacement.
  const r = await query(`SELECT * FROM plans WHERE tier <> 'free' AND price_inr_paise > 0`);

  /** Ensure one cadence (monthly|yearly) of one plan row matches Razorpay. */
  async function ensureCadence(p, { column, period, label, wantPaise }) {
    const currentId = p[column];
    if (currentId) {
      try {
        const remote = await rzCall('GET', `/v1/plans/${currentId}`);
        if (remote?.item?.amount === wantPaise) return; // in sync — nothing to do
        logger.info(`Plan ${p.tier} ${period}: Razorpay has ₹${remote?.item?.amount / 100}, `
          + `DB wants ₹${wantPaise / 100} — creating replacement (plans are immutable)`);
      } catch (err) {
        logger.warn(`Plan ${p.tier} ${period}: could not fetch ${currentId} `
          + `(${err.message}) — creating replacement`);
      }
    }
    const created = await rzCall('POST', '/v1/plans', {
      period, interval: 1,
      item: { name: label, amount: wantPaise,
              currency: 'INR', description: `${p.name}, ${period}` },
    });
    // Defensive: Razorpay must echo back the amount we asked for. If it
    // ever doesn't, refuse to link the plan rather than mischarge.
    if (created?.item?.amount !== wantPaise) {
      throw new Error(`Razorpay returned amount ${created?.item?.amount}, expected ${wantPaise}`);
    }
    await query(`UPDATE plans SET ${column} = $1 WHERE id = $2`, [created.id, p.id]);
    logger.info(`Synced ${period} plan ${p.tier} → ${created.id} (₹${wantPaise / 100})`);
  }

  for (const p of r.rows) {
    try {
      await ensureCadence(p, {
        column: 'razorpay_plan_id', period: 'monthly',
        label: `NamastePOS ${p.name}`, wantPaise: p.price_inr_paise,
      });
    } catch (err) {
      logger.warn(`Razorpay monthly sync failed for ${p.tier}: ${err.message}`);
    }
    try {
      const yearlyPaise = p.price_yearly_paise
        || Math.round(p.price_inr_paise * 10);   // default: 10× = 2 months free
      await ensureCadence(p, {
        column: 'razorpay_plan_id_yearly', period: 'yearly',
        label: `NamastePOS ${p.name} (yearly)`, wantPaise: yearlyPaise,
      });
    } catch (err) {
      logger.warn(`Razorpay yearly sync failed for ${p.tier}: ${err.message}`);
    }
  }
}

// ── Create subscription for a business ───────────────────────────────────

async function createSubscription(businessId, tier, { billingPeriod = 'monthly' } = {}) {
  const plan = (await query(`SELECT * FROM plans WHERE tier = $1`, [tier])).rows[0];
  if (!plan) throw new NotFound('Plan not found');
  // FF-402c — pick the right Razorpay plan id + price for the cadence.
  // If yearly was requested but the plan doesn't have a yearly Razorpay
  // id synced, fall back to monthly rather than blow up mid-checkout.
  const useYearly = billingPeriod === 'yearly' && !!plan.razorpay_plan_id_yearly;
  const razorpayPlanId = useYearly ? plan.razorpay_plan_id_yearly : plan.razorpay_plan_id;
  if (!razorpayPlanId) {
    throw new BadRequest('Razorpay plan not synced. Run /v1/admin/razorpay/sync first.');
  }
  const totalCount = useYearly ? 10 : 120;   // 10 years cap either cadence

  // Reuse existing razorpay_customer_id if present
  const sub = (await query(
    `SELECT * FROM subscriptions WHERE business_id = $1`, [businessId]
  )).rows[0];

  const created = await rzCall('POST', '/v1/subscriptions', {
    plan_id: razorpayPlanId,
    customer_notify: 1,
    total_count: totalCount,
    notes: { businessId, billingPeriod: useYearly ? 'yearly' : 'monthly' },
  });

  // P0 fix (2026-08-30): cancel the PREVIOUS Razorpay subscription before we
  // repoint the business at the new one. Without this, a plan/cadence change
  // (or a re-checkout) left the old gateway subscription authorised and still
  // charging the customer's mandate — double billing — and its future
  // `subscription.charged` webhooks hit "unknown subscription" and were
  // dropped. Best-effort: a gateway failure here must not block the upgrade
  // the customer just paid for; the old sub is also caught by the
  // reactivation guard in _onChargeSuccess.
  if (sub?.razorpay_subscription_id && sub.razorpay_subscription_id !== created.id) {
    try {
      await rzCall('POST', `/v1/subscriptions/${sub.razorpay_subscription_id}/cancel`,
        { cancel_at_cycle_end: 0 });
    } catch (e) {
      logger.warn(`Could not cancel prior Razorpay subscription ${sub.razorpay_subscription_id}: ${e.message}`);
    }
  }

  // Persist the cadence up-front so subsequent UI reads reflect it
  // even before the webhook fires.
  await query(
    `UPDATE subscriptions SET billing_period = $1 WHERE business_id = $2`,
    [useYearly ? 'yearly' : 'monthly', businessId]
  );

  // SECURITY FIX (Push 13.1): the previous version flipped plan_id and
  // status here, BEFORE the customer paid. That meant tapping "Upgrade to
  // Pro" granted Pro features even if they dismissed the Razorpay modal or
  // their card was declined. Now we only persist the Razorpay subscription
  // pointer — actual plan_id + status flips live in _onChargeSuccess,
  // which fires on the verified `subscription.charged` webhook.
  await query(
    `UPDATE subscriptions
        SET razorpay_subscription_id = $1
      WHERE business_id = $2`,
    [created.id, businessId]
  );

  const chargedPaise = useYearly
    ? (plan.price_yearly_paise || plan.price_inr_paise * 10)
    : plan.price_inr_paise;
  return {
    subscriptionId: created.id,
    razorpayKeyId: env.RAZORPAY_KEY_ID,
    plan: {
      tier: plan.tier,
      name: plan.name,
      priceInrPaise: chargedPaise,
      billingPeriod: useYearly ? 'yearly' : 'monthly',
    },
    checkoutOptions: {
      key: env.RAZORPAY_KEY_ID,
      subscription_id: created.id,
      name: 'NamastePOS',
      description: `${plan.name} plan, ${useYearly ? 'yearly' : 'monthly'}`,
      theme: { color: '#FF6B35' },
    },
  };
}

// ── Webhook signature verification ───────────────────────────────────────

function verifyWebhookSignature(req) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    logger.warn('Razorpay webhook hit but RAZORPAY_WEBHOOK_SECRET is not set');
    return false;
  }
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || typeof signature !== 'string') return false;

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  // P0-11 fix: crypto.timingSafeEqual throws if the buffers have different
  // lengths. A malformed/short signature header used to surface as a 500
  // instead of the correct 400 INVALID_SIGNATURE. We now length-check first
  // (constant-time comparison only matters when lengths match anyway).
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  try {
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    return false;
  }
}

// ── Webhook handler ──────────────────────────────────────────────────────

async function handleWebhook(payload) {
  const eventId = payload.id || `evt-${Date.now()}`;
  const event = payload.event;
  const isAddon = payload.payload?.subscription?.entity?.notes?.kind === 'addon';

  // P1 (Arvind #8) — Idempotency: skip if we've already processed this
  // event. Return the stored response_body so re-fires get a stable echo
  // (the side-effects already happened on the first delivery).
  // Hardening (2026-08-30): addon events now run through this SAME dedup gate
  // (they used to be handled before it), so a future non-idempotent addon
  // handler can't double-apply on Razorpay's routine delivery retries.
  const dup = await query(
    `SELECT response_body FROM webhook_events WHERE external_id = $1`, [eventId]
  );
  if (dup.rowCount > 0) {
    logger.info(`Razorpay event ${eventId} already processed; replaying response`);
    return dup.rows[0].response_body || { received: true, replayed: true };
  }
  await query(
    `INSERT INTO webhook_events (provider, external_id, event_type, payload)
     VALUES ('razorpay', $1, $2, $3) ON CONFLICT (external_id) DO NOTHING`,
    [eventId, event, payload]
  );

  try {
    if (isAddon) {
      const addons = require('./addonService');
      await addons.handleRazorpayEvent(event, payload.payload);
      const responseBody = { received: true, event, eventId, addon: true };
      await query(
        `UPDATE webhook_events SET processed_at = NOW(), response_body = $1 WHERE external_id = $2`,
        [responseBody, eventId]
      );
      return responseBody;
    }
    switch (event) {
      case 'subscription.charged': {
        const sub = payload.payload.subscription.entity;
        const pay = payload.payload.payment.entity;
        await _onChargeSuccess(sub, pay);
        // N1 dunning: a successful charge clears any past-due state.
        await require('./dunningService').onRecovered(sub.id);
        break;
      }
      case 'subscription.activated': {
        const sub = payload.payload.subscription.entity;
        await query(
          `UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = $1`,
          [sub.id]
        );
        await require('./dunningService').onRecovered(sub.id);
        break;
      }
      case 'subscription.completed':
      case 'subscription.cancelled': {
        const sub = payload.payload.subscription.entity;
        await query(
          `UPDATE subscriptions
              SET status = 'cancelled', cancelled_at = NOW()
            WHERE razorpay_subscription_id = $1`,
          [sub.id]
        );
        break;
      }
      case 'subscription.paused': {
        // A deliberate pause (owner/admin action) — not a payment failure.
        const sub = payload.payload.subscription.entity;
        await query(
          `UPDATE subscriptions SET status = 'paused' WHERE razorpay_subscription_id = $1`,
          [sub.id]
        );
        break;
      }
      case 'subscription.halted': {
        // Razorpay halts a subscription after it exhausts charge retries —
        // this is a terminal dunning state, not a deliberate pause. Mark it
        // past_due and send a final recovery nudge.
        const sub = payload.payload.subscription.entity;
        await require('./dunningService').onPaymentFailed(sub.id, { halted: true });
        break;
      }
      case 'payment.failed': {
        const pay = payload.payload.payment.entity;
        await query(
          `INSERT INTO payments (business_id, amount_paise, currency, method,
                                 razorpay_payment_id, status, failure_reason, raw_payload)
           SELECT s.business_id, $1, 'INR', $2, $3, 'failed', $4, $5
             FROM subscriptions s
            WHERE s.razorpay_subscription_id = $6
           ON CONFLICT (razorpay_payment_id) DO NOTHING`,
          [pay.amount, pay.method, pay.id,
           pay.error_description || pay.error_reason, pay,
           pay.subscription_id]
        );
        // N1 dunning: mark past_due + email the owner a recovery nudge.
        if (pay.subscription_id) {
          await require('./dunningService').onPaymentFailed(pay.subscription_id, {
            reason: pay.error_description || pay.error_reason,
          });
        }
        break;
      }
      default:
        logger.info(`Unhandled Razorpay event: ${event}`);
    }
    const responseBody = { received: true, event, eventId };
    await query(
      `UPDATE webhook_events
          SET processed_at = NOW(), response_body = $1
        WHERE external_id = $2`,
      [responseBody, eventId]
    );
    return responseBody;
  } catch (err) {
    // P1 fix (2026-08-30): the dedup row was written BEFORE processing, so a
    // mid-handler failure left the event marked "seen" — Razorpay's automatic
    // retry then matched the dedup gate and replayed an empty response WITHOUT
    // re-running the side-effects, permanently losing the charge. Delete the
    // dedup row on failure so the retry genuinely reprocesses. (We log to the
    // app logger for observability since the row itself is going away.)
    logger.error(`Razorpay webhook ${eventId} (${event}) failed, clearing dedup for retry: ${err.message}`);
    await query(
      `DELETE FROM webhook_events WHERE external_id = $1`,
      [eventId]
    ).catch((e) => logger.error(`Failed to clear webhook dedup ${eventId}: ${e.message}`));
    throw err;
  }
}

// ── Cancel a business's Razorpay subscription at the gateway ──────────────
// Stops the recurring mandate from charging. `atCycleEnd` keeps service until
// the paid period ends (the owner-facing "cancel at period end"); false
// cancels immediately. Best-effort by design — callers update local state
// regardless so a gateway hiccup never traps an owner in a paid plan.
async function cancelSubscription(businessId, { atCycleEnd = true } = {}) {
  const row = (await query(
    `SELECT razorpay_subscription_id FROM subscriptions WHERE business_id = $1`,
    [businessId]
  )).rows[0];
  const rzId = row?.razorpay_subscription_id;
  if (!rzId) return { cancelled: false, reason: 'no_gateway_subscription' };
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return { cancelled: false, reason: 'razorpay_not_configured' };
  }
  await rzCall('POST', `/v1/subscriptions/${rzId}/cancel`,
    { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  return { cancelled: true, razorpaySubscriptionId: rzId };
}

async function _onChargeSuccess(sub, pay) {
  // Find our subscription row
  const r = await query(
    `SELECT * FROM subscriptions WHERE razorpay_subscription_id = $1 LIMIT 1`,
    [sub.id]
  );
  if (r.rowCount === 0) {
    logger.warn(`Charge for unknown subscription ${sub.id}`);
    return;
  }
  const sr = r.rows[0];

  // P0 fix (2026-08-30): never resurrect a cancelled subscription. A sub that
  // the owner cancelled (cancel_at_period_end/cancelled) — or an orphaned
  // gateway sub left over from a plan change — must not be flipped back to
  // 'active' with an extended period by a stray charge. We still RECORD the
  // payment below (they were charged, so it belongs in the ledger) but we do
  // not re-activate. This pairs with the gateway-cancel in createSubscription
  // and cancelAtPeriodEnd so the mandate stops charging in the first place.
  const isCancelled = sr.cancel_at_period_end === true
    || sr.status === 'cancelled'
    || sr.cancelled_at != null;

  // Look up which of OUR plans this Razorpay plan corresponds to. The
  // webhook payload carries Razorpay's plan_id (e.g. `plan_QXabcdef`)
  // which we mapped during /admin/razorpay/sync, stored in
  // plans.razorpay_plan_id. This is what flips the business onto Pro/
  // Enterprise — deliberately deferred from createSubscription so a
  // dismissed checkout never grants paid features (Push 13.1).
  const planLookup = await query(
    `SELECT id FROM plans WHERE razorpay_plan_id = $1 LIMIT 1`,
    [sub.plan_id]
  );
  const newPlanId = planLookup.rowCount > 0 ? planLookup.rows[0].id : sr.plan_id;

  // Move period forward
  const periodEnd = sub.current_end
    ? new Date(sub.current_end * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // P1 fix (2026-08-30): do the reactivation + invoice + payment in ONE
  // transaction. Previously each ran on autocommit, so a failure between the
  // status flip and the invoice insert (e.g. an invoice-number collision)
  // left the plan active with no invoice/payment row — revenue silently
  // unrecorded and the PDF endpoint with nothing to render.
  await withTransaction(async (client) => {
    if (!isCancelled) {
      await client.query(
        `UPDATE subscriptions
            SET plan_id = $1,
                status = 'active',
                current_period_start = NOW(),
                current_period_end = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newPlanId, periodEnd, sr.id]
      );
    } else {
      logger.warn(`Charge on cancelled subscription ${sr.id} (rzp ${sub.id}); recording payment but NOT reactivating`);
    }

    // Collision-safe invoice number: a per-year DB sequence guarantees
    // uniqueness under concurrency (the old Math.random() 6-digit value
    // collided at volume → 23505 → lost payment record).
    const seq = await client.query(`SELECT nextval('subscription_invoice_seq') AS n`);
    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(seq.rows[0].n).padStart(6, '0')}`;
    const inv = await client.query(
      `INSERT INTO invoices
         (business_id, subscription_id, number, status,
          amount_paise, currency, period_start, period_end, paid_at)
       VALUES ($1, $2, $3, 'paid', $4, 'INR', NOW(), $5, NOW())
       RETURNING id`,
      [sr.business_id, sr.id, invoiceNumber, pay.amount, periodEnd]
    );
    await client.query(
      `INSERT INTO payments
         (business_id, invoice_id, amount_paise, currency, method,
          razorpay_payment_id, status, raw_payload)
       VALUES ($1, $2, $3, 'INR', $4, $5, 'captured', $6)
       ON CONFLICT (razorpay_payment_id) DO NOTHING`,
      [sr.business_id, inv.rows[0].id, pay.amount, pay.method, pay.id, pay]
    );
  });
}

/**
 * FF-250 — create a Razorpay one-time Order for a guest checkout.
 * Returns the Razorpay `order_id` + client key which the guest's
 * browser opens via Razorpay's Checkout.js widget. The webhook path
 * (payment.captured) below marks our internal `orders.payment_method`
 * to 'upi'/'card'/'netbanking' based on the returned method.
 */
async function createCheckoutOrder({ amountPaise, receiptId, notes = {} }) {
  const created = await rzCall('POST', '/v1/orders', {
    amount: amountPaise,
    currency: 'INR',
    receipt: receiptId,
    notes,
  });
  return {
    razorpayOrderId: created.id,
    keyId: env.RAZORPAY_KEY_ID,
    amount: amountPaise,
    currency: 'INR',
  };
}

/**
 * FF-250 — verify a client-side callback from Razorpay Checkout. The
 * guest browser gets razorpay_order_id + razorpay_payment_id +
 * razorpay_signature and posts them back; we HMAC-SHA256 verify.
 */
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const crypto = require('crypto');
  // S14 (security 2026-08-23): guard against a missing/short client signature
  // so a malformed callback returns a clean false (→ 401) instead of throwing
  // a 500 inside timingSafeEqual (which requires equal-length buffers).
  if (!signature || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  syncPlans,
  createSubscription,
  verifyWebhookSignature,
  handleWebhook,
  createCheckoutOrder,       // FF-250
  verifyCheckoutSignature,   // FF-250
};

// ── Addon marketplace one-time orders (2026-08-25) ──────────────────────
/**
 * Create a one-time Razorpay Order (first month/year of a paid marketplace
 * addon). Added for the founder bug "addons get subscribed without charging
 * anything": addonService.subscribe() now creates this order and the addon
 * only activates in addonService.confirmPayment() after the checkout
 * signature verifies.
 *
 * WHY a separate helper instead of reusing createCheckoutOrder: that one is
 * shaped for guest checkout ({ razorpayOrderId, keyId, ... }) and is part of
 * the FF-250 contract — this returns Razorpay's raw order identifiers
 * ({ id, amount, currency }) which map 1:1 onto Checkout.js `order_id` /
 * `amount` / `currency` options. Appended (not edited) per append-only rule.
 */
async function createOneTimeOrder({ amountPaise, receipt, notes = {} }) {
  const created = await rzCall('POST', '/v1/orders', {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes,
  });
  return { id: created.id, amount: created.amount, currency: created.currency };
}
module.exports.createOneTimeOrder = createOneTimeOrder;

// ── Guest checkout binding (2026-08-25, security review finding #1) ─────
/**
 * Fetch a Razorpay Order by id (raw Razorpay shape: {id, amount, notes, …}).
 *
 * WHY: the Checkout.js callback HMAC only proves "payment X belongs to
 * Razorpay order Y" — it says NOTHING about which of OUR orders/sessions
 * Y was created for, or for how much. The guest confirm endpoints must
 * therefore re-fetch Y and check the notes we wrote in createCheckoutOrder
 * ({businessId, orderId|sessionId}) plus the amount, otherwise a valid
 * signature from a cheap paid order can be replayed to mark any order
 * paid. Appended (not edited) per append-only rule.
 */
async function getOrder(razorpayOrderId) {
  return rzCall('GET', `/v1/orders/${encodeURIComponent(razorpayOrderId)}`);
}
module.exports.getOrder = getOrder;
