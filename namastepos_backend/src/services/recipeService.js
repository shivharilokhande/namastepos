// NamastePOS backend - recipe builder + food cost calculator
//
// A recipe is a list of (ingredient_id, qty) tuples per menu_item.
// On order placement we walk each item's recipe and deduct ingredient
// stock — capturing the per-line food cost at the moment of sale.

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

function serializeLine(r) {
  return {
    id: r.id,
    menuItemId: r.menu_item_id,
    ingredientId: r.ingredient_id,
    ingredientName: r.ingredient_name,
    ingredientUnit: r.ingredient_unit,
    ingredientStock: r.ingredient_stock !== undefined ? parseFloat(r.ingredient_stock) : null,
    costPerUnitInr: r.cost_per_unit_paise ? r.cost_per_unit_paise / 100 : 0,
    qty: parseFloat(r.qty),
    lineCostInr: r.cost_per_unit_paise
      ? (r.cost_per_unit_paise * parseFloat(r.qty)) / 100
      : 0,
    note: r.note,
  };
}

async function listForItem(businessId, menuItemId) {
  const r = await query(
    `SELECT rc.*, i.name AS ingredient_name, i.unit AS ingredient_unit,
            i.cost_per_unit_paise, i.stock AS ingredient_stock
       FROM recipes rc
       JOIN ingredients i ON i.id = rc.ingredient_id
      WHERE rc.business_id = $1 AND rc.menu_item_id = $2
      ORDER BY i.name`,
    [businessId, menuItemId]
  );
  return r.rows.map(serializeLine);
}

async function setRecipe(businessId, menuItemId, lines) {
  // Replaces the recipe atomically — lines = [{ ingredientId, qty, note }, ...]
  return withTransaction(async (client) => {
    await client.query(
      `DELETE FROM recipes WHERE business_id = $1 AND menu_item_id = $2`,
      [businessId, menuItemId]
    );
    for (const l of lines || []) {
      if (!l.ingredientId || !l.qty || l.qty <= 0) {
        throw new BadRequest('Each recipe line needs ingredientId + qty > 0');
      }
      await client.query(
        `INSERT INTO recipes (business_id, menu_item_id, ingredient_id, qty, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (menu_item_id, ingredient_id) DO UPDATE
           SET qty = EXCLUDED.qty, note = EXCLUDED.note`,
        [businessId, menuItemId, l.ingredientId, l.qty, l.note || null]
      );
    }
    return listForItem(businessId, menuItemId);
  });
}

// ── Food-cost helpers (used during order create) ───────────────────────
/**
 * Compute the food cost for a single line item (one menu_item, qty Y).
 * Returns { foodCostPaise, recipeLines }.
 * Does NOT deduct stock — that's `deductForOrder`'s job.
 */
async function previewCost(businessId, menuItemId, qty = 1) {
  const lines = await query(
    `SELECT rc.qty, i.cost_per_unit_paise
       FROM recipes rc JOIN ingredients i ON i.id = rc.ingredient_id
      WHERE rc.business_id = $1 AND rc.menu_item_id = $2`,
    [businessId, menuItemId]
  );
  let cost = 0;
  for (const l of lines.rows) {
    cost += parseFloat(l.qty) * (l.cost_per_unit_paise || 0) * qty;
  }
  return Math.round(cost);
}

/**
 * Called INSIDE the order-create transaction (after order_items insert).
 * For each order item, walks its recipe, deducts ingredient stock, logs
 * ingredient_transactions and returns the food cost.
 *
 * orderItems: [{ orderItemId, menuItemId, qty }, ...]
 */
