// NamastePOS backend - platform-wide advanced reports (super admin only)

const { query } = require('../config/db');

/**
 * Cohort retention.
 * Rows = signup month (YYYY-MM).
 * Cols = months since signup (0, 1, 2, …).
 * Cell = % of original cohort still placing orders that month.
 */
async function cohortRetention({ months = 6 } = {}) {
  const r = await query(`
    WITH cohorts AS (
      SELECT id, DATE_TRUNC('month', created_at) AS cohort_month
        FROM businesses
       WHERE created_at > NOW() - INTERVAL '${parseInt(months, 10) + 6} months'
    ),
    activity AS (
      SELECT o.business_id,
             DATE_TRUNC('month', o.created_at) AS active_month
        FROM orders o
       WHERE o.created_at > NOW() - INTERVAL '${parseInt(months, 10) + 6} months'
         AND o.status <> 'cancelled'
       GROUP BY o.business_id, DATE_TRUNC('month', o.created_at)
    )
    SELECT
      to_char(c.cohort_month, 'YYYY-MM')             AS cohort,
      COUNT(DISTINCT c.id)                            AS cohort_size,
      EXTRACT(MONTH FROM AGE(a.active_month, c.cohort_month))::int +
        EXTRACT(YEAR FROM AGE(a.active_month, c.cohort_month))::int * 12 AS months_after,
      COUNT(DISTINCT a.business_id)::int              AS active_count
    FROM cohorts c
    LEFT JOIN activity a ON a.business_id = c.id AND a.active_month >= c.cohort_month
    GROUP BY c.cohort_month, months_after
    ORDER BY c.cohort_month DESC, months_after ASC;
  `);

  const cohorts = {};
  for (const row of r.rows) {
    if (!cohorts[row.cohort]) {
      cohorts[row.cohort] = { cohort: row.cohort, size: row.cohort_size, retention: {} };
    }
    if (row.months_after != null) {
      cohorts[row.cohort].retention[row.months_after] =
        Math.round((row.active_count / row.cohort_size) * 100);
    }
  }
  return Object.values(cohorts);
}

/**
 * Signup → first-order → paid-plan funnel.
 */
async function signupFunnel({ days = 30 } = {}) {
  const total = await query(
    `SELECT COUNT(*)::int AS c FROM businesses WHERE created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'`
  );
  const withOrder = await query(
    `SELECT COUNT(DISTINCT b.id)::int AS c
       FROM businesses b JOIN orders o ON o.business_id = b.id
      WHERE b.created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'`
  );
  const onPaid = await query(
    `SELECT COUNT(DISTINCT b.id)::int AS c
       FROM businesses b
       JOIN subscriptions s ON s.business_id = b.id
       JOIN plans p ON p.id = s.plan_id
      WHERE b.created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'
        AND p.tier <> 'free' AND s.status = 'active'`
  );
  return {
    days,
    signups: total.rows[0].c,
    placedFirstOrder: withOrder.rows[0].c,
    onPaidPlan: onPaid.rows[0].c,
  };
}

/**
 * LTV — average paid revenue per business that ever paid.
 */
async function ltv() {
  const r = await query(`
    SELECT
      COUNT(DISTINCT business_id)::int                         AS paying_customers,
      COALESCE(SUM(amount_paise), 0)::bigint                   AS total_paid_paise,
      COALESCE(AVG(amount_paise)::bigint, 0)                   AS avg_invoice_paise
    FROM invoices WHERE status = 'paid';
  `);
  const row = r.rows[0];
  return {
    payingCustomers: row.paying_customers,
    totalPaidInr: row.total_paid_paise / 100,
    avgInvoiceInr: row.avg_invoice_paise / 100,
    ltvInr: row.paying_customers > 0
      ? (row.total_paid_paise / row.paying_customers) / 100
      : 0,
  };
}

/**
 * Churn (cancelled subs in last 30d / active subs at start of period).
 */
async function churnRate() {
  const active = await query(
    `SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'active'`
  );
  const cancelled = await query(`
    SELECT COUNT(*)::int AS c
      FROM subscriptions
     WHERE cancelled_at > NOW() - INTERVAL '30 days';
  `);
  return {
    activeNow: active.rows[0].c,
    cancelled30d: cancelled.rows[0].c,
    churnRatePct: active.rows[0].c > 0
      ? Math.round((cancelled.rows[0].c / active.rows[0].c) * 100 * 10) / 10
      : 0,
  };
}

