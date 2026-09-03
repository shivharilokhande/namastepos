// NamastePOS backend - super admin service (customers / metrics / impersonation)
//
// NOTE (2026-08-27): admin authentication does NOT live here. All admin
// login / 2FA / bootstrap runs through adminTeamService against the
// `admin_users` table, which is what auth.js `requireSuperAdmin` and
// adminRbac.js check. The old `super_admins`-table login/bootstrap that
// used to live in this file was dead code (no route called it) and, worse,
// a footgun: a token minted from a `super_admins.id` would be rejected by
// requireSuperAdmin's live `admin_users` check. It has been removed so the
// two paths can never diverge. The `super_admins` table is now an unused
// orphan (safe to drop in a future migration).

const crypto = require('crypto');
const { query } = require('../config/db');
const { issueAccessToken } = require('../utils/jwt');
const { NotFound, Unauthorized } = require('../utils/errors');

// ── Customers (businesses) ───────────────────────────────────────────────

async function listCustomers({ search, plan, status, limit = 50, offset = 0 } = {}) {
  const where = ['1=1'];
  const values = [];
  let idx = 1;
  if (search) {
    where.push(`(b.name ILIKE $${idx} OR b.email ILIKE $${idx} OR b.phone ILIKE $${idx})`);
    values.push(`%${search}%`); idx += 1;
  }
  if (plan) { where.push(`p.tier = $${idx}`); values.push(plan); idx += 1; }
  if (status) { where.push(`s.status = $${idx}`); values.push(status); idx += 1; }
  values.push(limit, offset);

  // P1 (Vivek #2 / Arvind #4): single roundtrip with window-function COUNT.
  // Previously this was two queries (rows + COUNT), which (a) had the
  // slice(idx-3) param-count bug that caused 500s on /admin/customers, and
  // (b) could race so `total` didn't match the page just returned. Also
  // filters out soft-deleted businesses from migration 009.
  const r = await query(
    `SELECT b.id, b.name, b.email, b.phone, b.city, b.category, b.created_at,
            b.lifecycle_stage, b.health_score,
            p.tier AS plan_tier, p.name AS plan_name, p.price_inr_paise,
            s.status AS sub_status, s.current_period_end, s.cancel_at_period_end,
            (SELECT COUNT(*) FROM orders o WHERE o.business_id = b.id) AS total_orders,
            (SELECT COALESCE(SUM(total), 0) FROM orders o
              WHERE o.business_id = b.id AND o.status <> 'cancelled') AS total_revenue,
            (SELECT COUNT(*) FROM business_users bu
              WHERE bu.business_id = b.id AND bu.is_active) AS staff_count,
            COUNT(*) OVER ()::int AS _total
       FROM businesses b
  LEFT JOIN subscriptions s ON s.business_id = b.id
  LEFT JOIN plans p ON p.id = s.plan_id
      WHERE ${where.join(' AND ')} AND b.deleted_at IS NULL
   ORDER BY b.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    values
  );
  const total = r.rows[0]?._total ?? 0;

  return {
    customers: r.rows.map((row) => ({
      id: row.id, name: row.name, email: row.email, phone: row.phone,
      city: row.city, category: row.category, createdAt: row.created_at,
      plan: row.plan_tier
        ? { tier: row.plan_tier, name: row.plan_name, priceInr: row.price_inr_paise / 100 }
        : null,
      subscriptionStatus: row.sub_status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      totalOrders: parseInt(row.total_orders, 10),
      totalRevenue: parseFloat(row.total_revenue),
      staffCount: parseInt(row.staff_count, 10),
      // FF-402 — CRM primitives cached on businesses (nightly + on-demand)
      lifecycleStage: row.lifecycle_stage,
      healthScore: row.health_score,
    })),
    total,
    limit, offset,
  };
}

async function getCustomer(businessId) {
  const r = await query(
    `SELECT b.*, p.tier AS plan_tier, p.name AS plan_name,
            s.status AS sub_status, s.trial_ends_at, s.current_period_end,
            s.cancel_at_period_end, s.cancelled_at
       FROM businesses b
  LEFT JOIN subscriptions s ON s.business_id = b.id
  LEFT JOIN plans p ON p.id = s.plan_id
      WHERE b.id = $1 LIMIT 1`,
    [businessId]
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return r.rows[0];
}

async function suspend(businessId) {
  await query(
    `UPDATE subscriptions SET status = 'paused' WHERE business_id = $1`,
    [businessId]
  );
}

async function restore(businessId) {
  await query(
    `UPDATE subscriptions SET status = 'active' WHERE business_id = $1`,
    [businessId]
  );
}

// ── Platform metrics ─────────────────────────────────────────────────────

async function metrics() {
  // QA-9 perf #4: parallel queries (Promise.all) — 6 sequential RTTs → 1 RTT.
  const [r1, r2, r3, mrr, signups, gmv] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM businesses WHERE deleted_at IS NULL`),
    query(`SELECT s.status, COUNT(*)::int AS c
             FROM subscriptions s GROUP BY s.status`),
    // Bug fix (2026-08-20): the earlier query counted EVERY subscription
    // row per plan — including cancelled, past_due, or previous plans a
    // business has since upgraded away from. A business currently on
    // Enterprise but with a stale row from its previous Pro trial
    // showed up as "pro" in the pie chart, contradicting MRR. Now we
    // count only *currently paying* subs (active + trialing), which
    // matches how MRR itself is computed above.
    query(`SELECT p.tier, COUNT(*)::int AS c
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.status IN ('active','trialing')
            GROUP BY p.tier`),
    // MRR: sum of active paid plans' prices
    query(`SELECT COALESCE(SUM(p.price_inr_paise), 0) AS mrr_paise
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.status = 'active' AND p.price_inr_paise > 0`),
    // New signups last 30d
    query(`SELECT DATE(b.created_at) AS day, COUNT(*)::int AS c
             FROM businesses b
            WHERE b.created_at > NOW() - INTERVAL '30 days'
              AND b.deleted_at IS NULL
            GROUP BY day ORDER BY day`),
    // Platform-wide orders + GMV last 30d
    query(`SELECT COUNT(*)::int AS orders,
                  COALESCE(SUM(total), 0)::float AS gmv
             FROM orders
            WHERE created_at > NOW() - INTERVAL '30 days'
              AND status <> 'cancelled'`),
  ]);

  return {
    totalBusinesses: r1.rows[0].c,
    subscriptionsByStatus: Object.fromEntries(r2.rows.map((x) => [x.status, x.c])),
    businessesByPlan: Object.fromEntries(r3.rows.map((x) => [x.tier, x.c])),
    mrrInr: (mrr.rows[0].mrr_paise || 0) / 100,
    arrInr: ((mrr.rows[0].mrr_paise || 0) / 100) * 12,
    signups30d: signups.rows.map((x) => ({ date: x.day, count: x.c })),
    orders30d: gmv.rows[0].orders,
    gmv30dInr: gmv.rows[0].gmv,
  };
}

