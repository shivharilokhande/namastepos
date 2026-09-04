// NamastePOS backend — platform ops service (super-admin control plane).
//
// Everything the admin console needs to run NamastePOS as a SaaS business
// rather than a database viewer:
//
//   overview()          — the home dashboard: MRR/ARR, subscription mix,
//                         signups, churn, revenue MTD, plan distribution,
//                         addon attach rate, open tickets, failed payments,
//                         plus a "needs attention" work queue.
//   usageForBusiness()  — one tenant's usage vs its plan limits.
//   platformUsage()     — the same, every tenant, over-limit first.
//   dunningQueue()      — past-due subscriptions with recovery context.
//   dunningTimeline()   — one tenant's dunning event history.
//   notificationLog()   — platform → tenant emails already recorded in
//                         email_dispatch_log.
//   platformHealth()    — read-only ops panel (DB latency, Redis, cron,
//                         migrations, webhook failures).
//
// Design notes
//   • Every aggregate is either a single round trip (scalar subqueries in one
//     SELECT) or a small Promise.all — the admin home must never fan out into
//     a dozen sequential queries.
//   • MRR is computed with the SAME formula adminService.metrics() uses (sum
//     of active paid plan prices) so the two surfaces can never disagree.
//   • Tables that may not exist on an older schema (addon_invoices) are
//     wrapped in try/catch and degrade to zero, matching the defensive style
//     in platformReportsService.

const { query } = require('../config/db');
const logger = require('../config/logger');
const env = require('../config/env');
const { NotFound, BadRequest } = require('../utils/errors');

const PAISE = 100;

// ── Overview / home dashboard ────────────────────────────────────────────

/**
 * SaaS vitals in (effectively) two round trips: one wide scalar SELECT plus
 * one Promise.all of the grouped/series bits.
 *
 * Returns:
 * {
 *   mrrInr, arrInr,
 *   counts: { customers, active, trialing, pastDue, paused, cancelled,
 *             signups7d, signups30d, churned30d, openTickets, p1Tickets,
 *             failedPayments24h, pendingRefunds },
 *   revenue: { thisMonthInr, lastMonthInr, refundsThisMonthInr },
 *   addons:  { activeActivations, tenantsWithAddon, attachRatePct },
 *   plans:   [{ tier, name, count }],
 *   signupTrend: [{ date, count }],   // 30 days, zero-filled
 *   mrrTrend:    [{ month, inr }],    // 6 months of paid invoices
 *   needsAttention: [{ kind, severity, businessId, businessName, label, detail, at }]
 * }
 */
async function overview() {
  const [scalars, plans, signups, mrrSeries, attention, addons] = await Promise.all([
    _overviewScalars(),
    _planDistribution(),
    _signupTrend(30),
    _paidInvoiceTrend(6),
    needsAttention({ limit: 25 }),
    _addonAttach(),
  ]);

  const mrrInr = scalars.mrr_paise / PAISE;
  return {
    mrrInr,
    arrInr: mrrInr * 12,
    counts: {
      customers: scalars.customers,
      active: scalars.subs_active,
      trialing: scalars.subs_trialing,
      pastDue: scalars.subs_past_due,
      paused: scalars.subs_paused,
      cancelled: scalars.subs_cancelled,
      signups7d: scalars.signups_7d,
      signups30d: scalars.signups_30d,
      churned30d: scalars.churned_30d,
      openTickets: scalars.tickets_open,
      p1Tickets: scalars.tickets_p1,
      failedPayments24h: scalars.failed_payments_24h,
      pendingRefunds: scalars.refunds_pending,
      orders30d: scalars.orders_30d,
    },
    revenue: {
      thisMonthInr: scalars.rev_mtd_paise / PAISE,
      lastMonthInr: scalars.rev_prev_paise / PAISE,
      refundsThisMonthInr: scalars.refund_mtd_paise / PAISE,
      gmv30dInr: scalars.gmv_30d,
    },
    addons,
    plans,
    signupTrend: signups,
    mrrTrend: mrrSeries,
    needsAttention: attention,
  };
}

