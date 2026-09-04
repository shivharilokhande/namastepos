// Daily closing / Z-report (Sprint 2 / FF-403)

const { query, withTransaction } = require('../config/db');
const { Conflict } = require('../utils/errors');

async function preview(businessId, date) {
  // P1 fix (2026-08-22): default "today" in IST (queries bucket by IST).
  const day = date
    || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [orders, payments, cancels, discounts] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS gross
         FROM orders
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND status <> 'cancelled'`,
      [businessId, day],
    ),
    query(
      `SELECT payment_method, COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS amt
         FROM orders
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND status NOT IN ('cancelled')
        GROUP BY payment_method`,
      [businessId, day],
    ),
    query(
      `SELECT cancel_reason_code AS code, COUNT(*)::int AS n,
              COALESCE(SUM(total), 0)::float AS lost
         FROM orders
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND status = 'cancelled'
        GROUP BY cancel_reason_code`,
      [businessId, day],
    ),
    query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(discount), 0)::float AS given
         FROM orders
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND status <> 'cancelled' AND discount > 0`,
      [businessId, day],
    ),
  ]);

  const cashRow = payments.rows.find((p) => p.payment_method === 'cash');
  const cashExpected = Math.round((cashRow?.amt || 0) * 100);

  return {
    date: day,
    grossSales: orders.rows[0].gross,
    orderCount: orders.rows[0].n,
    paymentBreakdown: payments.rows.reduce((acc, r) => {
      acc[r.payment_method] = { count: r.n, amount: r.amt };
      return acc;
    }, {}),
    cancellations: cancels.rows.reduce((acc, r) => {
      acc[r.code || 'unspecified'] = { count: r.n, lostInr: r.lost };
      return acc;
    }, {}),
    discountsGiven: discounts.rows[0],
    cashExpectedPaise: cashExpected,
  };
}

async function close(businessId, body) {
  const { date, cashCounted, notes, signature, closedByUserId } = body;
  return withTransaction(async (client) => {
    // No double-close
    const dup = await client.query(
      'SELECT id FROM daily_closings WHERE business_id = $1 AND closing_date = $2',
      [businessId, date],
    );
    if (dup.rowCount > 0) throw new Conflict('Day already closed');

    const payload = await preview(businessId, date);
    const ins = await client.query(
      `INSERT INTO daily_closings
         (business_id, closing_date, payload, cash_expected, cash_counted,
          signature, notes, closed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [businessId, date, payload, payload.cashExpectedPaise, cashCounted,
        signature, notes, closedByUserId],
    );
    // Lock all orders on that date from edits
    await client.query(
      `UPDATE orders SET day_closed = TRUE
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
      [businessId, date],
    );
    return ins.rows[0];
  });
}

async function list(businessId, { limit = 30 } = {}) {
  const r = await query(
    `SELECT * FROM daily_closings
      WHERE business_id = $1
      ORDER BY closing_date DESC LIMIT $2`,
    [businessId, limit],
  );
  return r.rows;
}

async function reopen(businessId, date) {
  // Admin override — clears the lock so the day can be edited again
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM daily_closings WHERE business_id = $1 AND closing_date = $2',
      [businessId, date],
    );
    await client.query(
      `UPDATE orders SET day_closed = FALSE
        WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
      [businessId, date],
    );
  });
}

module.exports = { preview, close, list, reopen };
