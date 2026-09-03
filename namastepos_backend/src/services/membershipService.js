// Memberships + gift cards + wallet + tips (Sprint 4 / FF-1006, FF-1005, FF-903)

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

// ── Memberships ──────────────────────────────────────────────────────────
async function listMemberships(businessId) {
  const r = await query(
    `SELECT * FROM memberships WHERE business_id = $1 AND is_active = TRUE
      ORDER BY price_paise ASC`,
    [businessId]
  );
  return r.rows;
}

async function createMembership(businessId, body) {
  const { name, description, priceInr, validityDays, benefits } = body;
  const r = await query(
    `INSERT INTO memberships
       (business_id, name, description, price_paise, validity_days, benefits)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [businessId, name, description || null, Math.round(priceInr * 100),
     validityDays || 30, benefits ? JSON.stringify(benefits) : null]
  );
  return r.rows[0];
}

// Update a membership plan (2026-08-24): only Create+Read existed before, so
// the owner couldn't edit a wrong price/validity or fix a bundle — they were
// stuck re-creating. Partial update: only the fields sent are changed.
async function updateMembership(businessId, id, body) {
  const allowed = {
    name: 'name', description: 'description',
    priceInr: 'price_paise', validityDays: 'validity_days', benefits: 'benefits',
  };
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (k === 'priceInr') v = Math.round(v * 100);
    if (k === 'benefits') v = v ? JSON.stringify(v) : null;
    sets.push(`${col} = $${idx++}`);
    values.push(v);
  }
  if (!sets.length) {
    const cur = await query(`SELECT * FROM memberships WHERE business_id = $1 AND id = $2`, [businessId, id]);
    if (cur.rowCount === 0) throw new NotFound('Membership not found');
    return cur.rows[0];
  }
  values.push(businessId, id);
  const r = await query(
    `UPDATE memberships SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} AND is_active = TRUE
      RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Membership not found');
  return r.rows[0];
}

// Soft-delete a plan (2026-08-24). Soft so existing customer subscriptions
// that reference it stay intact (honour standing rule: no hard deletes that
// could break FKs / lose data). It just stops appearing in the list.
async function deleteMembership(businessId, id) {
  const r = await query(
    `UPDATE memberships SET is_active = FALSE
      WHERE business_id = $1 AND id = $2 AND is_active = TRUE
      RETURNING id`,
    [businessId, id]
  );
  if (r.rowCount === 0) throw new NotFound('Membership not found');
  return { deleted: true, id };
}

