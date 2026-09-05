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

// ── TENANT-DATA PRIVACY POLICY (2026-09-03, founder-driven) ─────────────
//
// NamastePOS staff must NOT be able to browse a restaurant's own commercial
// data. As the platform we may see:
//   • what the tenant owes US — subscription invoices, plan/limits, dunning,
//     payment status of OUR charges, refunds of OUR charges;
//   • non-identifying volume / health metrics (order counts, GMV, health
//     score, usage counters) needed for support + billing decisions.
// We may NOT see:
//   • the tenant's own sales ledger (individual orders, line items, bills),
//   • their end-customers' (diners') names / phones / emails / loyalty or
//     wallet balances,
//   • their money detail — bank account, e-invoice portal credentials.
// Redaction happens on the SERVER. Do not "helpfully" restore these fields
// because a UI looks empty; the UI is not the control.
//
// Columns on `businesses` that must never leave the admin API:
const TENANT_MONEY_SECRET_COLUMNS = [
  'bank_account', // payout account number — full number enables fraud
  'bank_ifsc', // only useful together with the account number
  'einvoice_user_id', // NIC e-invoice portal login
  'einvoice_password_enc', // encrypted, but still a credential — never ship it
];

/**
 * Strip / mask the tenant's own money detail from a raw `businesses` row.
 * `bank_account` survives as a last-4 hint (`bankAccountLast4`) so support can
 * confirm "yes, the account ending 4321 is the one on file" during a payout
 * ticket without ever seeing the full number.
 * See TENANT-DATA PRIVACY POLICY above before changing this.
 */
function redactBusinessRow(row) {
  if (!row) return row;
  const out = { ...row };
  const acct = row.bank_account ? String(row.bank_account) : '';
  for (const col of TENANT_MONEY_SECRET_COLUMNS) delete out[col];
  out.bankAccountLast4 = acct ? acct.slice(-4) : null;
  out.bankDetailsOnFile = Boolean(acct);
  return out;
}

// ── Customers (businesses) ───────────────────────────────────────────────

/**
 * Shape the outlet-group columns selected by listCustomers / getCustomer into
 * one nullable block. An outlet is its own `businesses` row linked by
 * `businesses.outlet_group_id` → `outlet_groups.parent_business_id`, so the
 * SAME group can contain one HQ and N outlets.
 *   isParent      → this business IS the group's HQ
 *   siblingCount  → other businesses in the group (HQ: how many outlets it has)
 */
function outletBlock(row, businessId) {
  if (!row.outlet_group_id) return null;
  const groupSize = parseInt(row.outlet_group_size, 10) || 1;
  return {
    groupId: row.outlet_group_id,
    groupName: row.outlet_group_name || null,
    isParent: Boolean(row.outlet_parent_business_id
      && String(row.outlet_parent_business_id) === String(businessId)),
    siblingCount: Math.max(0, groupSize - 1),
    parentBusinessId: row.outlet_parent_business_id || null,
    parentName: row.outlet_parent_name || null,
    label: row.outlet_label || null,
  };
}

// Shared SELECT list + JOINs so listCustomers, getCustomer and the drilldown
// all describe an outlet identically. One round trip — the count is a
// correlated subquery, not a second query, because listCustomers is paginated.
const OUTLET_SELECT = `
            b.outlet_group_id,
            b.outlet_label,
            og.name              AS outlet_group_name,
            og.parent_business_id AS outlet_parent_business_id,
            pb.name              AS outlet_parent_name,
            (SELECT COUNT(*) FROM businesses ob
              WHERE ob.outlet_group_id = b.outlet_group_id
                AND ob.deleted_at IS NULL) AS outlet_group_size`;
const OUTLET_JOIN = `
  LEFT JOIN outlet_groups og ON og.id = b.outlet_group_id
  LEFT JOIN businesses pb ON pb.id = og.parent_business_id`;

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
            ${OUTLET_SELECT},
            COUNT(*) OVER ()::int AS _total
       FROM businesses b
  LEFT JOIN subscriptions s ON s.business_id = b.id
  LEFT JOIN plans p ON p.id = s.plan_id
            ${OUTLET_JOIN}
      WHERE ${where.join(' AND ')} AND b.deleted_at IS NULL
   ORDER BY b.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  const total = r.rows[0]?._total ?? 0;

  return {
    customers: r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      city: row.city,
      category: row.category,
      createdAt: row.created_at,
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
      // 2026-09-03 — multi-outlet visibility. null when the tenant is a
      // standalone single-outlet business. totalOrders/totalRevenue above stay
      // AGGREGATES only (allowed by the privacy policy at the top of this
      // file) — never expand this list into per-order rows.
      outlet: outletBlock(row, row.id),
    })),
    total,
    limit,
    offset,
  };
}

