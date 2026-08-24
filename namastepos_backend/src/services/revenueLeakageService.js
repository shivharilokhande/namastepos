// NamastePOS — Revenue leakage report (FF-246).
//
// "Leakage" = every rupee that DID NOT reach the till because someone
// on staff cancelled, discounted, or comp'd an order. Owners need to
// see this rolled up by staff member so they can spot patterns (a
// captain who "cancels" too many orders may be pocketing them).
//
// Three categories:
//   voids     — orders marked cancelled after a KOT was printed
//   discounts — sum of manual `discount` field on collected orders
//   comps     — orders with discount ≥ 100% (i.e. total = 0 after
//               discount applied). Also captures explicit "free"
//               orders when the payment_method is 'comp'.
//
// Called from GET /businesses/:businessId/reports/leakage?from=&to=.
// Owner-only via the route-level requireRole guard.
//
// Column mapping (Bug fix B5):
//   `orders` has no `cancelled_by`, `cancelled_at`, or `created_by`.
//   Attribution now uses `server_user_id` (FF-903 tip + server assign)
//   and cancellation time uses `updated_at` since the status only
//   flips to 'cancelled' via updateStatus which sets updated_at=NOW().

const { query } = require('../config/db');

// P1 fix (2026-08-22): default range must be computed in IST — the
// queries bucket by IST, but the old defaults used UTC dates.
function istDate(msOffset = 0) {
  return new Date(Date.now() + msOffset)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function summary(businessId, fromStr, toStr) {
  // Fall back to the last 30 days if no range given.
  const to = toStr || istDate();
  const from = fromStr || istDate(-30 * 24 * 3600 * 1000);

  // 1. Voids by server (cancelled after KOT print). Grouped by the
  //    server_user_id captured on the order at creation/assignment.
  const voidsQ = await query(
    `SELECT COALESCE(u.display_name, u.email, 'unassigned') AS staff_name,
            o.server_user_id                 AS staff_id,
            COUNT(*)::int                    AS n,
            COALESCE(SUM(o.total), 0)::float AS amount
       FROM orders o
  LEFT JOIN users u ON u.id = o.server_user_id
      WHERE o.business_id = $1
        AND o.status = 'cancelled'
        AND o.printed = TRUE
        -- P1 fix (2026-08-22): IST like the rest of the report
        AND (o.updated_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
      GROUP BY staff_id, staff_name
      ORDER BY amount DESC`,
    [businessId, from, to],
  );

  // 2. Discounts by server — orders with non-zero manual discount.
  const discQ = await query(
    `SELECT COALESCE(u.display_name, u.email, 'unassigned') AS staff_name,
            o.server_user_id                    AS staff_id,
            COUNT(*)::int                       AS n,
            COALESCE(SUM(o.discount), 0)::float AS amount
       FROM orders o
  LEFT JOIN users u ON u.id = o.server_user_id
      WHERE o.business_id = $1
        AND o.discount > 0
        AND o.status <> 'cancelled'
        AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
      GROUP BY staff_id, staff_name
      ORDER BY amount DESC`,
    [businessId, from, to],
  );

  // 3. Comps — 100% discount, or explicit `payment_method = 'comp'`.
  const compQ = await query(
    `SELECT COALESCE(u.display_name, u.email, 'unassigned') AS staff_name,
            o.server_user_id                    AS staff_id,
            COUNT(*)::int                       AS n,
            COALESCE(SUM(o.subtotal), 0)::float AS amount
       FROM orders o
  LEFT JOIN users u ON u.id = o.server_user_id
      WHERE o.business_id = $1
        AND o.status <> 'cancelled'
        AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
        -- P0 fix (2026-08-22): 'comp' isn't in the payment_method enum,
        -- so Postgres raised 22P02 and the whole revenue-leakage report
        -- 500'd. Reduce to the 100%-discount signal, which is what
        -- "comp" was meant to model anyway.
        AND (o.subtotal > 0 AND o.discount >= o.subtotal)
      GROUP BY staff_id, staff_name
      ORDER BY amount DESC`,
    [businessId, from, to],
  );

  // 4. Walkouts — recorded by forceCloseSessionService into
  //    revenue_leakage_events (2026-08-22, migration 054).
  const walkQ = await query(
    `SELECT kind, COUNT(*)::int AS n,
            COALESCE(SUM(amount_paise), 0)::float / 100 AS amount
       FROM revenue_leakage_events
      WHERE business_id = $1
        AND (detected_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
      GROUP BY kind
      ORDER BY amount DESC`,
    [businessId, from, to],
  );

  const sumAmount = (rows) => rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const sumCount = (rows) => rows.reduce((s, r) => s + (parseInt(r.n, 10) || 0), 0);
  return {
    from,
    to,
    voids: { rows: voidsQ.rows, totalAmount: sumAmount(voidsQ.rows), totalCount: sumCount(voidsQ.rows) },
    discounts: { rows: discQ.rows, totalAmount: sumAmount(discQ.rows), totalCount: sumCount(discQ.rows) },
    comps: { rows: compQ.rows, totalAmount: sumAmount(compQ.rows), totalCount: sumCount(compQ.rows) },
    walkouts: { rows: walkQ.rows, totalAmount: sumAmount(walkQ.rows), totalCount: sumCount(walkQ.rows) },
    totalLeakage:
      sumAmount(voidsQ.rows) + sumAmount(discQ.rows) + sumAmount(compQ.rows)
      + sumAmount(walkQ.rows),
  };
}

module.exports = { summary };