async function subscribe(businessId, body) {
  // 2026-08-25 (founder): membership SELL is a real payment now —
  // paymentMethod may be 'wallet' (debits the customer wallet atomically
  // with the sale) and an optional paymentBreakdown splits the charge
  // across 1-3 tenders. The charge is always the plan price; breakdown
  // legs must sum to it (±₹0.01 → 400). Sales land in revenue reporting
  // via membership_subscriptions.amount_paid_paise + payment_method
  // (incomeStatementService 'Membership sales' other-income line).
  const {
    customerId, membershipId, paymentMethod = 'cash', paymentBreakdown = null,
    // NP-116 (2026-09-03): optional idempotency key. A retried subscribe with
    // the same clientKey returns the ORIGINAL sale (one subscription row, one
    // wallet debit) instead of selling twice — same pattern as orders.client_id.
    // Backed by migration 070 (client_key column + partial unique index).
    clientKey = null,
  } = body;
  const findByClientKey = async (q) => {
    const dup = await q(
      `SELECT * FROM membership_subscriptions
        WHERE business_id = $1 AND client_key = $2 LIMIT 1`,
      [businessId, clientKey]
    );
    return dup.rows[0] || null;
  };
  const sell = () => withTransaction(async (client) => {
    // Idempotency: same clientKey within the same business → return the
    // stored sale. Checked inside the txn; the partial unique index closes
    // the concurrent-retry race (23505 handled below).
    if (clientKey) {
      const existing = await findByClientKey((sql, vals) => client.query(sql, vals));
      if (existing) return existing;
    }
    const m = await client.query(
      `SELECT * FROM memberships WHERE business_id = $1 AND id = $2`,
      [businessId, membershipId]
    );
    if (m.rowCount === 0) throw new NotFound('Membership not found');
    const plan = m.rows[0];
    const pricePaise = Number(plan.price_paise);

    // Tenant-scope the customer (standing security rule: every id lookup
    // is scoped) — also needed before we touch their wallet.
    const cust = await client.query(
      `SELECT id FROM customers WHERE business_id = $1 AND id = $2`,
      [businessId, customerId]
    );
    if (cust.rowCount === 0) throw new NotFound('Customer not found');

    // Collect the payment. Wallet legs debit inside THIS txn so an
    // insufficient balance aborts the sale (no membership, no charge).
    const gc = require('./giftCardService');
    let walletPaise = 0;
    // Recorded tender: when a breakdown is sent, the LARGEST leg's method
    // wins (same convention as orders.payment_method, 2026-08-25) so
    // reports get one primary method per sale.
    let recordedMethod = paymentMethod;
    if (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0) {
      const legs = paymentBreakdown.map((l) => ({
        method: l.method,
        amountPaise: Math.round((l.amountInr || 0) * 100),
      }));
      const sumPaise = legs.reduce((s, l) => s + l.amountPaise, 0);
      if (Math.abs(sumPaise - pricePaise) > 1) {
        throw new BadRequest(
          `paymentBreakdown legs total ₹${(sumPaise / 100).toFixed(2)} but the `
          + `membership price is ₹${(pricePaise / 100).toFixed(2)} — they must match`
        );
      }
      walletPaise = legs.filter((l) => l.method === 'wallet')
        .reduce((s, l) => s + l.amountPaise, 0);
      recordedMethod = [...legs].sort((a, b) => b.amountPaise - a.amountPaise)[0].method;
    } else if (paymentMethod === 'wallet') {
      walletPaise = pricePaise;
    }
    if (walletPaise > 0) {
      await gc.debitWalletTx(client, businessId, customerId, walletPaise, {
        reason: 'order_payment',
        note: `Membership purchase — ${plan.name}`,
      });
    }

    const expires = new Date(Date.now() + plan.validity_days * 24 * 60 * 60 * 1000);
    // Bundle entitlements (2026-08-23): copy the plan's item bundle into
    // the subscription's `remaining` so redemption can count it down.
    const bundle = plan.benefits && plan.benefits.items
      ? JSON.stringify(plan.benefits.items) : null;
    const ins = await client.query(
      `INSERT INTO membership_subscriptions
         (business_id, customer_id, membership_id, expires_at,
          amount_paid_paise, remaining, payment_method, client_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
      [businessId, customerId, membershipId, expires, pricePaise, bundle,
        recordedMethod, clientKey]
    );
    return ins.rows[0];
  });
  try {
    return await sell();
  } catch (err) {
    // NP-116: a concurrent retry lost the (business_id, client_key) unique
    // race — its txn rolled back (so its wallet debit never landed); return
    // the winner's sale (same shape as a fresh insert).
    if (err.code === '23505' && clientKey
        && err.constraint === 'uq_membership_subs_client_key') {
      const existing = await findByClientKey(query);
      if (existing) return existing;
    }
    throw err;
  }
}

// ── Membership cancel → refund (2026-08-25, founder) ─────────────────────
// Remaining value = price_paid × (remaining bundle qty ÷ original bundle
// qty). Plans without an item bundle fall back to time proration
// (remaining validity days ÷ total validity days) — same "unused share"
// idea, just measured in days instead of coffees. A cancellation charge
// (pct) is deducted; the pct comes from the request (UI passes the
// business's configured value), else platform_settings key
// 'membership.cancellation_pct', else 10. WHY request-first: there is no
// per-BUSINESS settings KV in this codebase (platform_settings is
// platform-wide), and inventing one for a single number would be
// overkill pre-launch — the UI owns the per-business default for now.
async function cancelSubscription(businessId, subscriptionId, {
  mode, cancellationPct = null,
} = {}) {
  if (!['wallet', 'cash', 'upi'].includes(mode)) {
    throw new BadRequest("mode must be 'wallet', 'cash' or 'upi'");
  }
  // 2026-08-25: :id comes straight off the URL — reject junk before it
  // hits a uuid cast (22P02 would surface as a 500, not a 400). Same
  // guard pattern as tableService.assertUuid.
  if (typeof subscriptionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    throw new BadRequest('subscription id must be a valid id');
  }
  let pct = cancellationPct;
  if (pct == null) {
    try {
      const settings = require('./settingsService');
      const v = await settings.get('membership.cancellation_pct');
      if (v != null && Number.isFinite(Number(v))) pct = Number(v);
    } catch (_) { /* settings lookup is best-effort */ }
  }
  if (pct == null) pct = 10; // founder default
  pct = Math.min(100, Math.max(0, Number(pct)));

  return withTransaction(async (client) => {
    const q = await client.query(
      `SELECT ms.*, m.name AS plan_name, m.benefits, m.validity_days
         FROM membership_subscriptions ms
         JOIN memberships m ON m.id = ms.membership_id
        WHERE ms.business_id = $1 AND ms.id = $2
        FOR UPDATE OF ms`,
      [businessId, subscriptionId]
    );
    if (q.rowCount === 0) throw new NotFound('Subscription not found');
    const sub = q.rows[0];
    if (sub.status !== 'active') {
      throw new BadRequest(`Subscription is already ${sub.status}`);
    }

    // Unused share: bundle-based when the plan has an item bundle,
    // time-based otherwise (see WHY-comment above).
    const paidPaise = Number(sub.amount_paid_paise);
    const originalQty = (sub.benefits?.items || [])
      .reduce((s, i) => s + Number(i.qty || 0), 0);
    let ratio;
    let basis;
    if (originalQty > 0) {
      const remainingQty = (Array.isArray(sub.remaining) ? sub.remaining : [])
        .reduce((s, i) => s + Number(i.qty || 0), 0);
      ratio = Math.min(1, Math.max(0, remainingQty / originalQty));
      basis = 'bundle';
    } else {
      const msLeft = new Date(sub.expires_at).getTime() - Date.now();
      const msTotal = Number(sub.validity_days) * 24 * 60 * 60 * 1000;
      ratio = msTotal > 0 ? Math.min(1, Math.max(0, msLeft / msTotal)) : 0;
      basis = 'time';
    }
    const grossPaise = Math.round(paidPaise * ratio);
    const feePaise = Math.round(grossPaise * (pct / 100));
    const refundPaise = Math.max(0, grossPaise - feePaise);

    if (refundPaise > 0) {
      if (mode === 'wallet') {
        await require('./giftCardService').creditWalletTx(
          client, businessId, sub.customer_id, refundPaise,
          { reason: 'membership_refund', note: `Membership cancelled — ${sub.plan_name}` },
        );
      } else {
        // cash/upi payout — mirror how order refunds are recorded (a row
        // in `refunds`, status 'processed' since there's no gateway to
        // reconcile). It's a REVENUE REVERSAL, not an expense — the
        // income statement nets it off as 'Membership refunds', reading
        // refund_paise straight from the subscription row.
        await client.query(
          `INSERT INTO refunds
             (business_id, amount_paise, currency, reason, status, raw_payload)
           VALUES ($1, $2, 'INR', $3, 'processed', $4::jsonb)`,
          [businessId, refundPaise,
            `Membership cancelled — ${sub.plan_name}`,
            JSON.stringify({
              source: 'membership-cancel',
              subscriptionId,
              customerId: sub.customer_id,
              mode,
              cancellationPct: pct,
            })],
        );
      }
    }

    const upd = await client.query(
      `UPDATE membership_subscriptions
          SET status = 'cancelled', cancelled_at = NOW(),
              refund_paise = $1, refund_mode = $2, cancellation_fee_paise = $3
        WHERE id = $4 RETURNING *`,
      [refundPaise, mode, feePaise, subscriptionId]
    );
    return {
      subscription: upd.rows[0],
      refund: {
        mode,
        basis, // 'bundle' | 'time' — how the unused share was measured
        remainingValueInr: grossPaise / 100,
        cancellationPct: pct,
        cancellationFeeInr: feePaise / 100,
        refundInr: refundPaise / 100,
      },
    };
  });
}

/// Active subscription (with plan info + what's left of the bundle).
async function activeForCustomer(businessId, customerId) {
  const r = await query(
    `SELECT ms.id AS subscription_id, ms.expires_at, ms.remaining,
            m.id AS membership_id, m.name, m.price_paise, m.validity_days,
            m.benefits
       FROM membership_subscriptions ms
       JOIN memberships m ON m.id = ms.membership_id
      WHERE ms.business_id = $1 AND ms.customer_id = $2
        AND ms.status = 'active' AND ms.expires_at > NOW()
      ORDER BY ms.expires_at DESC LIMIT 1`,
    [businessId, customerId]
  );
  return r.rows[0] || null;
}

/// Most recently EXPIRED subscription — used by the POS renewal prompt.
async function lastExpiredForCustomer(businessId, customerId) {
  const r = await query(
    `SELECT ms.id AS subscription_id, ms.expires_at,
            m.id AS membership_id, m.name, m.price_paise, m.validity_days
       FROM membership_subscriptions ms
       JOIN memberships m ON m.id = ms.membership_id
      WHERE ms.business_id = $1 AND ms.customer_id = $2
        AND ms.expires_at <= NOW()
        AND m.is_active = TRUE
      ORDER BY ms.expires_at DESC LIMIT 1`,
    [businessId, customerId]
  );
  return r.rows[0] || null;
}

// ── Gift cards ───────────────────────────────────────────────────────────
function _generateCode() {
  return 'GC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function issueGiftCard(businessId, body) {
  const { amountInr, purchaserPhone, recipientPhone, expiresAt } = body;
  if (!amountInr || amountInr <= 0) throw new BadRequest('Amount required');
  const code = _generateCode();
  const r = await query(
    `INSERT INTO gift_cards
       (business_id, code, initial_paise, remaining_paise,
        purchaser_phone, recipient_phone, expires_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING *`,
    [businessId, code, Math.round(amountInr * 100),
     purchaserPhone || null, recipientPhone || null, expiresAt || null]
  );
  return r.rows[0];
}

async function listGiftCards(businessId, { activeOnly = true } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId];
  if (activeOnly) where.push('is_active = TRUE AND remaining_paise > 0');
  const r = await query(
    `SELECT * FROM gift_cards WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT 100`,
    values
  );
  return r.rows;
}

async function redeemGiftCard(businessId, code, amountInr, orderId = null) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `SELECT * FROM gift_cards
        WHERE business_id = $1 AND code = $2 AND is_active = TRUE
        FOR UPDATE`,
      [businessId, code]
    );
    if (r.rowCount === 0) throw new NotFound('Gift card not found');
    const gc = r.rows[0];
    if (gc.expires_at && new Date(gc.expires_at) < new Date()) {
      throw new BadRequest('Gift card expired');
    }
    const amtPaise = Math.round(amountInr * 100);
    if (gc.remaining_paise < amtPaise) {
      throw new BadRequest(`Insufficient balance (₹${gc.remaining_paise/100} left)`);
    }
    const newBalance = gc.remaining_paise - amtPaise;
    await client.query(
      `UPDATE gift_cards SET remaining_paise = $1 WHERE id = $2`,
      [newBalance, gc.id]
    );
    await client.query(
      `INSERT INTO wallet_transactions
         (business_id, gift_card_id, kind, amount_paise, balance_after, order_id)
       VALUES ($1, $2, 'redeem', $3, $4, $5)`,
      [businessId, gc.id, -amtPaise, newBalance, orderId]
    );
    return { redeemedInr: amountInr, balanceInr: newBalance / 100 };
  });
}

// ── Customer wallet ──────────────────────────────────────────────────────
async function walletTopup(businessId, customerId, amountInr) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE customers
          SET wallet_balance_paise = wallet_balance_paise + $1
        WHERE business_id = $2 AND id = $3
        RETURNING wallet_balance_paise`,
      [Math.round(amountInr * 100), businessId, customerId]
    );
    if (r.rowCount === 0) throw new NotFound('Customer not found');
    await client.query(
      `INSERT INTO wallet_transactions
         (business_id, customer_id, kind, amount_paise, balance_after)
       VALUES ($1, $2, 'topup', $3, $4)`,
      [businessId, customerId, Math.round(amountInr * 100), r.rows[0].wallet_balance_paise]
    );
    return r.rows[0].wallet_balance_paise;
  });
}

// ── Tips ─────────────────────────────────────────────────────────────────
async function recordTip(businessId, body) {
  const { orderId, serverUserId, amountInr } = body;
  if (!amountInr || amountInr <= 0) throw new BadRequest('Tip must be positive');
  const r = await query(
    `INSERT INTO tips (business_id, order_id, server_user_id, amount_paise)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, orderId || null, serverUserId || null, Math.round(amountInr * 100)]
  );
  if (orderId) {
    // Cross-tenant fix (B1): scope the UPDATE to the caller's business
    // so an attacker who guesses another tenant's orderId can't spike
    // tips on someone else's order.
    await query(
      `UPDATE orders SET tip_paise = $1 WHERE id = $2 AND business_id = $3`,
      [Math.round(amountInr * 100), orderId, businessId]
    );
  }
  return r.rows[0];
}

async function tipReport(businessId, { startDate, endDate } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId]; let idx = 2;
  if (startDate) { where.push(`created_at >= $${idx++}::date`); values.push(startDate); }
  if (endDate)   { where.push(`created_at < ($${idx++}::date + INTERVAL '1 day')`); values.push(endDate); }
  const r = await query(
    `SELECT server_user_id, COUNT(*)::int AS tip_count,
            COALESCE(SUM(amount_paise), 0) / 100.0 AS total_inr
       FROM tips WHERE ${where.join(' AND ')}
      GROUP BY server_user_id ORDER BY total_inr DESC`,
    values
  );
  return r.rows;
}

// 2026-08-26 (founder): list all customers who hold a membership, with detail.
// Joined roster for the "Members" screen on mobile + web.
async function listSubscribers(businessId) {
  const r = await query(
    `SELECT ms.id, ms.status, ms.started_at, ms.expires_at,
            ms.amount_paid_paise, ms.payment_method, ms.created_at,
            c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
            m.name AS plan_name
       FROM membership_subscriptions ms
       JOIN customers   c ON c.id = ms.customer_id
       JOIN memberships m ON m.id = ms.membership_id
      WHERE ms.business_id = $1
      ORDER BY ms.created_at DESC
      LIMIT 500`,
    [businessId],
  );
  const now = Date.now();
  return r.rows.map((x) => ({
    id: x.id,
    customerId: x.customer_id,
    customerName: x.customer_name,
    customerPhone: x.customer_phone,
    planName: x.plan_name,
    amountPaidInr: (x.amount_paid_paise || 0) / 100,
    paymentMethod: x.payment_method,
    // Effective status: an 'active' row past expiry reads as expired.
    status: (x.status === 'active' && x.expires_at && new Date(x.expires_at).getTime() < now)
      ? 'expired' : x.status,
    startedAt: x.started_at,
    expiresAt: x.expires_at,
  }));
}

module.exports = {
  listMemberships, createMembership, updateMembership, deleteMembership, subscribe,
  listSubscribers,
  cancelSubscription,
  activeForCustomer, lastExpiredForCustomer,
  issueGiftCard, listGiftCards, redeemGiftCard,
  walletTopup,
  recordTip, tipReport,
};
