// NamastePOS backend - report aggregation service
//
// Daily and monthly P&L. Results are cached in report_cache with a TTL —
// daily reports for past dates can live for 24h, monthly for 1h (still
// changing day by day), and "today" is computed fresh every call.

const { query } = require('../config/db');

// P1 fix (2026-08-22): "today" must be evaluated in IST — all report
// bucketing is IST. The old UTC check froze the live day's report in
// the 24h cache between 00:00 and 05:30 IST.
function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

function isToday(dateStr) {
  return String(dateStr).slice(0, 10) === istToday();
}

async function getCache(businessId, type, key) {
  const r = await query(
    `SELECT payload FROM report_cache
      WHERE business_id = $1 AND type = $2 AND key_date = $3
        AND expires_at > NOW()
      LIMIT 1`,
    [businessId, type, key],
  );
  return r.rowCount > 0 ? r.rows[0].payload : null;
}

async function setCache(businessId, type, key, payload, ttlSeconds) {
  await query(
    `INSERT INTO report_cache (business_id, type, key_date, payload, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
     ON CONFLICT (business_id, type, key_date) DO UPDATE
       SET payload = EXCLUDED.payload,
           expires_at = EXCLUDED.expires_at`,
    [businessId, type, key, payload, ttlSeconds],
  );
}

async function dailyReport(businessId, dateStr) {
  const cached = await getCache(businessId, 'daily', dateStr);
  if (cached && !isToday(dateStr)) return cached;

  // Revenue by source
  const rev = await query(
    `SELECT source, COALESCE(SUM(total), 0) AS amount, COUNT(*) AS orders
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        AND status <> 'cancelled'
      GROUP BY source`,
    [businessId, dateStr],
  );
  // Expenses by category
  const exp = await query(
    `SELECT category, COALESCE(SUM(amount), 0) AS amount
       FROM expenses
      WHERE business_id = $1
        AND date = $2::date
        AND deleted_at IS NULL
      GROUP BY category`,
    [businessId, dateStr],
  );
  // Top items by qty
  const top = await query(
    `SELECT oi.menu_item_id AS item_id,
            oi.name,
            SUM(oi.qty) AS qty,
            SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.business_id = $1
        AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        AND o.status <> 'cancelled'
      GROUP BY oi.menu_item_id, oi.name
      ORDER BY qty DESC
      LIMIT 5`,
    [businessId, dateStr],
  );

  // FF-241 — payment breakdown for today (cash/upi/card/wallet). Same
  // query shape as dailyClosingService's, kept here so the customer
  // dashboard's Overview can render the "Payment breakdown" card
  // without a second round-trip.
  const pay = await query(
    `SELECT payment_method, COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS amt
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        AND status = 'collected'
      GROUP BY payment_method`,
    [businessId, dateStr],
  );

  // 2026-09-01 (founder) — ACCURATE "collected by tender" for the day.
  // The `pay` query above groups SUM(total) by the order's single
  // payment_method, which MIS-attributes split/wallet orders (a ₹150 order
  // paid ₹50 wallet + ₹55 cash + ₹45 points shows the whole ₹105 under one
  // method, and never separates the wallet draw-down from real cash). This
  // computes the true per-tender split from the `payments` legs (split/wallet/
  // breakdown orders) UNIONed with single-tender collected orders (which write
  // no payments row — fall back to orders.payment_method × total). Unpaid open
  // KOTs are excluded (nothing collected yet). Wallet appears as its own tender
  // so the owner can see it's a prepaid draw-down, not cash in the drawer.
  const tenderRows = await query(
    `WITH d AS (
       SELECT id, total, payment_method
         FROM orders
        WHERE business_id = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND status = 'collected'
     ),
     legged AS (
       SELECT DISTINCT p.order_id FROM payments p JOIN d ON d.id = p.order_id
     ),
     leg_sum AS (
       SELECT p.method::text AS method, SUM(p.amount_paise)::bigint AS paise
         FROM payments p JOIN d ON d.id = p.order_id
        GROUP BY p.method
     ),
     single_sum AS (
       SELECT d.payment_method::text AS method, ROUND(SUM(d.total) * 100)::bigint AS paise
         FROM d
        WHERE d.id NOT IN (SELECT order_id FROM legged)
          AND d.payment_method <> 'unpaid'
        GROUP BY d.payment_method
     )
     SELECT method, SUM(paise)::bigint AS paise
       FROM (SELECT * FROM leg_sum UNION ALL SELECT * FROM single_sum) x
      GROUP BY method`,
    [businessId, dateStr],
  );
  // Discounts given today: loyalty points (business-funded, already excluded
  // from revenue) + manual/settle discounts. Surfaced so the owner sees WHY
  // net sales < gross and that points never hit the till.
  const discRows = await query(
    `SELECT COALESCE(SUM(loyalty_discount_paise), 0)::bigint AS points_paise,
            COALESCE(SUM(points_redeemed), 0)::bigint       AS points_count,
            COALESCE(SUM(discount), 0)::float               AS manual_discount
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        AND status <> 'cancelled'`,
    [businessId, dateStr],
  );

  // FF-242 — order status counts (pending/ready/collected/cancelled).
  // Powers the donut on Overview. Uses ALL orders regardless of
  // payment state so a still-pending walk-in shows up.
  const statusRows = await query(
    `SELECT status, COUNT(*)::int AS n
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
      GROUP BY status`,
    [businessId, dateStr],
  );

  // FF-243 — channel counts (zomato/swiggy/dunzo/magicpin/dineIn/
  // takeaway/delivery/qr). Source column matches the enum the mobile
  // POS + guest QR routes emit.
  const chanRows = await query(
    `SELECT source, COUNT(*)::int AS n
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        AND status <> 'cancelled'
      GROUP BY source`,
    [businessId, dateStr],
  );

  const revenue = {};
  let totalRevenue = 0;
  let orderCount = 0;
  for (const row of rev.rows) {
    revenue[row.source] = parseFloat(row.amount);
    totalRevenue += parseFloat(row.amount);
    orderCount += parseInt(row.orders, 10);
  }
  const expenses = {};
  let totalExpenses = 0;
  for (const row of exp.rows) {
    expenses[row.category] = parseFloat(row.amount);
    totalExpenses += parseFloat(row.amount);
  }
  const topItems = top.rows.map((r) => ({
    itemId: r.item_id,
    name: r.name,
    qty: parseFloat(r.qty),
    revenue: parseFloat(r.revenue),
  }));

  const profit = totalRevenue - totalExpenses;
  const margin = totalRevenue === 0 ? 0 : (profit / totalRevenue) * 100;

  // FF-241/242/243 — flatten the three new rowsets to { key: {count, amount} }.
  const paymentBreakdown = pay.rows.reduce((acc, r) => {
    acc[r.payment_method] = { count: r.n, amount: parseFloat(r.amt) || 0 };
    return acc;
  }, {});
  const statusCounts = statusRows.rows.reduce((acc, r) => {
    acc[r.status] = r.n;
    return acc;
  }, {});
  const channelCounts = chanRows.rows.reduce((acc, r) => {
    acc[r.source] = r.n;
    return acc;
  }, {});

  // Accurate collected-by-tender (rupees). Keys: cash/upi/card/online/wallet.
  const tenders = tenderRows.rows.reduce((acc, r) => {
    acc[r.method] = Math.round((parseInt(r.paise, 10) || 0)) / 100;
    return acc;
  }, {});
  const tendersTotal = Object.values(tenders).reduce((s, v) => s + v, 0);
  // Cash actually collected today = everything EXCEPT the wallet draw-down
  // (wallet is prepaid money recognised as sales on spend, not new cash today).
  const cashCollectedToday = Math.round((tendersTotal - (tenders.wallet || 0)) * 100) / 100;
  const dr = discRows.rows[0] || {};
  const discountBreakdown = {
    pointsValue: Math.round((parseInt(dr.points_paise, 10) || 0)) / 100,
    pointsRedeemed: parseInt(dr.points_count, 10) || 0,
    manual: parseFloat(dr.manual_discount) || 0,
  };

  const payload = {
    date: dateStr,
    revenue: { ...revenue, total: totalRevenue },
    expenses: { ...expenses, total: totalExpenses },
    profit,
    margin: Math.round(margin * 10) / 10,
    orderCount,
    topItems,
    paymentBreakdown, // FF-241 (legacy, per-order primary method)
    // 2026-09-01: accurate per-tender collection + wallet/points transparency.
    tenders,
    tendersTotal: Math.round(tendersTotal * 100) / 100,
    walletCollected: tenders.wallet || 0,
    cashCollectedToday,
    discountBreakdown,
    statusCounts, // FF-242
    channelCounts, // FF-243
  };

  // cache: today 5 min, past 24 h
  await setCache(businessId, 'daily', dateStr, payload, isToday(dateStr) ? 300 : 86400);
  return payload;
}

