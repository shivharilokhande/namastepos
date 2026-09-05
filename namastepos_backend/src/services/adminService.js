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
 * MANDATE (round-2 fix batch 2026-09-06, founder decision, CONTRACTS §5/§6):
 * suspend now also cancels the Razorpay mandate AT CYCLE END when the row has
 * one — a suspended tenant must not keep being debited for a service they
 * cannot use, and the days already paid for are not refunded (no refunds).
 * The cancellation is recorded the same way the owner's own cancel is
 * (`cancel_at_period_end = TRUE`, `cancelled_at`), which is what every other
 * path already understands: _onChargeSuccess refuses a stray charge on the
 * old mandate, and the nightly sweep closes the row once the period has
 * lapsed. A lifecycle row (`suspended`, meta.mandateCancelled) is the audit
 * trail. Best-effort at the gateway: a Razorpay error never blocks the hold.
 *
 * restore of a PAID plan whose mandate is gone does NOT flip the row to
 * `active` (that was the A1 hole in a new shape — a free paid plan for as long
 * as nobody looked). It reuses the resume plumbing from round 1:
 *   • paid period still running → `active` + cancel flag kept (they own those
 *     days), and a fresh createSubscription() whose first charge is at the
 *     period end; the flag clears in _onChargeSuccess via the reactivation
 *     marker. The tenant's own POST /billing/resume returns the same checkout.
 *   • paid period already lapsed → `cancelled` + a checkout charging now; the
 *     first charge reactivates (A1 "rebuy" path).
 *   • no gateway configured (non-prod manual mode) → restored to the parked
 *     status with the flag cleared, as nothing can be billed anyway.
 * Either way the reply carries `{ requiresCheckout: true, checkout }` — the
 * admin console tells the founder the tenant has to re-authorise payment; the
 * tenant sees it under /billing (`reactivationPending`, `cancelAtPeriodEnd`).
 */
async function suspend(businessId) {
  const cur = (await query(
    `SELECT s.id, s.status, s.razorpay_subscription_id, s.cancel_at_period_end,
            p.price_inr_paise, p.tier AS plan_tier
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1 LIMIT 1`,
    [businessId],
  )).rows[0];
  if (!cur || cur.status === 'suspended') return null;

  // A live mandate on a paid plan: stop future debits (cycle end, no refund).
  const hasMandate = !!cur.razorpay_subscription_id && Number(cur.price_inr_paise) > 0;
  let mandate = { cancelled: false, reason: 'no_gateway_subscription' };
  if (hasMandate && !cur.cancel_at_period_end) {
    try {
      mandate = await require('./razorpayService').cancelSubscription(businessId, { atCycleEnd: true });
    } catch (e) {
      mandate = { cancelled: false, reason: 'gateway_error', error: e.message };
      require('../config/logger').warn(`[suspend] gateway cancel failed for ${businessId}: ${e.message}`);
    }
  }
  const r = await query(
    `UPDATE subscriptions
        SET pre_suspend_status = status::text,
            suspended_at = NOW(),
            status = 'suspended',
            cancel_at_period_end = CASE WHEN $2::boolean THEN TRUE ELSE cancel_at_period_end END,
            cancelled_at = CASE WHEN $2::boolean THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
            updated_at = NOW()
      WHERE business_id = $1 AND status <> 'suspended'
      RETURNING id, business_id, status, pre_suspend_status, suspended_at,
                cancel_at_period_end, current_period_end`,
    // The flag records INTENT ("this mandate is not to renew"), so it is set
    // whenever a mandate existed — even if the gateway call failed, the
    // reactivation guard then protects against the stray charge.
    [businessId, hasMandate],
  );
  const row = r.rows[0] || null;
  if (row) {
    try {
      await require('./churnService').logLifecycle(null, {
        businessId,
        subscriptionId: row.id,
        event: 'suspended',
        fromStatus: cur.status,
        toStatus: 'suspended',
        planTier: cur.plan_tier || null,
        meta: { via: 'admin', mandateCancelled: mandate.cancelled === true, mandate },
      });
    } catch (_) { /* trail is non-fatal */ }
  }
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return row ? { ...row, mandate } : null;
}

