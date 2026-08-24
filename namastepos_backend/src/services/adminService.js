// NamastePOS backend - super admin service

const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const env = require('../config/env');
const {
  issueAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
} = require('../utils/jwt');
const { Unauthorized, NotFound } = require('../utils/errors');

const SALT_ROUNDS = 10;
const twoFactor = require('./twoFactorService');

// ── Admin login ──────────────────────────────────────────────────────────

async function ensureBootstrapAdmin() {
  // Hardcode-audit fix (2026-08-24): both halves of the credential must
  // be explicitly configured — SUPER_ADMIN_EMAIL no longer has a
  // predictable default.
  if (!env.SUPER_ADMIN_PASSWORD || !env.SUPER_ADMIN_EMAIL) return null;
  const r = await query(
    `SELECT id FROM super_admins WHERE email = $1`, [env.SUPER_ADMIN_EMAIL]
  );
  if (r.rowCount > 0) return r.rows[0];
  const hash = await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, SALT_ROUNDS);
  const ins = await query(
    `INSERT INTO super_admins (email, password_hash, display_name)
     VALUES ($1, $2, 'Founding Admin') RETURNING *`,
    [env.SUPER_ADMIN_EMAIL, hash]
  );
  return ins.rows[0];
}

async function login(email, password, { userAgent, ip } = {}) {
  await ensureBootstrapAdmin();
  const r = await query(
    `SELECT * FROM super_admins WHERE email = $1 AND is_active = TRUE LIMIT 1`,
    [email]
  );
  if (r.rowCount === 0) throw new Unauthorized('Invalid credentials');
  const admin = r.rows[0];
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) throw new Unauthorized('Invalid credentials');

  // QA-8 P1 (Lakshmi #7): if 2FA is enrolled on the corresponding admin_users
  // row, return a challenge instead of an access token. (Note: super_admins
  // is the legacy table; admin_users is the new RBAC team table — we look up
  // by email so this works for both.)
  const ar = await query(
    `SELECT id FROM admin_users WHERE email = $1 AND is_active = TRUE LIMIT 1`,
    [email]
  );
  if (ar.rowCount > 0 && await twoFactor.isEnrolled(ar.rows[0].id)) {
    const { challengeId } = await twoFactor.startChallenge(ar.rows[0].id);
    return { requires2fa: true, challengeId };
  }

  await query(`UPDATE super_admins SET last_login_at = NOW() WHERE id = $1`, [admin.id]);
  const accessToken = issueAccessToken({
    sub: admin.id, sid: admin.id, isSuperAdmin: true, email: admin.email,
  });
  return { accessToken, admin: serialize(admin) };
}

// QA-8 P1: second step of the 2FA login — exchange a verified challenge for
// a real access token.
async function complete2faLogin(challengeId, code) {
  const { adminId } = await twoFactor.verifyChallenge(challengeId, code);
  const ar = await query(
    `SELECT au.email, sa.id AS sa_id
       FROM admin_users au
  LEFT JOIN super_admins sa ON sa.email = au.email
      WHERE au.id = $1`,
    [adminId]
  );
  if (ar.rowCount === 0) throw new Unauthorized('Admin not found');
  const adminEmail = ar.rows[0].email;
  const sid = ar.rows[0].sa_id || adminId;

  await query(`UPDATE super_admins SET last_login_at = NOW() WHERE id = $1`, [sid]);
  const accessToken = issueAccessToken({
    sub: sid, sid, isSuperAdmin: true, email: adminEmail,
  });
  return { accessToken };
}

function serialize(a) {
  return {
    id: a.id, email: a.email, displayName: a.display_name,
    lastLoginAt: a.last_login_at, createdAt: a.created_at,
  };
}

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

module.exports = {
  ensureBootstrapAdmin, login, complete2faLogin,
  listCustomers, getCustomer, suspend, restore,
  metrics, impersonate,
};
