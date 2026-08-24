// NamastePOS backend - loyalty (points) service
//
// Earn rules:
//   1 point per `earn_rate_paise` paise spent (default ₹10 = 1 point).
//   Awarded when the order moves to `collected` (so we don't reward then refund).
//
// Redeem rules:
//   1 point = `redemption_value_paise` paise off (default ₹1).
//   Floor at `min_redemption_points`; cap at `max_redemption_pct` of bill.
//
// Tier progression:
//   bronze → silver (lifetime_points >= silver_threshold)
//          → gold   (lifetime_points >= gold_threshold)

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

function serializeSettings(s) {
  if (!s) return null;
  return {
    businessId: s.business_id,
    isActive: s.is_active,
    earnRatePaise: s.earn_rate_paise,
    earnRateInr: s.earn_rate_paise / 100,
    redemptionValuePaise: s.redemption_value_paise,
    redemptionValueInr: s.redemption_value_paise / 100,
    minRedemptionPoints: s.min_redemption_points,
    maxRedemptionPct: s.max_redemption_pct,
    pointsExpireMonths: s.points_expire_months,
    welcomeBonus: s.welcome_bonus,
    birthdayBonus: s.birthday_bonus,
    tierSilverThreshold: s.tier_silver_threshold,
    tierGoldThreshold: s.tier_gold_threshold,
  };
}

function serializeTxn(t) {
  return {
    id: t.id,
    customerId: t.customer_id,
    kind: t.kind,
    points: t.points,
    balanceAfter: t.balance_after,
    orderId: t.order_id,
    note: t.note,
    createdAt: t.created_at,
  };
}

// ── Settings ────────────────────────────────────────────────────────────
async function getSettings(businessId) {
  const r = await query(
    `SELECT * FROM loyalty_settings WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  if (r.rowCount === 0) {
    // Auto-create defaults. is_active=TRUE (2026-08-22): the schema
    // default is FALSE, which meant loyalty silently earned nothing for
    // every business that never found the settings toggle. Reaching this
    // code at all means the business has the loyalty feature — default on.
    const ins = await query(
      `INSERT INTO loyalty_settings (business_id, is_active)
       VALUES ($1, TRUE) RETURNING *`,
      [businessId]
    );
    return serializeSettings(ins.rows[0]);
  }
  return serializeSettings(r.rows[0]);
}

async function updateSettings(businessId, patch) {
  const fields = ['is_active', 'earn_rate_paise', 'redemption_value_paise',
                  'min_redemption_points', 'max_redemption_pct',
                  'points_expire_months', 'welcome_bonus', 'birthday_bonus',
                  'tier_silver_threshold', 'tier_gold_threshold'];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  // Make sure the row exists
  await getSettings(businessId);
  if (sets.length === 0) return getSettings(businessId);
  values.push(businessId);
  const r = await query(
    `UPDATE loyalty_settings SET ${sets.join(', ')}
      WHERE business_id = $${idx} RETURNING *`,
    values
  );
  return serializeSettings(r.rows[0]);
}

// ── Compute earnings preview (used at checkout) ─────────────────────────
function pointsEarnedFor(amountPaise, settings) {
  if (!settings.isActive || !settings.earnRatePaise) return 0;
  return Math.floor(amountPaise / settings.earnRatePaise);
}

function inrToPointsRedemption(points, settings) {
  return points * settings.redemptionValuePaise; // returns paise
}

function maxRedeemablePoints(balance, billPaise, settings) {
  if (!settings.isActive || balance < settings.minRedemptionPoints) return 0;
  const maxValuePaise = Math.floor(billPaise * (settings.maxRedemptionPct / 100));
  const maxPointsByValue = Math.floor(maxValuePaise / settings.redemptionValuePaise);
  return Math.min(balance, maxPointsByValue);
}

// ── Earn / redeem (transactional) ───────────────────────────────────────
/**
 * Award points to a customer for an order.
 * Idempotent on (customer_id, order_id, kind='earn').
 * Returns the new balance.
 */
async function earn({ businessId, customerId, orderId, amountPaise, settings }) {
  if (!settings.isActive) return 0;
  const points = pointsEarnedFor(amountPaise, settings);
  if (points <= 0) return 0;

  return withTransaction(async (client) => {
    // P0-8 fix: rely on the partial unique index `uq_loyalty_earn_per_order`
    // (added in migration 009) rather than a SELECT-then-INSERT pre-check
    // that had a TOCTOU race. We attempt the INSERT first with ON CONFLICT
    // DO NOTHING — if a concurrent retry beat us, INSERT returns 0 rows and
    // we exit without double-crediting the customer.
    //
    // Step A: take a row lock on the customer so the balance update is safe.
    const cust = await client.query(
      `SELECT points_balance FROM customers
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [customerId, businessId]
    );
    if (cust.rowCount === 0) return 0;
    const newBalance = cust.rows[0].points_balance + points;

    // Step B: insert the ledger row, gated by the partial unique index.
    // P0 FIX (2026-08-23, the "always 0 points" bug): uq_loyalty_earn_per_order
    // is a partial unique INDEX (migration 009), not a table CONSTRAINT.
    // `ON CONFLICT ON CONSTRAINT <index>` throws
    // `constraint "uq_loyalty_earn_per_order" does not exist` at runtime,
    // the caller's catch swallowed it, and NO business ever earned a
    // single point. Partial unique indexes must be targeted by column
    // list + WHERE predicate.
    const ledger = await client.query(
      `INSERT INTO loyalty_transactions
         (business_id, customer_id, kind, points, balance_after, order_id)
       VALUES ($1, $2, 'earn', $3, $4, $5)
       ON CONFLICT (business_id, customer_id, order_id)
         WHERE kind = 'earn' AND order_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [businessId, customerId, points, newBalance, orderId]
    );
    if (ledger.rowCount === 0) return points; // duplicate — already credited

    // Step C: bump customer balance + tier.
    await client.query(
      `UPDATE customers
          SET points_balance   = points_balance + $1,
              lifetime_points  = lifetime_points + $1,
              tier = CASE
                WHEN lifetime_points + $1 >= (SELECT tier_gold_threshold FROM loyalty_settings WHERE business_id = $2) THEN 'gold'
                WHEN lifetime_points + $1 >= (SELECT tier_silver_threshold FROM loyalty_settings WHERE business_id = $2) THEN 'silver'
                ELSE 'bronze'
              END
        WHERE id = $3 AND business_id = $2`,
      [points, businessId, customerId]
    );
    return points;
  });
}

/**
 * Redeem points at checkout — reduces balance and logs the txn.
 * Called from order create when `pointsToRedeem` is provided.
 * Returns { points, discountPaise }.
 */
async function redeem({ businessId, customerId, orderId, points, settings }) {
  if (!settings.isActive) return { points: 0, discountPaise: 0 };
  if (points < settings.minRedemptionPoints) {
    throw new BadRequest(`Minimum redemption is ${settings.minRedemptionPoints} points`);
  }

  return withTransaction(async (client) => {
    const c = await client.query(
      `SELECT points_balance FROM customers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [customerId, businessId]
    );
    if (c.rowCount === 0) throw new NotFound('Customer not found');
    const bal = c.rows[0].points_balance;
    if (points > bal) throw new BadRequest(`Insufficient points (have ${bal})`);

    const updated = await client.query(
      `UPDATE customers
          SET points_balance    = points_balance - $1,
              lifetime_redeemed = lifetime_redeemed + $1
        WHERE id = $2 RETURNING points_balance`,
      [points, customerId]
    );

    await client.query(
      `INSERT INTO loyalty_transactions
         (business_id, customer_id, kind, points, balance_after, order_id)
       VALUES ($1, $2, 'redeem', $3, $4, $5)`,
      [businessId, customerId, -points, updated.rows[0].points_balance, orderId]
    );

    const discountPaise = points * settings.redemption_value_paise || points * settings.redemptionValuePaise;
    return { points, discountPaise: points * settings.redemptionValuePaise };
  });
}

