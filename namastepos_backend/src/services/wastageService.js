// Wastage tracking (Sprint 2 / FF-402)

const { query, withTransaction } = require('../config/db');
const { BadRequest } = require('../utils/errors');

async function log(businessId, body, userId) {
  const { ingredientId, menuItemId, qty, unit, costPaise, reason, note } = body;
  if (!qty || qty <= 0) throw new BadRequest('qty must be positive');
  return withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO wastage_log
         (business_id, ingredient_id, menu_item_id, qty, unit,
          cost_paise, reason, note, logged_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [businessId, ingredientId || null, menuItemId || null, qty,
       unit || null, costPaise || 0, reason, note || null, userId || null]
    );
    // Decrement ingredient stock
    if (ingredientId) {
      await client.query(
        `UPDATE ingredients SET stock = GREATEST(0, stock - $1)
          WHERE business_id = $2 AND id = $3`,
        [qty, businessId, ingredientId]
      );
      await client.query(
        `INSERT INTO ingredient_transactions
           (business_id, ingredient_id, qty_change, balance_after, kind, note)
         SELECT $1, $2, -$3,
                (SELECT stock FROM ingredients WHERE id = $2),
                'waste', $4`,
        [businessId, ingredientId, qty, note || `Wastage: ${reason}`]
      );
    }
    return r.rows[0];
  }).then(async (row) => {
    // 2026-08-23 (founder): wasted food's making cost must show up in
    // Expenses too — e.g. 10 over-prepared teas at ₹8 cost = ₹80 expense.
    // Post-commit + best-effort so an un-migrated enum ('wastage' added
    // in 055) can never fail the wastage log itself.
    if ((costPaise || 0) > 0) {
      try {
        await query(
          `INSERT INTO expenses (business_id, category, amount, description, date)
           VALUES ($1, 'wastage', $2, $3,
                   (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
          [businessId, costPaise / 100,
            `Wastage (${reason})${note ? ` — ${note}` : ''}`]
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[wastage] expense mirror failed: ${e?.message}`);
      }
    }
    return row;
  });
}

async function report(businessId, { startDate, endDate } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId]; let idx = 2;
  if (startDate) { where.push(`created_at >= $${idx++}::date`); values.push(startDate); }
  if (endDate)   { where.push(`created_at < ($${idx++}::date + INTERVAL '1 day')`); values.push(endDate); }
  const total = await query(
    `SELECT COALESCE(SUM(cost_paise), 0) / 100.0 AS total_inr,
            COUNT(*)::int AS event_count
       FROM wastage_log WHERE ${where.join(' AND ')}`,
    values
  );
  const byReason = await query(
    `SELECT reason, COUNT(*)::int AS n,
            COALESCE(SUM(cost_paise), 0) / 100.0 AS inr
       FROM wastage_log WHERE ${where.join(' AND ')}
       GROUP BY reason ORDER BY inr DESC`,
    values
  );
  // 2026-08-22: also join menu_items — mobile logs wastage against menu
  // items, and `recent` had no display name for those rows.
  const recentWhere = where.map((w) => w
    .replace('business_id', 'wl.business_id')
    .replace('created_at', 'wl.created_at')); // avoid ambiguity with joins
  const recent = await query(
    `SELECT wl.*, i.name AS ingredient_name, mi.name AS menu_item_name
       FROM wastage_log wl
  LEFT JOIN ingredients i ON i.id = wl.ingredient_id
  LEFT JOIN menu_items mi ON mi.id = wl.menu_item_id
      WHERE ${recentWhere.join(' AND ')}
      ORDER BY wl.created_at DESC LIMIT 100`,
    values
  );
  return {
    summary: total.rows[0],
    byReason: byReason.rows,
    recent: recent.rows,
  };
}

module.exports = { log, report };