async function getCustomer(businessId) {
  const r = await query(
    `SELECT b.*, p.tier AS plan_tier, p.name AS plan_name,
            s.status AS sub_status, s.trial_ends_at, s.current_period_end,
            s.cancel_at_period_end, s.cancelled_at,
            ${OUTLET_SELECT}
       FROM businesses b
  LEFT JOIN subscriptions s ON s.business_id = b.id
  LEFT JOIN plans p ON p.id = s.plan_id
            ${OUTLET_JOIN}
      WHERE b.id = $1 LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  // PRIVACY (see policy at top of file): `SELECT b.*` used to hand every admin
  // with customers.read the tenant's payout bank account + IFSC + e-invoice
  // portal credentials. redactBusinessRow() drops them and leaves a last-4
  // hint. Response shape is otherwise unchanged (extra keys only).
  return { ...redactBusinessRow(r.rows[0]), outlet: outletBlock(r.rows[0], businessId) };
}

/**
 * Outlet siblings for the customer-detail header: every OTHER business in the
 * same group. Deliberately identity-only (id / name / label / isParent) — no
 * revenue, no order counts, nothing commercial.
 */
async function outletSiblings(businessId) {
  const r = await query(
    `SELECT ob.id, ob.name, ob.outlet_label, ob.city,
            (og.parent_business_id = ob.id) AS is_parent
       FROM businesses b
       JOIN outlet_groups og ON og.id = b.outlet_group_id
       JOIN businesses ob ON ob.outlet_group_id = og.id
      WHERE b.id = $1 AND ob.id <> b.id AND ob.deleted_at IS NULL
      ORDER BY is_parent DESC NULLS LAST, ob.name ASC`,
    [businessId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    label: x.outlet_label || null,
    city: x.city || null,
    isParent: Boolean(x.is_parent),
  }));
}

/**
 * Admin suspension (2026-09-05, A6 rewrite).
 *
 * `suspend` used to write status='paused' — the same value the owner's own
 * churn pause uses — so the tenant saw the friendly "paused, resume from
 * Billing" banner and POST /billing/resume undid the suspension. `restore`
 * wrote 'active' unconditionally, so restoring a trialing / lapsed / free
 * tenant activated whatever paid plan_id was on the row, for free.
 *
 * Now: a distinct `suspended` status (enum value added in migration 094) that
 * entitlement (planEntitlement.entitledSql allow-lists active/trialing/
 * past_due only → falls to Starter), blockIfPaused (403 ACCOUNT_SUSPENDED),
 * churn pause/resume, billing resume, plan change and even an incoming
 * gateway charge all refuse to lift. The prior status is parked in
 * `pre_suspend_status` and `restore` returns to exactly that. Both are
 * idempotent (guarded WHERE) and both drop the feature cache so the gates
 * change with the row rather than 60 s later.
 *
 * NOTE: suspend does NOT touch the Razorpay mandate — an admin hold is not a
 * cancellation, and refunding/pausing billing during a hold is a founder
 * decision (see fix report).
 */
async function suspend(businessId) {
  const r = await query(
    `UPDATE subscriptions
        SET pre_suspend_status = status::text,
            suspended_at = NOW(),
            status = 'suspended',
            updated_at = NOW()
      WHERE business_id = $1 AND status <> 'suspended'
      RETURNING id, business_id, status, pre_suspend_status, suspended_at`,
    [businessId],
  );
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return r.rows[0] || null;
}

async function restore(businessId) {
  const r = await query(
    `UPDATE subscriptions
        SET status = COALESCE(pre_suspend_status, 'active')::subscription_status,
            pre_suspend_status = NULL,
            suspended_at = NULL,
            updated_at = NOW()
      WHERE business_id = $1 AND status = 'suspended'
      RETURNING id, business_id, status`,
    [businessId],
  );
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return r.rows[0] || null;
}

// ── Platform metrics ─────────────────────────────────────────────────────

async function metrics() {
  // QA-9 perf #4: parallel queries (Promise.all) — 6 sequential RTTs → 1 RTT.
  const [r1, r2, r3, mrr, signups, gmv] = await Promise.all([
    query('SELECT COUNT(*)::int AS c FROM businesses WHERE deleted_at IS NULL'),
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
  const r = await query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  const accessToken = issueAccessToken({
    sub: 'impersonator',
    uid: 'impersonator',
    bid: businessId,
    role: 'business_owner',
    email: r.rows[0].email,
    imp: true,
  });
  // PRIVACY: this business row is echoed to the ADMIN console (and, via the
  // one-time-code exchange, to the dashboard's bootstrap). `SELECT *` included
  // the tenant's payout bank account + e-invoice credentials; neither caller
  // reads them (the dashboard's Settings page sources bank details from
  // /auth/me). See the policy at the top of this file.
  return { accessToken, business: redactBusinessRow(r.rows[0]) };
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
  const r = await query('SELECT id FROM businesses WHERE id = $1', [businessId]);
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  const code = crypto.randomBytes(32).toString('base64url'); // 32 bytes entropy
  const ins = await query(
    `INSERT INTO impersonation_codes (code_hash, business_id, admin_user_id, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')
     RETURNING expires_at`,
    [_hashImpersonationCode(code), businessId, adminUserId],
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
    [_hashImpersonationCode(code)],
  );
  if (claim.rowCount === 0) {
    throw new Unauthorized('Invalid or expired impersonation code');
  }
  // Reuse the exact token-issuing path of the legacy flow (short TTL, imp:true).
  return impersonate(claim.rows[0].business_id);
}

module.exports = {
  listCustomers,
  getCustomer,
  suspend,
  restore,
  metrics,
  impersonate,
  createImpersonationCode,
  exchangeImpersonationCode,
  // Shared by customerAdminService.drilldown so the outlet block and the
  // money-detail redaction are described in exactly one place.
  outletBlock,
  outletSiblings,
  redactBusinessRow,
  OUTLET_SELECT,
  OUTLET_JOIN,
  TENANT_MONEY_SECRET_COLUMNS,
};
