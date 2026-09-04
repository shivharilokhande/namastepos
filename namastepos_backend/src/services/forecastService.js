// Demand forecasting (F45) — simple weighted-average of last 14 days,
// boosted by same-weekday history. Good enough to suggest tomorrow's buys.

const { query, withTransaction } = require('../config/db');

async function refreshForecast(businessId) {
  return withTransaction(async (client) => {
    // Aggregate ingredient consumption from ingredient_transactions
    const usage = await client.query(
      `SELECT ingredient_id,
              DATE(created_at) AS day,
              SUM(ABS(qty_change))::numeric AS qty_used,
              EXTRACT(DOW FROM created_at)::int AS dow
         FROM ingredient_transactions
        WHERE business_id = $1
          AND kind = 'sale'
          AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY ingredient_id, DATE(created_at), EXTRACT(DOW FROM created_at)`,
      [businessId],
    );

    // For each ingredient, project tomorrow's qty = 0.7 * 14d average + 0.3 * same-weekday average
    const byIng = new Map();
    for (const r of usage.rows) {
      if (!byIng.has(r.ingredient_id)) byIng.set(r.ingredient_id, { sum: 0, count: 0, byDow: {} });
      const e = byIng.get(r.ingredient_id);
      e.sum += parseFloat(r.qty_used);
      e.count += 1;
      const { dow } = r;
      if (!e.byDow[dow]) e.byDow[dow] = { sum: 0, count: 0 };
      e.byDow[dow].sum += parseFloat(r.qty_used);
      e.byDow[dow].count += 1;
    }

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowDow = tomorrow.getDay();
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);

    let updated = 0;
    for (const [ingId, e] of byIng.entries()) {
      const fourteenAvg = e.count > 0 ? e.sum / e.count : 0;
      const dowAvg = e.byDow[tomorrowDow]
        ? e.byDow[tomorrowDow].sum / e.byDow[tomorrowDow].count
        : fourteenAvg;
      const expected = (fourteenAvg * 0.7) + (dowAvg * 0.3);
      await client.query(
        `INSERT INTO demand_forecasts
           (business_id, ingredient_id, forecast_date, expected_qty)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, ingredient_id, forecast_date)
         DO UPDATE SET expected_qty = EXCLUDED.expected_qty, refreshed_at = NOW()`,
        [businessId, ingId, tomorrowDate, expected],
      );
      updated += 1;
    }
    return { updated, forecastDate: tomorrowDate };
  });
}

async function getForecast(businessId, date) {
  const r = await query(
    `SELECT df.*, i.name, i.unit, i.stock, i.reorder_level
       FROM demand_forecasts df
       JOIN ingredients i ON i.id = df.ingredient_id
      WHERE df.business_id = $1 AND df.forecast_date = $2
      ORDER BY df.expected_qty DESC`,
    [businessId, date || new Date(Date.now() + 86400000).toISOString().slice(0, 10)],
  );
  // Add "needs reorder" flag
  return r.rows.map((x) => ({
    ...x,
    needsReorder: parseFloat(x.stock) < parseFloat(x.expected_qty),
    shortBy: Math.max(0, parseFloat(x.expected_qty) - parseFloat(x.stock)),
  }));
}

module.exports = { refreshForecast, getForecast };