async function monthlyReport(businessId, monthStr) {
  // monthStr: 'YYYY-MM'
  // P1 fix (2026-08-22): current-month check in IST, matching bucketing.
  const isCurrentMonth = istToday().slice(0, 7) === monthStr;

  const cached = await getCache(businessId, 'monthly', monthStr);
  if (cached && !isCurrentMonth) return cached;

  const [year, month] = monthStr.split('-');
  const startDate = `${year}-${month}-01`;
  // last day computed via Postgres
  const rev = await query(
    `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, COALESCE(SUM(total), 0) AS amount
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <  ($2::date + INTERVAL '1 month')
        AND status <> 'cancelled'
      GROUP BY (created_at AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY day`,
    [businessId, startDate],
  );
  const exp = await query(
    `SELECT date AS day, COALESCE(SUM(amount), 0) AS amount
       FROM expenses
      WHERE business_id = $1
        AND date >= $2::date
        AND date <  ($2::date + INTERVAL '1 month')
        AND deleted_at IS NULL
      GROUP BY date
      ORDER BY day`,
    [businessId, startDate],
  );

  let totalRevenue = 0;
  let totalExpenses = 0;
  const series = [];
  const byDate = new Map();
  for (const r of rev.rows) {
    const k = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day);
    byDate.set(k, { date: k, revenue: parseFloat(r.amount), expenses: 0 });
    totalRevenue += parseFloat(r.amount);
  }
  for (const r of exp.rows) {
    const k = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day);
    if (byDate.has(k)) byDate.get(k).expenses = parseFloat(r.amount);
    else byDate.set(k, { date: k, revenue: 0, expenses: parseFloat(r.amount) });
    totalExpenses += parseFloat(r.amount);
  }
  for (const v of byDate.values()) series.push(v);
  series.sort((a, b) => a.date.localeCompare(b.date));

  const profit = totalRevenue - totalExpenses;
  const margin = totalRevenue === 0 ? 0 : (profit / totalRevenue) * 100;

  const payload = {
    month: monthStr,
    totalRevenue,
    totalExpenses,
    profit,
    margin: Math.round(margin * 10) / 10,
    series,
  };
  await setCache(businessId, 'monthly', monthStr, payload, isCurrentMonth ? 600 : 86400);
  return payload;
}

module.exports = { dailyReport, monthlyReport };
