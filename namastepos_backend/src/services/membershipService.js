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
  const { customerId, membershipId, paymentMethod = 'cash' } = body;
  return withTransaction(async (client) => {
    const m = await client.query(
      `SELECT * FROM memberships WHERE business_id = $1 AND id = $2`,
      [businessId, membershipId]
    );
    if (m.rowCount === 0) throw new NotFound('Membership not found');
    const plan = m.rows[0];
    const expires = new Date(Date.now() + plan.validity_days * 24 * 60 * 60 * 1000);
    // Bundle entitlements (2026-08-23): copy the plan's item bundle into
    // the subscription's `remaining` so redemption can count it down.
    const bundle = plan.benefits && plan.benefits.items
      ? JSON.stringify(plan.benefits.items) : null;
    const ins = await client.query(
      `INSERT INTO membership_subscriptions
         (business_id, customer_id, membership_id, expires_at,
          amount_paid_paise, remaining)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [businessId, customerId, membershipId, expires, plan.price_paise, bundle]
    );
    return ins.rows[0];
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

module.exports = {
  listMemberships, createMembership, updateMembership, deleteMembership, subscribe,
  activeForCustomer, lastExpiredForCustomer,
  issueGiftCard, listGiftCards, redeemGiftCard,
  walletTopup,
  recordTip, tipReport,
};