// ── Impersonation ────────────────────────────────────────────────────────

async function impersonate(businessId) {
  // Issue a short-lived JWT that grants read-only access to the business.
  const r = await query(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  const accessToken = issueAccessToken({
    sub: 'impersonator',
    uid: 'impersonator',
    bid: businessId,
    role: 'business_owner',
    email: r.rows[0].email,
    imp: true,
  });
  return { accessToken, business: r.rows[0] };
}

// ── One-time impersonation handoff codes (NP-126, 2026-09-03) ────────────
//
// The old flow returns the raw tenant JWT to the admin console, which then
// passes it to the dashboard in a URL fragment (#imp=) — leak-prone. The new
// flow mints a single-use 60-second code instead; the dashboard exchanges it
// server-to-server for the SAME token impersonate() issues. Only the SHA-256
// hash of the code is stored, mirroring the refresh-token pattern (utils/jwt).
// The old endpoint stays for back-compat until the web half migrates.

function _hashImpersonationCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Admin-side: mint a one-time code for `businessId`. Returns the raw code ONCE. */
async function createImpersonationCode(businessId, adminUserId) {
  const r = await query(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  const code = crypto.randomBytes(32).toString('base64url'); // 32 bytes entropy
  const ins = await query(
    `INSERT INTO impersonation_codes (code_hash, business_id, admin_user_id, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')
     RETURNING expires_at`,
    [_hashImpersonationCode(code), businessId, adminUserId]
  );
  return { code, expiresAt: ins.rows[0].expires_at };
}

/**
 * Public exchange: claim the code atomically (single UPDATE — two concurrent
 * exchanges can never both win) and issue the exact same read-only tenant
 * token the legacy impersonate() endpoint returns. 401 on unknown / already
 * used / expired codes — one uniform error so callers can't distinguish.
 */
async function exchangeImpersonationCode(code) {
  if (!code || typeof code !== 'string') {
    throw new Unauthorized('Invalid or expired impersonation code');
  }
  const claim = await query(
    `UPDATE impersonation_codes
        SET used_at = NOW()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING business_id`,
    [_hashImpersonationCode(code)]
  );
  if (claim.rowCount === 0) {
    throw new Unauthorized('Invalid or expired impersonation code');
  }
  // Reuse the exact token-issuing path of the legacy flow (short TTL, imp:true).
  return impersonate(claim.rows[0].business_id);
}

module.exports = {
  listCustomers, getCustomer, suspend, restore,
  metrics, impersonate,
  createImpersonationCode, exchangeImpersonationCode,
};