async function deductForOrder(client, { businessId, orderId, orderItems }) {
  // QA-9 perf #5: bulk-fetch all recipe rows for all menu items in one
  // query, then batch the ingredient UPDATEs and transaction INSERTs.
  // Previously this was 1 SELECT + 2 writes per ingredient × per item —
  // typically 20-40 DB roundtrips for a 5-item order. Now: 1 SELECT,
  // 1 UPDATE (via FROM VALUES), 1 INSERT.
  let orderFoodCostPaise = 0;
  const perItem = new Map();
  if (!orderItems.length) return { orderFoodCostPaise, perItem };

  const menuIds = orderItems.map((i) => i.menuItemId).filter(Boolean);
  if (!menuIds.length) return { orderFoodCostPaise, perItem };

  // 1 SELECT, locking all touched ingredients (sorted by id to avoid deadlock).
  const recipeRows = await client.query(
    `SELECT rc.id AS recipe_id, rc.menu_item_id, rc.ingredient_id, rc.qty,
            i.stock, i.cost_per_unit_paise
       FROM recipes rc JOIN ingredients i ON i.id = rc.ingredient_id
      WHERE rc.business_id = $1 AND rc.menu_item_id = ANY($2::uuid[])
      ORDER BY rc.ingredient_id FOR UPDATE OF i`,
    [businessId, menuIds]
  );

  // Aggregate qty_change per ingredient + per-item food cost
  const ingDelta = new Map(); // ingredient_id → totalUsedQty
  const txnRows = [];
  for (const it of orderItems) {
    let itemCost = 0;
    for (const r of recipeRows.rows.filter((x) => x.menu_item_id === it.menuItemId)) {
      const usedQty = parseFloat(r.qty) * Number(it.qty);
      ingDelta.set(r.ingredient_id, (ingDelta.get(r.ingredient_id) || 0) + usedQty);
      const lineCost = (r.cost_per_unit_paise || 0) * usedQty;
      itemCost += lineCost;
      txnRows.push({
        ingredient_id: r.ingredient_id,
        used_qty: usedQty,
        cost_per_unit_paise: r.cost_per_unit_paise,
        order_item_id: it.orderItemId,
        menu_item_id: it.menuItemId,
        recipe_id: r.recipe_id,
      });
    }
    const totalForItem = Math.round(itemCost);
    if (it.orderItemId && totalForItem > 0) {
      perItem.set(it.orderItemId, totalForItem);
      orderFoodCostPaise += totalForItem;
      await client.query(
        `UPDATE order_items SET food_cost_paise = $1 WHERE id = $2`,
        [totalForItem, it.orderItemId]
      );
    }
  }

  // Single UPDATE statement deducts every ingredient at once.
  if (ingDelta.size > 0) {
    const ids = [...ingDelta.keys()];
    const deltas = ids.map((id) => ingDelta.get(id));
    await client.query(
      `UPDATE ingredients i
          SET stock = i.stock - d.used_qty
         FROM (SELECT UNNEST($1::uuid[]) AS id, UNNEST($2::numeric[]) AS used_qty) d
        WHERE i.id = d.id`,
      [ids, deltas]
    );
  }

  // Bulk-insert the transaction log via UNNEST.
  if (txnRows.length > 0) {
    await client.query(
      `INSERT INTO ingredient_transactions
         (business_id, ingredient_id, qty_change, balance_after,
          unit_cost_paise, kind, order_id, menu_item_id, recipe_id)
       SELECT $1, ing_id, -used_qty,
              (SELECT stock FROM ingredients WHERE id = ing_id),
              cost_per_unit, 'sale', $2, menu_item, recipe
         FROM UNNEST(
                $3::uuid[], $4::numeric[], $5::int[], $6::uuid[], $7::uuid[]
              ) AS t(ing_id, used_qty, cost_per_unit, menu_item, recipe)`,
      [
        businessId, orderId,
        txnRows.map((t) => t.ingredient_id),
        txnRows.map((t) => t.used_qty),
        txnRows.map((t) => t.cost_per_unit_paise || 0),
        txnRows.map((t) => t.menu_item_id),
        txnRows.map((t) => t.recipe_id),
      ]
    );
  }

  if (orderFoodCostPaise > 0) {
    await client.query(
      `UPDATE orders SET food_cost_paise = $1 WHERE id = $2`,
      [orderFoodCostPaise, orderId]
    );
  }

  return { orderFoodCostPaise, perItem };
}

// ── Food-cost report (dashboard) ───────────────────────────────────────
async function reportFoodCost(businessId, { startDate, endDate } = {}) {
  const r = await query(
    `SELECT mi.id, mi.name, mi.price,
            COALESCE(SUM(oi.qty), 0)::int AS qty_sold,
            COALESCE(SUM(oi.qty * oi.price), 0) AS revenue,
            COALESCE(SUM(oi.food_cost_paise) / 100.0, 0) AS food_cost,
            CASE
              WHEN SUM(oi.qty * oi.price) > 0
              THEN ROUND(((SUM(oi.food_cost_paise) / 100.0) / SUM(oi.qty * oi.price)) * 100, 1)
              ELSE NULL
            END AS food_cost_pct
       FROM menu_items mi
  LEFT JOIN order_items oi ON oi.menu_item_id = mi.id
  LEFT JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelled'
      WHERE mi.business_id = $1
        AND mi.is_active = TRUE
        ${startDate ? `AND o.created_at >= $2::date` : ''}
        ${endDate ? `AND o.created_at <= $${startDate ? '3' : '2'}::date + INTERVAL '1 day'` : ''}
      GROUP BY mi.id, mi.name, mi.price
      ORDER BY food_cost_pct DESC NULLS LAST`,
    [businessId, ...(startDate ? [startDate] : []), ...(endDate ? [endDate] : [])]
  );
  return r.rows.map((row) => ({
    menuItemId: row.id,
    name: row.name,
    sellPriceInr: parseFloat(row.price),
    qtySold: row.qty_sold,
    revenueInr: parseFloat(row.revenue),
    foodCostInr: parseFloat(row.food_cost),
    foodCostPct: row.food_cost_pct ? parseFloat(row.food_cost_pct) : null,
    grossMarginInr: parseFloat(row.revenue) - parseFloat(row.food_cost),
  }));
}

module.exports = {
  listForItem, setRecipe, previewCost, deductForOrder, reportFoodCost,
};
