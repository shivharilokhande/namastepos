// NamastePOS — Referral program (FF-333).
//
// "Refer a cafe, both get 1 month free". A code is generated per
// referring business. When another cafe signs up with the code, we
// mark the referral, and after the referred cafe stays active for
// 30 days both parties get their subscription extended by 30 days.
//
// Wired from:
//   • authController.register — if body.referralCode, associate
//   • cronWorker.dueRecurringInvoices — when awarding, extend both
//     subscriptions' current_period_end by 30 days.

const { query } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');
const crypto = require('crypto');

function genCode() {
  return 'FF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function myCode(businessId) {
  const existing = await query(
    `SELECT code FROM referrals
      WHERE referrer_biz_id = $1 AND status = 'pending' AND referred_biz_id IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  );
  if (existing.rowCount > 0) return existing.rows[0].code;
  // Not yet issued — mint one. Retry a couple of times on the vanishingly rare code collision.
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    try {
      await query(
        `INSERT INTO referrals (referrer_biz_id, code, status)
         VALUES ($1, $2, 'pending')`,
        [businessId, code]
      );
      return code;
    } catch (e) {
      if (e.code !== '23505') throw e;   // unique violation: retry
    }
  }
  throw new BadRequest('Failed to mint referral code — try again');
}

/**
 * Called from registration if the new user pasted a referral code.
 * We DO NOT award yet — the referred cafe has to stay active for
 * 30 days first (protects against sign-up-then-quit gaming).
 */
async function associate(code, referredBizId) {
  const r = await query(
    `UPDATE referrals
        SET referred_biz_id = $2, status = 'signed_up'
      WHERE code = $1 AND status = 'pending' AND referred_biz_id IS NULL
      RETURNING *`,
    [code, referredBizId]
  );
  if (r.rowCount === 0) return null;   // silently ignore stale codes
  return r.rows[0];
}

/**
 * Cron-driven: find every `signed_up` referral where the referred
 * business has been active ≥30 days and hasn't been awarded yet.
 * Award = extend both subscriptions by 30 days.
 */
async function awardEligible() {
  const rows = await query(
    `SELECT r.id, r.referrer_biz_id, r.referred_biz_id
       FROM referrals r
       JOIN subscriptions s ON s.business_id = r.referred_biz_id
      WHERE r.status = 'signed_up'
        AND r.referred_biz_id IS NOT NULL
        AND s.status IN ('active','trialing')
        AND s.created_at < NOW() - INTERVAL '30 days'`
  );
  for (const row of rows.rows) {
    await query(
      `UPDATE subscriptions
          SET current_period_end = current_period_end + INTERVAL '30 days'
        WHERE business_id IN ($1, $2)`,
      [row.referrer_biz_id, row.referred_biz_id]
    );
    await query(
      `UPDATE referrals SET status = 'awarded', awarded_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
  return rows.rowCount;
}

async function stats(businessId) {
  const r = await query(
    `SELECT status, COUNT(*)::int AS n
       FROM referrals
      WHERE referrer_biz_id = $1
      GROUP BY status`,
    [businessId]
  );
  return r.rows.reduce((acc, row) => { acc[row.status] = row.n; return acc; }, {});
}

// L2 (2026-08-28) — admin view of all referrals + a manual "award now" action
// (the cron `awardEligible` handles the automatic path after 30 active days).
async function listAll({ status } = {}) {
  const where = ['1=1']; const vals = []; let i = 1;
  if (status) { where.push(`r.status = $${i++}`); vals.push(status); }
  const r = await query(
    `SELECT r.id, r.code, r.status, r.created_at, r.awarded_at,
            rb.name AS referrer_name, db.name AS referred_name
       FROM referrals r
       JOIN businesses rb ON rb.id = r.referrer_biz_id
       LEFT JOIN businesses db ON db.id = r.referred_biz_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC`,
    vals
  );
  return r.rows.map((x) => ({
    id: x.id, code: x.code, status: x.status,
    referrerName: x.referrer_name, referredName: x.referred_name || '—',
    createdAt: x.created_at, awardedAt: x.awarded_at,
  }));
}

// Manually award a signed-up referral now: extend both subscriptions by 30
// days and flag it awarded. No-op if already awarded or not yet signed up.
async function markAwarded(id) {
  const r = await query(
    `SELECT id, referrer_biz_id, referred_biz_id, status FROM referrals WHERE id = $1`, [id]
  );
  if (r.rowCount === 0) throw new NotFound('Referral not found');
  const row = r.rows[0];
  if (row.status === 'awarded') return row;
  if (!row.referred_biz_id) throw new BadRequest('Referral has no signed-up business yet');
  await query(
    `UPDATE subscriptions
        SET current_period_end = current_period_end + INTERVAL '30 days'
      WHERE business_id IN ($1, $2)`,
    [row.referrer_biz_id, row.referred_biz_id]
  );
  const upd = await query(
    `UPDATE referrals SET status = 'awarded', awarded_at = NOW() WHERE id = $1 RETURNING *`, [id]
  );
  return upd.rows[0];
}

module.exports = { myCode, associate, awardEligible, stats, listAll, markAwarded };