async function restore(businessId) {
  const cur = (await query(
    `SELECT s.*, p.price_inr_paise, p.tier AS plan_tier
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1 AND s.status = 'suspended' LIMIT 1`,
    [businessId],
  )).rows[0];
  if (!cur) return null;

  const target = cur.pre_suspend_status || 'active';
  const paid = Number(cur.price_inr_paise) > 0;
  // "Mandate gone" = the cancel flag is up on a row that had a gateway sub:
  // suspend() put it there, or the owner had cancelled before the hold.
  const mandateGone = cur.cancel_at_period_end === true && !!cur.razorpay_subscription_id;
  const needsCheckout = paid && mandateGone && ['active', 'past_due'].includes(target);

  const logRestored = async (toStatus, meta) => {
    try {
      await require('./churnService').logLifecycle(null, {
        businessId,
        subscriptionId: cur.id,
        event: 'restored',
        fromStatus: 'suspended',
        toStatus,
        planTier: cur.plan_tier || null,
        meta: { via: 'admin', ...meta },
      });
    } catch (_) { /* trail is non-fatal */ }
  };

  if (!needsCheckout) {
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
    const row = r.rows[0] || null;
    if (row) await logRestored(row.status, { requiresCheckout: false });
    return row ? { ...row, requiresCheckout: false } : null;
  }

  const rzp = require('./razorpayService');
  const mode = rzp.checkoutMode({ requireLive: true }); // plan-level rule
  if (mode === 'unavailable') throw rzp.paymentsUnavailableError();
  if (mode === 'manual') {
    // Non-prod without a gateway: nothing can be billed, so the row goes back
    // to where it was with the cancel flag cleared (mirrors the manual branch
    // of subscriptionService.resume).
    const r = await query(
      `UPDATE subscriptions
          SET status = COALESCE(pre_suspend_status, 'active')::subscription_status,
              pre_suspend_status = NULL,
              suspended_at = NULL,
              cancel_at_period_end = FALSE,
              cancelled_at = NULL,
              updated_at = NOW()
        WHERE business_id = $1 AND status = 'suspended'
        RETURNING id, business_id, status`,
      [businessId],
    );
    try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
    const row = r.rows[0] || null;
    if (row) await logRestored(row.status, { requiresCheckout: false, mode });
    return row ? { ...row, requiresCheckout: false } : null;
  }

  const periodEndMs = cur.current_period_end ? new Date(cur.current_period_end).getTime() : 0;
  const periodRunning = periodEndMs > Date.now();
  const r = await query(
    periodRunning
      ? `UPDATE subscriptions
            SET status = 'active',
                pre_suspend_status = NULL,
                suspended_at = NULL,
                updated_at = NOW()
          WHERE business_id = $1 AND status = 'suspended'
          RETURNING id, business_id, status, cancel_at_period_end, current_period_end`
      : `UPDATE subscriptions
            SET status = 'cancelled',
                cancelled_at = COALESCE(cancelled_at, NOW()),
                pre_suspend_status = NULL,
                suspended_at = NULL,
                updated_at = NOW()
          WHERE business_id = $1 AND status = 'suspended'
          RETURNING id, business_id, status, cancel_at_period_end, current_period_end`,
    [businessId],
  );
  const row = r.rows[0] || null;
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  if (!row) return null;
  // The checkout: first charge at the period end while it is still paid for,
  // now otherwise. createSubscription stamps the reactivation marker.
  const checkout = await rzp.createSubscription(businessId, cur.plan_tier, {
    billingPeriod: cur.billing_period || 'monthly',
    startAt: periodRunning ? cur.current_period_end : null,
  });
  await logRestored(row.status, { requiresCheckout: true, periodRunning, checkoutSubscriptionId: checkout.subscriptionId });
  return {
    ...row,
    requiresCheckout: true,
    checkout,
    message: periodRunning
      ? `Restored. The payment mandate was cancelled during the suspension; the plan is paid up to ${new Date(cur.current_period_end).toLocaleDateString('en-IN')} and the owner must set up payment again from Billing to keep it after that.`
      : 'Restored as cancelled: the paid period ended during the suspension. The owner must complete checkout from Billing to reactivate the plan.',
  };
}

// ── Review checks (round-2 fix batch 2026-09-06, CONTRACTS §5) ────────────
//
// The 2026-09-05 code review left eight "run this read-only query on prod
// after deploy" instructions scattered across reports. Nobody runs those twice.
// This turns them into one super-admin endpoint (GET /admin/ops/review-checks)
// that runs every check, returns the count, a sample (≤ 20 rows) and — on
// purpose — the SQL it ran, so the founder can paste it into psql when the
// number looks wrong. Read-only; nothing here writes.

