// Co-purchase / upsell suggestions (F42) — market-basket from order_items.

const { query, withTransaction } = require('../config/db');

async function refreshRules(businessId) {
  return withTransaction(async (client) => {
    // Find pairs that co-occur in the same order, weighted by recency.
    // Confidence = (#orders with both A and B) / (#orders with A) × 100.
    await client.query('DELETE FROM co_purchase_rules WHERE business_id = $1', [businessId]);
    await client.query(
      `INSERT INTO co_purchase_rules
         (business_id, anchor_item_id, suggested_item_id, confidence, co_count)
       SELECT $1, a.menu_item_id, b.menu_item_id,
              ROUND(COUNT(*)::numeric * 100 /
                NULLIF((SELECT COUNT(DISTINCT order_id) FROM order_items
                         WHERE menu_item_id = a.menu_item_id), 0), 2),
              COUNT(*)::int
         FROM order_items a
         JOIN order_items b ON b.order_id = a.order_id AND b.menu_item_id <> a.menu_item_id
         JOIN orders o ON o.id = a.order_id
        WHERE o.business_id = $1
          AND o.created_at > NOW() - INTERVAL '60 days'
        GROUP BY a.menu_item_id, b.menu_item_id
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) DESC
        LIMIT 500`,
      [businessId],
    );
    const cnt = await client.query(
      'SELECT COUNT(*)::int AS n FROM co_purchase_rules WHERE business_id = $1',
      [businessId],
    );
    return { rulesGenerated: cnt.rows[0].n };
  });
}

async function suggestFor(businessId, menuItemId, limit = 3) {
  const r = await query(
    `SELECT cr.*, mi.name AS suggested_name, mi.price AS suggested_price
       FROM co_purchase_rules cr
       JOIN menu_items mi ON mi.id = cr.suggested_item_id
      WHERE cr.business_id = $1 AND cr.anchor_item_id = $2
        AND mi.is_active = TRUE AND mi.sold_out_until IS NULL
      ORDER BY cr.confidence DESC LIMIT $3`,
    [businessId, menuItemId, limit],
  );
  return r.rows;
}

module.exports = { refreshRules, suggestFor };