// One round trip for every scalar on the home dashboard. All predicates hit
// indexed columns (subscriptions.status, businesses.created_at, invoices
// .status/created_at, refunds.status, support_tickets.status).
async function _overviewScalars() {
  const r = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM businesses WHERE deleted_at IS NULL)            AS customers,
      (SELECT COUNT(*)::int FROM businesses
        WHERE deleted_at IS NULL AND created_at > NOW() - INTERVAL '7 days')     AS signups_7d,
      (SELECT COUNT(*)::int FROM businesses
        WHERE deleted_at IS NULL AND created_at > NOW() - INTERVAL '30 days')    AS signups_30d,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active')          AS subs_active,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'trialing')        AS subs_trialing,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'past_due')        AS subs_past_due,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'paused')          AS subs_paused,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'cancelled')       AS subs_cancelled,
      (SELECT COUNT(*)::int FROM subscriptions
        WHERE status = 'cancelled'
          AND cancelled_at > NOW() - INTERVAL '30 days')                         AS churned_30d,
      -- MRR: identical formula to adminService.metrics() so the two agree.
      (SELECT COALESCE(SUM(p.price_inr_paise), 0)::bigint
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.status = 'active' AND p.price_inr_paise > 0)                     AS mrr_paise,
      (SELECT COALESCE(SUM(amount_paise), 0)::bigint FROM invoices
        WHERE status = 'paid'
          AND created_at >= date_trunc('month', NOW()))                          AS rev_mtd_paise,
      (SELECT COALESCE(SUM(amount_paise), 0)::bigint FROM invoices
        WHERE status = 'paid'
          AND created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
          AND created_at <  date_trunc('month', NOW()))                          AS rev_prev_paise,
      (SELECT COALESCE(SUM(amount_paise), 0)::bigint FROM refunds
        WHERE status = 'processed'
          AND created_at >= date_trunc('month', NOW()))                          AS refund_mtd_paise,
      (SELECT COUNT(*)::int FROM refunds WHERE status = 'pending')               AS refunds_pending,
      (SELECT COUNT(*)::int FROM dunning_events
        WHERE event IN ('payment_failed', 'halted')
          AND created_at > NOW() - INTERVAL '24 hours')                          AS failed_payments_24h,
      -- 'open' + 'pending' are the states still owned by us; 'resolved' and
      -- 'closed' are done (support_ticket_status enum, migration 066).
      (SELECT COUNT(*)::int FROM support_tickets
        WHERE status IN ('open', 'pending'))                                     AS tickets_open,
      (SELECT COUNT(*)::int FROM support_tickets
        WHERE status IN ('open', 'pending')
          AND priority IN ('critical', 'high'))                                  AS tickets_p1,
      (SELECT COUNT(*)::int FROM orders
        WHERE created_at > NOW() - INTERVAL '30 days' AND status <> 'cancelled') AS orders_30d,
      (SELECT COALESCE(SUM(total), 0)::float FROM orders
        WHERE created_at > NOW() - INTERVAL '30 days' AND status <> 'cancelled') AS gmv_30d
  `);
  return r.rows[0];
}

// Currently-paying tenants per plan (active + trialing only — a stale
// cancelled row must not inflate a tier, same fix as metrics()).
async function _planDistribution() {
  const r = await query(`
    SELECT p.tier, p.name, COUNT(*)::int AS c
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.status IN ('active', 'trialing')
     GROUP BY p.tier, p.name
     ORDER BY c DESC
  `);
  return r.rows.map((x) => ({ tier: x.tier, name: x.name, count: x.c }));
}

// Zero-filled so the sparkline has one point per day even on quiet days.
async function _signupTrend(days = 30) {
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
  const r = await query(`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COALESCE(b.c, 0)::int AS count
      FROM generate_series(
             date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day',
             date_trunc('day', NOW()),
             INTERVAL '1 day') AS d(day)
      LEFT JOIN (
        SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS c
          FROM businesses
         WHERE deleted_at IS NULL
           AND created_at > NOW() - ($1::int || ' days')::interval
         GROUP BY 1
      ) b ON b.day = d.day
     ORDER BY d.day
  `, [n]);
  return r.rows;
}

async function _paidInvoiceTrend(months = 6) {
  const n = Math.min(Math.max(parseInt(months, 10) || 6, 1), 24);
  const r = await query(`
    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           COALESCE(SUM(amount_paise), 0)::bigint AS p
      FROM invoices
     WHERE status = 'paid'
       AND created_at > date_trunc('month', NOW()) - ($1::int || ' months')::interval
     GROUP BY 1 ORDER BY 1
  `, [n]);
  return r.rows.map((x) => ({ month: x.month, inr: Number(x.p) / PAISE }));
}

// Attach rate = tenants with at least one live add-on ÷ tenants with a live
// subscription. The denominator excludes churned/deleted tenants so the rate
// doesn't drift up as old rows accumulate.
async function _addonAttach() {
  const r = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM business_addons
        WHERE status IN ('active', 'trialing'))                     AS activations,
      (SELECT COUNT(DISTINCT ba.business_id)::int FROM business_addons ba
         JOIN businesses b ON b.id = ba.business_id AND b.deleted_at IS NULL
        WHERE ba.status IN ('active', 'trialing'))                   AS tenants_with,
      (SELECT COUNT(*)::int FROM subscriptions s
         JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        WHERE s.status IN ('active', 'trialing'))                    AS live_tenants
  `);
  const row = r.rows[0];
  const rate = row.live_tenants > 0
    ? Math.round((row.tenants_with / row.live_tenants) * 1000) / 10
    : 0;
  return {
    activeActivations: row.activations,
    tenantsWithAddon: row.tenants_with,
    liveTenants: row.live_tenants,
    attachRatePct: rate,
  };
}