const REVIEW_SAMPLE_LIMIT = 20;

const REVIEW_CHECK_SQL = Object.freeze({
  zero_gst_invoices: `SELECT id, business_id, invoice_no, invoice_date, total_paise, reverse_charge
  FROM tax_invoices
 WHERE cgst_paise + sgst_paise + igst_paise = 0 AND total_paise > 0
 ORDER BY invoice_date DESC`,
  stub_irns: `SELECT id, business_id, irn, status, created_at
  FROM einvoice_irns
 WHERE is_stub
 ORDER BY created_at DESC`,
  aggregator_without_key: `SELECT business_id, provider, is_active, updated_at
  FROM aggregator_credentials
 WHERE is_active = TRUE
 ORDER BY updated_at DESC`,
  lapsed_cancel_rows: `SELECT business_id, status, cancel_at_period_end, current_period_end
  FROM subscriptions
 WHERE status = 'active' AND cancel_at_period_end AND current_period_end < NOW() - INTERVAL '3 days'
 ORDER BY current_period_end`,
  suspended_tenants: `SELECT s.business_id, b.name, s.pre_suspend_status, s.suspended_at, s.cancel_at_period_end
  FROM subscriptions s JOIN businesses b ON b.id = s.business_id
 WHERE s.status = 'suspended'
 ORDER BY s.suspended_at DESC NULLS LAST`,
  plans_with_unenforced_keys: `SELECT pf.tier_kind AS plan_code, p.name AS plan_name, p.is_public, p.is_active, pf.feature_key
  FROM plan_features pf LEFT JOIN plans p ON p.tier = pf.tier_kind
 WHERE pf.feature_key = ANY($1)
 ORDER BY pf.tier_kind, pf.feature_key`,
});

async function _sampled(sql, params = []) {
  const r = await query(sql, params);
  return { count: r.rowCount, sample: r.rows.slice(0, REVIEW_SAMPLE_LIMIT) };
}