/** Manual credit/debit by owner (e.g., service recovery, complaint). */
async function manualAdjust({ businessId, customerId, points, note, adminUserId }) {
  if (!points) throw new BadRequest('Points required');
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE customers
          SET points_balance = points_balance + $1,
              lifetime_points = lifetime_points + GREATEST($1, 0),
              lifetime_redeemed = lifetime_redeemed + GREATEST(-$1, 0)
        WHERE id = $2 AND business_id = $3 RETURNING points_balance`,
      [points, customerId, businessId]
    );
    if (r.rowCount === 0) throw new NotFound('Customer not found');
    await client.query(
      `INSERT INTO loyalty_transactions
         (business_id, customer_id, kind, points, balance_after, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [businessId, customerId,
       points > 0 ? 'manual_credit' : 'manual_debit',
       points, r.rows[0].points_balance, note || null]
    );
    return r.rows[0].points_balance;
  });
}

async function listTransactions(businessId, customerId, { limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM loyalty_transactions
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [businessId, customerId, limit]
  );
  return r.rows.map(serializeTxn);
}

// ── Welcome / birthday bonuses ──────────────────────────────────────────
async function awardWelcomeBonus({ businessId, customerId, settings }) {
  if (!settings.isActive || !settings.welcomeBonus) return 0;
  const points = settings.welcomeBonus;
  const updated = await query(
    `UPDATE customers
        SET points_balance = points_balance + $1, lifetime_points = lifetime_points + $1
      WHERE id = $2 AND business_id = $3 RETURNING points_balance`,
    [points, customerId, businessId]
  );
  await query(
    `INSERT INTO loyalty_transactions
       (business_id, customer_id, kind, points, balance_after, note)
     VALUES ($1, $2, 'welcome', $3, $4, 'Welcome bonus')`,
    [businessId, customerId, points, updated.rows[0]?.points_balance || points]
  );
  return points;
}

module.exports = {
  getSettings, updateSettings,
  pointsEarnedFor, maxRedeemablePoints, inrToPointsRedemption,
  earn, redeem, manualAdjust, listTransactions, awardWelcomeBonus,
  serializeSettings, serializeTxn,
};