/**
 * The work queue: everything a human should look at today, newest/worst
 * first. Deliberately capped per source so one noisy category can't bury
 * the others.
 *
 * kinds: past_due | stuck_refund | expiring_addon | p1_ticket | trial_ending
 */
async function needsAttention({ limit = 25 } = {}) {
  const per = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 50);
  const [pastDue, refunds, addons, tickets, trials] = await Promise.all([
    query(`
      SELECT s.business_id, b.name, s.dunning_attempts, s.last_dunning_at,
             p.name AS plan_name, p.price_inr_paise
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.status = 'past_due'
       ORDER BY s.dunning_attempts DESC NULLS LAST, s.last_dunning_at ASC NULLS LAST
       LIMIT $1`, [per]),
    // A gateway refund still 'pending' after 48h means the reconciler never
    // saw a terminal state — real money is in limbo.
    query(`
      SELECT r.id, r.business_id, b.name, r.amount_paise, r.created_at
        FROM refunds r
        LEFT JOIN businesses b ON b.id = r.business_id
       WHERE r.status = 'pending'
         AND r.created_at < NOW() - INTERVAL '48 hours'
       ORDER BY r.created_at ASC
       LIMIT $1`, [per]),
    query(`
      SELECT ba.business_id, b.name, a.name AS addon_name, ba.current_period_end, ba.status
        FROM business_addons ba
        JOIN addons a     ON a.id = ba.addon_id
        JOIN businesses b ON b.id = ba.business_id AND b.deleted_at IS NULL
       WHERE ba.status IN ('active', 'trialing')
         AND ba.cancel_at_period_end = FALSE
         AND ba.current_period_end BETWEEN NOW() - INTERVAL '1 day'
                                       AND NOW() + INTERVAL '7 days'
       ORDER BY ba.current_period_end ASC
       LIMIT $1`, [per]),
    query(`
      SELECT t.id, t.business_id, b.name, t.subject, t.priority, t.created_at, t.last_reply_at
        FROM support_tickets t
        LEFT JOIN businesses b ON b.id = t.business_id
       WHERE t.status IN ('open', 'pending')
         AND t.priority IN ('critical', 'high')
       ORDER BY t.created_at ASC
       LIMIT $1`, [per]),
    query(`
      SELECT s.business_id, b.name, s.trial_ends_at, p.name AS plan_name
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.status = 'trialing'
         AND s.trial_ends_at IS NOT NULL
         AND s.trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
       ORDER BY s.trial_ends_at ASC
       LIMIT $1`, [per]),
  ]);

  const out = [];
  for (const x of pastDue.rows) {
    out.push({
      kind: 'past_due',
      severity: (x.dunning_attempts || 0) >= 3 ? 'critical' : 'high',
      businessId: x.business_id,
      businessName: x.name,
      label: `Past due · ${x.dunning_attempts || 0} failed attempt(s)`,
      detail: `${x.plan_name || 'plan'} · ₹${((x.price_inr_paise || 0) / PAISE).toFixed(0)}/mo`,
      at: x.last_dunning_at,
    });
  }
  for (const x of refunds.rows) {
    out.push({
      kind: 'stuck_refund',
      severity: 'critical',
      businessId: x.business_id,
      businessName: x.name,
      label: `Refund pending > 48h · ₹${(x.amount_paise / PAISE).toFixed(0)}`,
      detail: `Refund ${String(x.id).slice(0, 8)} never reached a terminal state`,
      at: x.created_at,
    });
  }
  for (const x of tickets.rows) {
    out.push({
      kind: 'p1_ticket',
      severity: x.priority === 'critical' ? 'critical' : 'high',
      businessId: x.business_id,
      businessName: x.name,
      label: `${x.priority} ticket · ${x.subject}`,
      detail: x.last_reply_at ? 'Awaiting follow-up' : 'No reply yet',
      at: x.created_at,
    });
  }
  for (const x of addons.rows) {
    out.push({
      kind: 'expiring_addon',
      severity: 'medium',
      businessId: x.business_id,
      businessName: x.name,
      label: `Add-on expiring · ${x.addon_name}`,
      detail: x.status === 'trialing' ? 'Add-on trial ending' : 'Renewal due',
      at: x.current_period_end,
    });
  }
  for (const x of trials.rows) {
    out.push({
      kind: 'trial_ending',
      severity: 'medium',
      businessId: x.business_id,
      businessName: x.name,
      label: 'Trial ends within 3 days',
      detail: x.plan_name || 'trial',
      at: x.trial_ends_at,
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => (rank[a.severity] - rank[b.severity])
    || (new Date(a.at || 0) - new Date(b.at || 0)));
  return out;
}

// ── Usage vs plan limits ─────────────────────────────────────────────────

// The metrics enforceLimit() actually gates on. Keep this list in sync with
// subscriptionService.enforceLimit — a metric here with no counter there is a
// number nobody enforces.
const USAGE_METRICS = ['staff', 'tables', 'floors', 'menu_items', 'monthly_orders'];

function _period() { return new Date().toISOString().slice(0, 7); }

/** Per-tenant usage vs limits. One round trip. */
async function usageForBusiness(businessId) {
  const r = await query(`
    SELECT b.id, b.name, s.status, p.tier, p.name AS plan_name, p.limits,
      (SELECT COUNT(*)::int FROM business_users bu
        WHERE bu.business_id = b.id AND bu.is_active = TRUE
          AND bu.role <> 'business_owner')                             AS staff,
      (SELECT COUNT(*)::int FROM tables t WHERE t.business_id = b.id)  AS tables,
      (SELECT COUNT(*)::int FROM floors f WHERE f.business_id = b.id)  AS floors,
      (SELECT COUNT(*)::int FROM menu_items m
        WHERE m.business_id = b.id AND m.is_active = TRUE)             AS menu_items,
      (SELECT COALESCE(uc.count, 0)::int FROM usage_counters uc
        WHERE uc.business_id = b.id AND uc.metric = 'monthly_orders'
          AND uc.period = $2)                                          AS monthly_orders
      FROM businesses b
      LEFT JOIN subscriptions s ON s.business_id = b.id
      LEFT JOIN plans p         ON p.id = s.plan_id
     WHERE b.id = $1
     LIMIT 1
  `, [businessId, _period()]);
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return _shapeUsage(r.rows[0]);
}

/**
 * Platform-wide usage table. Sorted worst-first (most over-limit metrics,
 * then highest utilisation) so the sales/support team sees upsell candidates
 * without paging.
 */
async function platformUsage({ overLimitOnly = false, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const r = await query(`
    SELECT b.id, b.name, s.status, p.tier, p.name AS plan_name, p.limits,
      (SELECT COUNT(*)::int FROM business_users bu
        WHERE bu.business_id = b.id AND bu.is_active = TRUE
          AND bu.role <> 'business_owner')                             AS staff,
      (SELECT COUNT(*)::int FROM tables t WHERE t.business_id = b.id)  AS tables,
      (SELECT COUNT(*)::int FROM floors f WHERE f.business_id = b.id)  AS floors,
      (SELECT COUNT(*)::int FROM menu_items m
        WHERE m.business_id = b.id AND m.is_active = TRUE)             AS menu_items,
      (SELECT COALESCE(uc.count, 0)::int FROM usage_counters uc
        WHERE uc.business_id = b.id AND uc.metric = 'monthly_orders'
          AND uc.period = $1)                                          AS monthly_orders
      FROM businesses b
      LEFT JOIN subscriptions s ON s.business_id = b.id
      LEFT JOIN plans p         ON p.id = s.plan_id
     WHERE b.deleted_at IS NULL
       AND (s.status IS NULL OR s.status IN ('active', 'trialing', 'past_due'))
     ORDER BY b.created_at DESC
     LIMIT $2 OFFSET $3
  `, [_period(), lim, off]);

  let rows = r.rows.map(_shapeUsage);
  if (overLimitOnly) rows = rows.filter((x) => x.overLimitCount > 0);
  rows.sort((a, b) => (b.overLimitCount - a.overLimitCount)
    || (b.maxUtilisationPct - a.maxUtilisationPct));

  const t = await query(
    'SELECT COUNT(*)::int AS c FROM businesses WHERE deleted_at IS NULL',
  );
  return { rows, total: t.rows[0].c, limit: lim, offset: off };
}

// limit -1 (or absent) = unlimited: utilisation is undefined, never "over".
function _shapeUsage(row) {
  const limits = row.limits || {};
  const metrics = USAGE_METRICS.map((metric) => {
    const used = Number(row[metric] || 0);
    const raw = limits[metric];
    const limit = raw === undefined || raw === null ? -1 : Number(raw);
    const unlimited = limit === -1;
    const pct = unlimited || limit === 0 ? null
      : Math.round((used / limit) * 1000) / 10;
    return {
      metric,
      used,
      limit,
      unlimited,
      utilisationPct: pct,
      over: !unlimited && limit >= 0 && used >= limit,
      near: !unlimited && pct !== null && pct >= 80 && used < limit,
    };
  });
  return {
    businessId: row.id,
    businessName: row.name,
    subscriptionStatus: row.status || null,
    planTier: row.tier || null,
    planName: row.plan_name || null,
    metrics,
    overLimitCount: metrics.filter((m) => m.over).length,
    nearLimitCount: metrics.filter((m) => m.near).length,
    maxUtilisationPct: metrics.reduce((mx, m) => (m.utilisationPct !== null && m.utilisationPct > mx ? m.utilisationPct : mx), 0),
  };
}

// ── Dunning / billing ops ────────────────────────────────────────────────

/**
 * Past-due (and recently-recovered) subscriptions with everything a human
 * needs to decide: attempts, last nudge, amount at risk, gateway id.
 */
async function dunningQueue({ includeRecovered = false, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
  const statusFilter = includeRecovered
    ? 's.status IN (\'past_due\', \'active\') AND (s.dunning_attempts > 0 OR s.status = \'past_due\')'
    : 's.status = \'past_due\'';
  const r = await query(`
    SELECT s.id AS subscription_id, s.business_id, b.name AS business_name,
           b.email AS business_email, b.account_owner_email,
           s.status, s.dunning_attempts, s.last_dunning_at,
           s.current_period_end, s.billing_period,
           s.razorpay_subscription_id,
           p.tier, p.name AS plan_name, p.price_inr_paise,
           (SELECT COUNT(*)::int FROM dunning_events de
             WHERE de.business_id = s.business_id
               AND de.event IN ('payment_failed', 'halted')) AS lifetime_failures
      FROM subscriptions s
      JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
      LEFT JOIN plans p ON p.id = s.plan_id
     WHERE ${statusFilter}
     ORDER BY s.dunning_attempts DESC NULLS LAST, s.last_dunning_at ASC NULLS LAST
     LIMIT $1
  `, [lim]);

  const rows = r.rows.map((x) => ({
    subscriptionId: x.subscription_id,
    businessId: x.business_id,
    businessName: x.business_name,
    businessEmail: x.business_email,
    accountOwnerEmail: x.account_owner_email || null,
    status: x.status,
    dunningAttempts: x.dunning_attempts || 0,
    lastDunningAt: x.last_dunning_at,
    currentPeriodEnd: x.current_period_end,
    billingPeriod: x.billing_period || 'monthly',
    razorpaySubscriptionId: x.razorpay_subscription_id || null,
    planTier: x.tier || null,
    planName: x.plan_name || null,
    // A yearly mandate that fails owes the YEARLY amount — billing the
    // monthly figure understated every annual customer's risk by ~12x.
    amountAtRiskInr: ((x.billing_period === 'yearly'
      ? (x.price_yearly_paise || x.price_inr_paise)
      : x.price_inr_paise) || 0) / PAISE,
    lifetimeFailures: x.lifetime_failures,
  }));
  return {
    rows,
    summary: {
      count: rows.length,
      amountAtRiskInr: rows.reduce((s2, x) => s2 + x.amountAtRiskInr, 0),
      atRiskOfChurn: rows.filter((x) => x.dunningAttempts >= 3).length,
    },
  };
}

async function dunningTimeline(businessId, { limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const r = await query(`
    SELECT id, event, attempt_no, reason, emailed, created_at
      FROM dunning_events
     WHERE business_id = $1
     ORDER BY created_at DESC
     LIMIT $2
  `, [businessId, lim]);
  return r.rows.map((x) => ({
    id: x.id,
    event: x.event,
    attemptNo: x.attempt_no,
    reason: x.reason,
    emailed: x.emailed,
    at: x.created_at,
  }));
}

async function _subForOps(businessId) {
  const r = await query(`
    SELECT s.id, s.business_id, s.status, s.dunning_attempts, s.billing_period,
           s.razorpay_subscription_id, b.name AS business_name, b.email,
           p.name AS plan_name, p.price_inr_paise
      FROM subscriptions s
      JOIN businesses b ON b.id = s.business_id
      LEFT JOIN plans p ON p.id = s.plan_id
     WHERE s.business_id = $1
     LIMIT 1
  `, [businessId]);
  if (r.rowCount === 0) throw new NotFound('No subscription for this customer');
  return r.rows[0];
}

/**
 * "Retry" — re-send the recovery nudge and record the attempt.
 *
 * Deliberately NOT a gateway charge: Razorpay owns the retry schedule for a
 * subscription mandate and there is no supported "charge now" call for one.
 * What a human can do from here is (a) re-notify the owner with the billing
 * link, and (b) leave a timestamped record that we chased them. The name
 * matches what the operator means ("retry collecting this"), the event we
 * write is explicit.
 */
async function dunningRetry(businessId, { adminId = null } = {}) {
  const s = await _subForOps(businessId);
  const email = require('./emailService');
  const attemptNo = (s.dunning_attempts || 0) + 1;

  let emailed = false;
  if (s.email && (s.price_inr_paise || 0) > 0) {
    try {
      await email.sendMail({
        template: `dunning_manual_retry_${Date.now()}`, // unique: the (user,template) index must not swallow repeat nudges
        recipient: s.email,
        subject: 'Action needed: update your NamastePOS payment method',
        text: `Hi ${s.business_name || 'there'},\n\n`
          + 'We still haven\'t been able to collect your NamastePOS subscription payment'
          + `${s.plan_name ? ` (${s.plan_name} plan)` : ''}.\n\n`
          + 'Please update your payment method here so your reports and features stay active:\n'
          + 'https://app.namastepos.in/billing\n\n— Team NamastePOS',
        html: `<p>Hi ${s.business_name || 'there'},</p>`
          + '<p>We still haven\'t been able to collect your NamastePOS subscription payment'
          + `${s.plan_name ? ` (${s.plan_name} plan)` : ''}.</p>`
          + '<p><a href="https://app.namastepos.in/billing">Update payment method</a></p>'
          + '<p>— Team NamastePOS</p>',
        businessId,
      });
      emailed = true;
    } catch (e) {
      logger.warn(`[dunning-retry] email failed for ${businessId}: ${e.message}`);
    }
  }

  await query(
    'UPDATE subscriptions SET dunning_attempts = $2, last_dunning_at = NOW() WHERE id = $1',
    [s.id, attemptNo],
  );
  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason, emailed)
     VALUES ($1, $2, 'manual_retry', $3, $4, $5)`,
    [businessId, s.id, attemptNo, `manual nudge by admin ${adminId || 'unknown'}`, emailed],
  );
  return { emailed, attemptNo, recipient: emailed ? s.email : null };
}

/**
 * "Waive" — forgive this cycle. Clears dunning state, puts the tenant back on
 * active service and rolls the period forward so they aren't re-flagged
 * tomorrow. Does NOT create an invoice or a payment: nothing was collected,
 * and pretending otherwise would corrupt revenue reporting.
 */
async function dunningWaive(businessId, { reason, adminId = null } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new BadRequest('A reason is required to waive a cycle');
  }
  const s = await _subForOps(businessId);
  const r = await query(`
    UPDATE subscriptions
       SET status = 'active',
           dunning_attempts = 0,
           last_dunning_at = NULL,
           current_period_start = NOW(),
           current_period_end = NOW() + CASE
             WHEN billing_period = 'yearly' THEN INTERVAL '1 year'
             ELSE INTERVAL '1 month' END,
           updated_at = NOW()
     WHERE id = $1
     RETURNING *`, [s.id]);
  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason)
     VALUES ($1, $2, 'waived', 0, $3)`,
    [businessId, s.id, `${String(reason).trim()} (admin ${adminId || 'unknown'})`],
  );
  _logCrm(businessId, 'billing', 'Cycle waived by admin', reason);
  return r.rows[0];
}

/**
 * "Mark paid" — money arrived out of band (bank transfer, UPI to the company
 * account, cash). Writes a real PAID invoice so MRR/revenue reports see it,
 * clears dunning, and rolls the period forward. Amount defaults to the plan
 * price; the operator can override for a partial settlement.
 */
async function dunningMarkPaid(businessId, { amountPaise, reference, adminId = null } = {}) {
  const s = await _subForOps(businessId);
  const amount = amountPaise === undefined || amountPaise === null
    // Match the cadence: the invoice period below is 1 year for yearly subs,
    // so defaulting to the monthly price would book a year of service for a
    // month's money.
    ? ((s.billing_period === 'yearly'
      ? (s.price_yearly_paise || s.price_inr_paise)
      : s.price_inr_paise) || 0)
    : parseInt(amountPaise, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequest('amountPaise must be a positive integer (or omit it to use the plan price)');
  }

  const inv = await query(
    `
    INSERT INTO invoices
      (business_id, subscription_id, status, amount_paise, currency,
       period_start, period_end, paid_at)
    VALUES ($1, $2, 'paid', $3, 'INR', NOW(),
            NOW() + CASE WHEN $4 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END,
            NOW())
    RETURNING *`,
    [businessId, s.id, amount, s.billing_period || 'monthly'],
  );

  await query(`
    UPDATE subscriptions
       SET status = 'active',
           dunning_attempts = 0,
           last_dunning_at = NULL,
           current_period_start = NOW(),
           current_period_end = NOW() + CASE
             WHEN billing_period = 'yearly' THEN INTERVAL '1 year'
             ELSE INTERVAL '1 month' END,
           updated_at = NOW()
     WHERE id = $1`, [s.id]);

  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason)
     VALUES ($1, $2, 'recovered', 0, $3)`,
    [businessId, s.id,
      `marked paid offline${reference ? ` · ref ${String(reference).slice(0, 120)}` : ''} (admin ${adminId || 'unknown'})`],
  );
  _logCrm(
    businessId,
    'billing',
    'Marked paid offline',
    `₹${(amount / PAISE).toFixed(2)}${reference ? ` · ref ${reference}` : ''}`,
  );
  return { invoice: inv.rows[0] };
}

// Best-effort CRM timeline entry — never let a bookkeeping nicety fail an
// operation the admin already committed.
function _logCrm(businessId, kind, title, body) {
  try {
    require('./crmService').logActivity({
      businessId, kind, title, body: body || null, actorType: 'admin',
    }).catch(() => {});
  } catch (_) { /* non-fatal */ }
}

// ── Notification (email) log ─────────────────────────────────────────────

/**
 * What the platform has sent this tenant, from email_dispatch_log — the only
 * dispatch log that exists. See the report for what is NOT covered (push +
 * WhatsApp have no platform-level dispatch table).
 */
async function notificationLog(businessId, { limit = 100, offset = 0, status } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const params = [businessId, lim, off];
  let statusSql = '';
  if (status) { params.push(status); statusSql = ` AND l.status = $${params.length}`; }

  const [rows, total] = await Promise.all([
    query(`
      SELECT l.id, l.template, l.recipient, l.subject, l.status,
             l.provider_id, l.error_message, l.created_at, l.sent_at,
             u.email AS user_email
        FROM email_dispatch_log l
        LEFT JOIN users u ON u.id = l.user_id
       WHERE l.business_id = $1${statusSql}
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`, params),
    query(
      'SELECT COUNT(*)::int AS c FROM email_dispatch_log WHERE business_id = $1',
      [businessId],
    ),
  ]);
  return {
    channel: 'email',
    rows: rows.rows.map((x) => ({
      id: x.id,
      channel: 'email',
      template: x.template,
      recipient: x.recipient,
      subject: x.subject,
      status: x.status,
      providerId: x.provider_id,
      error: x.error_message,
      createdAt: x.created_at,
      sentAt: x.sent_at,
      userEmail: x.user_email,
    })),
    total: total.rows[0].c,
    limit: lim,
    offset: off,
  };
}

// ── Health / ops panel ───────────────────────────────────────────────────

/**
 * Read-only platform health. Every field comes from something that already
 * exists (health_db_ping(), _migrations, webhook_events, the in-process cron
 * worker) — no new infrastructure, no new tables.
 */
async function platformHealth() {
  const t0 = Date.now();
  let db = { ok: false, latencyMs: null, error: null };
  try {
    await query('SELECT 1');
    db = { ok: true, latencyMs: Date.now() - t0, error: null };
  } catch (e) {
    db = { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }

  const [migrations, webhooks, poolRow] = await Promise.all([
    query('SELECT COUNT(*)::int AS c, MAX(applied_at) AS last_at FROM _migrations')
      .catch(() => ({ rows: [{ c: null, last_at: null }] })),
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM webhook_events
          WHERE created_at > NOW() - INTERVAL '24 hours')            AS received_24h,
        (SELECT COUNT(*)::int FROM webhook_events
          WHERE created_at > NOW() - INTERVAL '24 hours'
            AND error IS NOT NULL)                                   AS errored_24h,
        (SELECT COUNT(*)::int FROM webhook_events
          WHERE created_at > NOW() - INTERVAL '24 hours'
            AND processed_at IS NULL)                                AS unprocessed_24h,
        (SELECT MAX(created_at) FROM webhook_events)                 AS last_event_at
    `).catch(() => ({ rows: [{}] })),
    query('SELECT numbackends::int AS conns FROM pg_stat_database WHERE datname = current_database()')
      .catch(() => ({ rows: [{}] })),
  ]);

  let cron = { running: false, lastTickAt: null, jobs: {} };
  try { cron = require('./cronWorker').stats(); } catch (_) { /* worker not loaded */ }

  return {
    api: { ok: true, env: env.NODE_ENV, uptimeSec: Math.round(process.uptime()) },
    db: { ...db, connections: poolRow.rows[0]?.conns ?? null },
    // "on" here means configured + a subscriber connected; without REDIS_URL
    // the feature cache is per-instance TTL only (correct, just slower to
    // propagate). Reported so a single-instance deploy isn't mistaken for a
    // broken one.
    redis: _redisStatus(),
    migrations: {
      applied: migrations.rows[0]?.c ?? null,
      lastAppliedAt: migrations.rows[0]?.last_at ?? null,
    },
    webhooks: {
      received24h: webhooks.rows[0]?.received_24h ?? null,
      errored24h: webhooks.rows[0]?.errored_24h ?? null,
      unprocessed24h: webhooks.rows[0]?.unprocessed_24h ?? null,
      lastEventAt: webhooks.rows[0]?.last_event_at ?? null,
    },
    cron,
  };
}

function _redisStatus() {
  const configured = !!env.REDIS_URL;
  let ready = false;
  try { ready = require('./featureService').cacheStatus().redisReady === true; } catch (_) {}
  return { configured, ready, mode: configured ? 'pub/sub invalidation' : 'in-process TTL only' };
}

module.exports = {
  overview,
  needsAttention,
  usageForBusiness,
  platformUsage,
  USAGE_METRICS,
  dunningQueue,
  dunningTimeline,
  dunningRetry,
  dunningWaive,
  dunningMarkPaid,
  notificationLog,
  platformHealth,
};