async function reviewChecks() {
  const env = require('../config/env');
  const registry = require('../config/featureRegistry');
  const features = require('./featureService');
  const checks = [];
  const push = (c) => checks.push(c);

  // 1. ₹0-GST tax invoices with a non-zero total (code review 2026-09-05:
  //    omitted tax used to be written as 0 instead of the server GST).
  {
    const { count, sample } = await _sampled(REVIEW_CHECK_SQL.zero_gst_invoices);
    push({
      id: 'zero_gst_invoices',
      label: 'Tax invoices with ₹0 GST and a non-zero total',
      severity: count > 0 ? 'warn' : 'info',
      count,
      description: 'A GST tax invoice whose CGST+SGST+IGST is zero while the total is not. Legitimate only for exempt / nil-rated supplies; otherwise the tax was omitted at issue time.',
      sql: REVIEW_CHECK_SQL.zero_gst_invoices,
      sample,
    });
  }
  // 2. Stub IRNs (migration 093).
  {
    const { count, sample } = await _sampled(REVIEW_CHECK_SQL.stub_irns);
    push({
      id: 'stub_irns',
      label: 'E-invoice IRNs never filed with the IRP (stubs)',
      severity: count > 0 ? 'critical' : 'info',
      count,
      description: 'einvoice_irns rows flagged is_stub by migration 093: plausible-looking IRNs that were never registered with the government portal. Tenants holding these must be told; the numbers are not valid for GST.',
      sql: REVIEW_CHECK_SQL.stub_irns,
      sample: sample.map((r) => ({ ...r, irn: r.irn ? `${String(r.irn).slice(0, 12)}…` : null })),
    });
  }
  // 3. Aggregator credentials on a plan without `aggregators`.
  {
    const r = await query(REVIEW_CHECK_SQL.aggregator_without_key);
    const offending = [];
    for (const row of r.rows) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await features.hasFeature(row.business_id, 'aggregators');
      if (!ok) offending.push(row);
    }
    push({
      id: 'aggregator_without_key',
      label: 'Active aggregator credentials on a plan without the aggregators feature',
      severity: offending.length > 0 ? 'warn' : 'info',
      count: offending.length,
      description: 'aggregator_credentials rows still active for a business whose effective plan (plan ∪ addons ∪ overrides) no longer includes `aggregators`. Ingestion for these is refused by the feature gate; the rows should be disabled or the tenant upgraded.',
      sql: `${REVIEW_CHECK_SQL.aggregator_without_key}\n-- then, per row: featureService.hasFeature(business_id, 'aggregators') = false`,
      sample: offending.slice(0, REVIEW_SAMPLE_LIMIT),
    });
  }
  // 4. Cancel-at-period-end rows whose period lapsed > 3 days ago.
  {
    const { count, sample } = await _sampled(REVIEW_CHECK_SQL.lapsed_cancel_rows);
    push({
      id: 'lapsed_cancel_rows',
      label: 'Cancelled-at-period-end subscriptions still active 3+ days after the period ended',
      severity: count > 0 ? 'warn' : 'info',
      count,
      description: 'The nightly sweep (subscriptionService.sweepPeriodEndTransitions) moves these to cancelled; a non-zero count means the sweep has not run or is failing.',
      sql: REVIEW_CHECK_SQL.lapsed_cancel_rows,
      sample,
    });
  }
  // 5. Suspended tenants.
  {
    const { count, sample } = await _sampled(REVIEW_CHECK_SQL.suspended_tenants);
    push({
      id: 'suspended_tenants',
      label: 'Suspended tenants',
      severity: 'info',
      count,
      description: 'Subscriptions in the admin-imposed `suspended` state. Each one is a support decision awaiting restore; their Razorpay mandate was cancelled at cycle end on suspend.',
      sql: REVIEW_CHECK_SQL.suspended_tenants,
      sample,
    });
  }
  // 6. DB TLS verification.
  {
    const verified = process.env.DB_SSL_VERIFY === 'true' || !!process.env.PG_CA_CERT;
    push({
      id: 'db_ssl_unverified',
      label: 'Database TLS certificate not verified',
      severity: verified ? 'info' : (env.isProd() ? 'critical' : 'warn'),
      count: verified ? 0 : 1,
      description: 'Neither DB_SSL_VERIFY=true nor PG_CA_CERT is set, so the Postgres connection accepts any certificate (config/db.js). Set PG_CA_CERT to the provider CA bundle on Render.',
      sql: null,
      sample: [{ DB_SSL_VERIFY: process.env.DB_SSL_VERIFY || null, PG_CA_CERT: process.env.PG_CA_CERT ? '(set)' : null }],
    });
  }
  // 7. Order tax enforcement mode.
  {
    const mode = env.ORDER_TAX_ENFORCE || 'log';
    push({
      id: 'order_tax_mode',
      label: 'ORDER_TAX_ENFORCE mode',
      severity: mode === 'enforce' ? 'info' : 'warn',
      count: mode === 'enforce' ? 0 : 1,
      description: 'Server-side order GST is only logged (not enforced) until ORDER_TAX_ENFORCE=enforce is set on Render. Flip it after ~1 week of clean logs (system review 2026-09-01).',
      sql: null,
      sample: [{ ORDER_TAX_ENFORCE: mode }],
    });
  }
  // 8. Plan lines nothing enforces.
  {
    const ungated = registry.keysWithEnforcement('ungated');
    const known = new Set(registry.keys());
    const stray = (await query('SELECT DISTINCT feature_key FROM plan_features')).rows
      .map((r) => r.feature_key).filter((k) => k && !known.has(k));
    const keys = [...new Set([...ungated, ...stray])];
    const { count, sample } = keys.length
      ? await _sampled(REVIEW_CHECK_SQL.plans_with_unenforced_keys, [keys])
      : { count: 0, sample: [] };
    push({
      id: 'plans_with_unenforced_keys',
      label: 'Plan features sold but enforced nowhere',
      severity: count > 0 ? 'warn' : 'info',
      count,
      description: `plan_features rows for keys the registry declares enforcement:'ungated' (${ungated.join(', ') || 'none'})${stray.length ? ` plus unregistered keys (${stray.join(', ')})` : ''}. Each is a plan-card line the product does not keep; see the registry entry's \`why\`.`,
      sql: REVIEW_CHECK_SQL.plans_with_unenforced_keys.replace('$1', `ARRAY[${keys.map((k) => `'${k}'`).join(', ')}]`),
      sample,
    });
  }
  return { generatedAt: new Date().toISOString(), checks };
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
  reviewChecks,
  REVIEW_CHECK_SQL,
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