/**
 * Top items across the whole platform.
 */
async function topItems({ days = 30, limit = 10 } = {}) {
  const r = await query(`
    SELECT oi.name,
           SUM(oi.qty)::int                AS qty,
           SUM(oi.qty * oi.price)::float   AS revenue,
           COUNT(DISTINCT o.business_id)::int AS businesses_selling
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'
       AND o.status <> 'cancelled'
     GROUP BY oi.name
     ORDER BY qty DESC
     LIMIT ${parseInt(limit, 10)};
  `);
  return r.rows;
}

/**
 * Geographic split — orders by customer city.
 */
async function topCities({ days = 30, limit = 15 } = {}) {
  const r = await query(`
    SELECT COALESCE(b.city, 'Unknown') AS city,
           COUNT(DISTINCT b.id)::int   AS businesses,
           COUNT(o.id)::int            AS orders,
           COALESCE(SUM(o.total), 0)::float AS gmv
      FROM businesses b
 LEFT JOIN orders o ON o.business_id = b.id
                  AND o.created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'
                  AND o.status <> 'cancelled'
     GROUP BY COALESCE(b.city, 'Unknown')
     ORDER BY gmv DESC NULLS LAST
     LIMIT ${parseInt(limit, 10)};
  `);
  return r.rows;
}

/**
 * MRR trend by month (last 12 months).
 */
async function mrrTrend({ months = 12 } = {}) {
  const r = await query(`
    SELECT
      to_char(d.month, 'YYYY-MM') AS month,
      COUNT(s.id)::int AS active_subs,
      COALESCE(SUM(p.price_inr_paise), 0)::bigint AS mrr_paise
    FROM (
      SELECT generate_series(
        DATE_TRUNC('month', NOW() - INTERVAL '${parseInt(months, 10)} months'),
        DATE_TRUNC('month', NOW()),
        '1 month'::interval
      ) AS month
    ) d
    LEFT JOIN subscriptions s
           ON s.current_period_start <= d.month + INTERVAL '1 month'
          AND (s.cancelled_at IS NULL OR s.cancelled_at > d.month)
          AND s.status IN ('active','trialing')
    LEFT JOIN plans p ON p.id = s.plan_id AND p.price_inr_paise > 0
    GROUP BY d.month
    ORDER BY d.month;
  `);
  return r.rows.map((row) => ({
    month: row.month, activeSubs: row.active_subs,
    mrrInr: parseInt(row.mrr_paise, 10) / 100,
  }));
}

/**
 * Push 19e — outstanding (unpaid) subscription invoices, grouped into
 * 0-30 / 31-60 / 61-90 / 90+ day aging buckets so the finance team can
 * follow up on stale receivables. Status filters out drafts and voids.
 *
 * Hotfix (2026-09-01): this filtered on `i.status IN ('open','past_due')`, but
 * `past_due` is NOT a member of the `invoice_status` enum
 * ('draft','open','paid','void','uncollectible','refunded') — it belongs to
 * subscription_status/addon_status. Postgres therefore threw
 * `invalid input value for enum invoice_status: "past_due"` and this admin
 * report 500'd. Invoices never take `past_due` (dunning marks the SUBSCRIPTION
 * past_due, not the invoice), so `open` is the collectable set; `days_overdue`
 * already surfaces how stale each open invoice is.
 */
async function outstandingInvoices() {
  const { query } = require('../config/db');
  const r = await query(
    `SELECT i.id, i.number, i.amount_paise, i.due_at, i.status,
            i.created_at, b.id AS business_id, b.name AS business_name,
            b.email AS business_email,
            CASE
              WHEN i.due_at IS NULL THEN GREATEST(0, EXTRACT(DAY FROM NOW() - i.created_at)::int)
              ELSE GREATEST(0, EXTRACT(DAY FROM NOW() - i.due_at)::int)
            END AS days_overdue
       FROM invoices i
       JOIN businesses b ON b.id = i.business_id
      WHERE i.status = 'open'
      ORDER BY days_overdue DESC, i.amount_paise DESC`
  );
  const rows = r.rows.map((x) => ({
    id: x.id,
    number: x.number || x.id.slice(0, 8),
    businessId: x.business_id,
    businessName: x.business_name,
    businessEmail: x.business_email,
    amountInr: x.amount_paise / 100,
    status: x.status,
    dueAt: x.due_at,
    createdAt: x.created_at,
    daysOverdue: parseInt(x.days_overdue, 10),
  }));
  // Aging buckets
  const bucket = (d) =>
    d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
  const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let total = 0;
  for (const r of rows) {
    aging[bucket(r.daysOverdue)] += r.amountInr;
    total += r.amountInr;
  }
  return {
    rows,
    aging,
    totalOutstandingInr: total,
    invoiceCount: rows.length,
  };
}

/**
 * Push 20d — platform-wide P&L for super admin.
 * Income side = paid invoices (subscription billing) + addon activations
 *               that generated charges in the period, MINUS refunds issued.
 * Expense side = anything tracked in `platform_expenses` if present
 *               (e.g. infra, salaries, taxes). If the table doesn't exist
 *               we report income only with a placeholder expense block.
 *
 * Returns:
 *   {
 *     from, to,
 *     income: { subscription, addons, total },
 *     refunds,
 *     grossRevenue,
 *     expenses: { items: [{ category, amount }], total } | null,
 *     netProfit
 *   }
 */
async function consolidatedPnl({ from = null, to = null } = {}) {
  // Default to current FY-to-date if no range given. Indian FY starts Apr 1.
  if (!from) {
    const now = new Date();
    const fyStartYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    from = `${fyStartYear}-04-01`;
  }
  if (!to) {
    to = new Date().toISOString().slice(0, 10);
  }

  // ── Subscription income (paid invoices in period) ────────────────────
  // Wrapped defensively — if the schema is missing the table on some
  // deployments we still return a usable P&L instead of 500-ing.
  let subs;
  try {
    subs = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS p,
              COUNT(*)::int AS n
         FROM invoices
        WHERE status = 'paid'
          AND created_at::date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
  } catch (e) {
    subs = { rows: [{ p: '0', n: 0 }] };
  }

  // ── Addon income (activations + price snapshot) ──────────────────────
  // Addon activations are billed at addon.price_inr_paise * months-active
  // but for a simple cash-basis P&L we use the addon_invoices table when
  // present, otherwise fall back to activation count × price.
  let addonsTotalPaise = 0;
  let addonsRowCount = 0;
  try {
    const ai = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS p, COUNT(*)::int AS n
         FROM addon_invoices
        WHERE status = 'paid'
          AND created_at::date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
    addonsTotalPaise = parseInt(ai.rows[0].p, 10);
    addonsRowCount = ai.rows[0].n;
  } catch (e) {
    // Table may not exist on older deployments — derive from activations.
    const ai = await query(
      `SELECT COALESCE(SUM(a.price_inr_paise), 0)::bigint AS p, COUNT(*)::int AS n
         FROM business_addons ba
         JOIN addons a ON a.id = ba.addon_id
        WHERE ba.status = 'active'
          AND ba.activated_at::date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
    addonsTotalPaise = parseInt(ai.rows[0].p, 10);
    addonsRowCount = ai.rows[0].n;
  }

  // ── Refunds (outflow) ────────────────────────────────────────────────
  // Schema-correct refund_status enum is ('pending','processed','failed','cancelled')
  // — 'processed' is the only value that counts as money actually leaving us.
  let ref;
  try {
    ref = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS p, COUNT(*)::int AS n
         FROM refunds
        WHERE status = 'processed'
          AND created_at::date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
  } catch (e) {
    ref = { rows: [{ p: '0', n: 0 }] };
  }

  // ── Expenses (optional table) ────────────────────────────────────────
  let expenses = null;
  try {
    const ex = await query(
      `SELECT category, COALESCE(SUM(amount_paise), 0)::bigint AS p
         FROM platform_expenses
        WHERE created_at::date BETWEEN $1::date AND $2::date
        GROUP BY category
        ORDER BY p DESC`,
      [from, to]
    );
    const items = ex.rows.map((r) => ({
      category: r.category,
      amountInr: parseInt(r.p, 10) / 100,
    }));
    expenses = {
      items,
      totalInr: items.reduce((s, r) => s + r.amountInr, 0),
    };
  } catch (e) {
    expenses = null;
  }

  const subscriptionInr = parseInt(subs.rows[0].p, 10) / 100;
  const addonsInr = addonsTotalPaise / 100;
  const refundsInr = parseInt(ref.rows[0].p, 10) / 100;
  const grossRevenueInr = subscriptionInr + addonsInr - refundsInr;
  const expensesTotal = expenses?.totalInr || 0;
  const netProfitInr = grossRevenueInr - expensesTotal;

  return {
    from, to,
    income: {
      subscriptionInr,
      subscriptionInvoiceCount: subs.rows[0].n,
      addonsInr,
      addonsInvoiceCount: addonsRowCount,
      totalInr: subscriptionInr + addonsInr,
    },
    refunds: {
      totalInr: refundsInr,
      count: ref.rows[0].n,
    },
    grossRevenueInr,
    expenses, // null if no platform_expenses table
    netProfitInr,
  };
}

/**
 * Push 20d — customer KPI snapshot used by the consolidated report.
 * Counts by status and by plan tier so the dashboard can render a
 * "Customers" overview card alongside the P&L.
 */
async function customersKpi() {
  // businesses table has no `deleted_at` column in this schema, so `alive`
  // equals total. Each sub-query is wrapped so a single missing column
  // doesn't kill the whole panel.
  let totals = { rows: [{ total: 0, new_30d: 0, alive: 0 }] };
  let byPlan = { rows: [] };
  let byStatus = { rows: [] };
  try {
    totals = await query(`
      SELECT
        COUNT(*)::int                                                        AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_30d,
        COUNT(*)::int                                                        AS alive
      FROM businesses;
    `);
  } catch (e) { /* keep zeros */ }
  try {
    byPlan = await query(`
      SELECT COALESCE(p.tier, 'free') AS tier,
             COALESCE(p.name, 'Free') AS name,
             COUNT(b.id)::int          AS customers
        FROM businesses b
   LEFT JOIN subscriptions s ON s.business_id = b.id
                            AND s.status IN ('active','trialing')
   LEFT JOIN plans p ON p.id = s.plan_id
       GROUP BY COALESCE(p.tier, 'free'), COALESCE(p.name, 'Free')
       ORDER BY customers DESC;
    `);
  } catch (e) { /* leave empty */ }
  try {
    byStatus = await query(`
      SELECT COALESCE(s.status::text, 'no_subscription') AS status,
             COUNT(b.id)::int AS customers
        FROM businesses b
   LEFT JOIN subscriptions s ON s.business_id = b.id
       GROUP BY COALESCE(s.status::text, 'no_subscription')
       ORDER BY customers DESC;
    `);
  } catch (e) { /* leave empty */ }
  return {
    total: totals.rows[0].total,
    alive: totals.rows[0].alive,
    new30d: totals.rows[0].new_30d,
    byPlan: byPlan.rows,
    byStatus: byStatus.rows,
  };
}

/**
 * Push 20d — revenue breakdown month-by-month so a finance lead can see
 * subscription vs addon vs refund split over time, not just an aggregate.
 */
async function revenueBreakdown({ months = 12 } = {}) {
  let sub = { rows: [] };
  let ref = { rows: [] };
  try {
    sub = await query(`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(amount_paise), 0)::bigint AS p
        FROM invoices
       WHERE status = 'paid'
         AND created_at > NOW() - INTERVAL '${parseInt(months, 10)} months'
       GROUP BY 1 ORDER BY 1;
    `);
  } catch (e) { /* leave empty */ }
  try {
    ref = await query(`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(amount_paise), 0)::bigint AS p
        FROM refunds
       WHERE status = 'processed'
         AND created_at > NOW() - INTERVAL '${parseInt(months, 10)} months'
       GROUP BY 1 ORDER BY 1;
    `);
  } catch (e) { /* leave empty */ }
  let addonRows = [];
  try {
    const ad = await query(`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(amount_paise), 0)::bigint AS p
        FROM addon_invoices
       WHERE status = 'paid'
         AND created_at > NOW() - INTERVAL '${parseInt(months, 10)} months'
       GROUP BY 1 ORDER BY 1;
    `);
    addonRows = ad.rows;
  } catch (e) {
    addonRows = [];
  }
  const map = new Map();
  const ensure = (m) => {
    if (!map.has(m)) map.set(m, { month: m, subscriptionInr: 0, addonsInr: 0, refundsInr: 0 });
    return map.get(m);
  };
  for (const r of sub.rows)     ensure(r.month).subscriptionInr = parseInt(r.p, 10) / 100;
  for (const r of addonRows)    ensure(r.month).addonsInr       = parseInt(r.p, 10) / 100;
  for (const r of ref.rows)     ensure(r.month).refundsInr      = parseInt(r.p, 10) / 100;
  const series = Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  for (const r of series) {
    r.netInr = +(r.subscriptionInr + r.addonsInr - r.refundsInr).toFixed(2);
  }
  return series;
}

// N4 (2026-08-27): consolidated subscription ledger — one row per tenant
// subscription with plan, status, next-charge date, trial info, and a
// billingMode that distinguishes PAID (Razorpay-backed) from COMPED
// (manually granted, no Razorpay sub) from FREE (no price). Gives finance a
// single operable view instead of drilling tenant-by-tenant.
async function subscriptionLedger({ status, billingMode } = {}) {
  const { query } = require('../config/db');
  const r = await query(
    `SELECT s.id, s.status, s.trial_ends_at, s.current_period_end,
            s.cancel_at_period_end, s.cancelled_at, s.created_at,
            s.razorpay_subscription_id,
            s.dunning_attempts, s.last_dunning_at,
            b.id AS business_id, b.name AS business_name,
            p.tier, p.name AS plan_name, p.price_inr_paise,
            CASE
              WHEN COALESCE(p.price_inr_paise,0) = 0 THEN 'free'
              WHEN s.razorpay_subscription_id IS NOT NULL THEN 'paid'
              ELSE 'comped'
            END AS billing_mode
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY s.current_period_end ASC NULLS LAST`
  );
  let rows = r.rows.map((x) => ({
    id: x.id,
    businessId: x.business_id,
    businessName: x.business_name,
    planTier: x.tier,
    planName: x.plan_name,
    priceInr: (x.price_inr_paise || 0) / 100,
    status: x.status,
    billingMode: x.billing_mode,
    nextChargeAt: x.current_period_end,
    trialEndsAt: x.trial_ends_at,
    cancelAtPeriodEnd: x.cancel_at_period_end,
    cancelledAt: x.cancelled_at,
    createdAt: x.created_at,
    razorpaySubscriptionId: x.razorpay_subscription_id,
    dunningAttempts: x.dunning_attempts || 0,
    lastDunningAt: x.last_dunning_at,
  }));
  if (status) rows = rows.filter((r0) => r0.status === status);
  if (billingMode) rows = rows.filter((r0) => r0.billingMode === billingMode);

  const summary = {
    total: rows.length,
    byStatus: {},
    byBillingMode: { paid: 0, comped: 0, free: 0 },
    // MRR from currently-active PAID subs only (matches metrics()).
    mrrInr: 0,
    pastDueCount: 0,
  };
  for (const r0 of rows) {
    summary.byStatus[r0.status] = (summary.byStatus[r0.status] || 0) + 1;
    summary.byBillingMode[r0.billingMode] =
      (summary.byBillingMode[r0.billingMode] || 0) + 1;
    if (r0.status === 'active' && r0.billingMode === 'paid') summary.mrrInr += r0.priceInr;
    if (r0.status === 'past_due') summary.pastDueCount += 1;
  }
  return { rows, summary };
}

// L5 (2026-08-28) — add-on marketplace revenue-share payout report. For each
// add-on with a partner, gross = monthly price × active activations; payout =
// gross × revenue_share_pct. Gives finance a partner-payout view.
async function addonPayouts() {
  const { query } = require('../config/db');
  const r = await query(
    `SELECT a.slug, a.name, a.partner_name, a.revenue_share_pct,
            a.price_inr_paise,
            COUNT(ba.id) FILTER (WHERE ba.status = 'active')::int AS active_count
       FROM addons a
       LEFT JOIN business_addons ba ON ba.addon_id = a.id
      WHERE COALESCE(a.revenue_share_pct,0) > 0 OR a.partner_name IS NOT NULL
      GROUP BY a.id
      ORDER BY a.partner_name NULLS LAST, a.name`
  );
  const rows = r.rows.map((x) => {
    const grossInr = (x.price_inr_paise / 100) * x.active_count;
    const pct = x.revenue_share_pct != null ? Number(x.revenue_share_pct) : 0;
    return {
      slug: x.slug, name: x.name, partner: x.partner_name || '—',
      revenueSharePct: pct, activeCount: x.active_count,
      grossInr, payoutInr: Math.round(grossInr * pct) / 100,
    };
  });
  const totals = rows.reduce((acc, r0) => {
    acc.grossInr += r0.grossInr; acc.payoutInr += r0.payoutInr; return acc;
  }, { grossInr: 0, payoutInr: 0 });
  return { rows, totals };
}

module.exports = {
  cohortRetention, signupFunnel, ltv, churnRate,
  topItems, topCities, mrrTrend,
  outstandingInvoices, subscriptionLedger, addonPayouts,
  consolidatedPnl, customersKpi, revenueBreakdown,
};
