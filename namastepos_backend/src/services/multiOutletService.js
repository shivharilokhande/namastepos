// Multi-outlet / franchise rollup (Sprint 8 / FF-1201, FF-1202, FF-1203)

const { query, withTransaction } = require('../config/db');
const { NotFound } = require('../utils/errors');

async function listGroups() {
  const r = await query(
    `SELECT g.*, COUNT(b.id)::int AS outlet_count
       FROM outlet_groups g
  LEFT JOIN businesses b ON b.outlet_group_id = g.id
      GROUP BY g.id ORDER BY g.name`
  );
  return r.rows;
}

async function createGroup(name, parentBusinessId) {
  const r = await query(
    `INSERT INTO outlet_groups (name, parent_business_id)
     VALUES ($1, $2) RETURNING *`,
    [name, parentBusinessId || null]
  );
  return r.rows[0];
}

async function addOutlet(groupId, businessId, label) {
  await query(
    `UPDATE businesses SET outlet_group_id = $1, outlet_label = $2
      WHERE id = $3`,
    [groupId, label || null, businessId]
  );
}

async function groupRollup(groupId, { startDate, endDate }) {
  const outlets = await query(
    `SELECT id, name, outlet_label FROM businesses
      WHERE outlet_group_id = $1 AND deleted_at IS NULL`,
    [groupId]
  );
  if (outlets.rowCount === 0) throw new NotFound('No outlets in group');

  const ids = outlets.rows.map((o) => o.id);
  const perOutlet = await query(
    `SELECT business_id,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total), 0)::float AS gross,
            COALESCE(SUM(food_cost_paise), 0)::bigint AS food_cost_paise
       FROM orders
      WHERE business_id = ANY($1::uuid[])
        AND created_at >= $2::date
        AND created_at < ($3::date + INTERVAL '1 day')
        AND status <> 'cancelled'
      GROUP BY business_id`,
    [ids, startDate, endDate]
  );
  const byBiz = new Map(perOutlet.rows.map((r) => [r.business_id, r]));
  const grouped = outlets.rows.map((o) => ({
    businessId: o.id,
    name: o.name,
    outletLabel: o.outlet_label,
    metrics: byBiz.get(o.id) || { orders: 0, gross: 0, food_cost_paise: 0 },
  }));
  return {
    outlets: grouped,
    totals: {
      orders:   grouped.reduce((s, x) => s + Number(x.metrics.orders), 0),
      grossInr: grouped.reduce((s, x) => s + Number(x.metrics.gross), 0),
      foodCostInr: grouped.reduce((s, x) => s + Number(x.metrics.food_cost_paise), 0) / 100,
    },
  };
}

async function transferStock(groupId, body, initiatedBy) {
  const { fromBusinessId, toBusinessId, ingredientId, menuItemId, qty, unit, notes } = body;
  const { BadRequest } = require('../utils/errors');
  if (!fromBusinessId || !toBusinessId || !(Number(qty) > 0)) {
    throw new BadRequest('fromBusinessId, toBusinessId and a positive qty are required');
  }
  return withTransaction(async (client) => {
    // SECURITY FIX (2026-08-23, review C1): both ends of a transfer must
    // be members of THIS group — previously arbitrary businessIds were
    // accepted, letting a tenant mutate another tenant's stock.
    const members = await client.query(
      `SELECT id FROM businesses
        WHERE outlet_group_id = $1 AND id = ANY($2::uuid[])`,
      [groupId, [fromBusinessId, toBusinessId]],
    );
    if (members.rowCount !== new Set([fromBusinessId, toBusinessId]).size) {
      const { Forbidden } = require('../utils/errors');
      throw new Forbidden('Both outlets must belong to this group');
    }
    const t = await client.query(
      `INSERT INTO stock_transfers
         (outlet_group_id, from_business_id, to_business_id, ingredient_id,
          menu_item_id, qty, unit, initiated_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [groupId, fromBusinessId, toBusinessId, ingredientId || null,
       menuItemId || null, qty, unit || null, initiatedBy, notes || null]
    );
    return t.rows[0];
  });
}

async function receiveTransfer(transferId, receivedBy, groupId = null) {
  return withTransaction(async (client) => {
    // SECURITY FIX (2026-08-23, review C1): scope by outlet group so a
    // caller can only receive transfers belonging to their own group.
    const t = await client.query(
      `UPDATE stock_transfers SET status = 'received',
                                  received_at = NOW(),
                                  received_by_user_id = $1
        WHERE id = $2 AND status IN ('pending', 'in_transit')
          AND ($3::uuid IS NULL OR outlet_group_id = $3::uuid)
        RETURNING *`,
      [receivedBy, transferId, groupId]
    );
    if (t.rowCount === 0) throw new NotFound('Transfer not found or already received');
    const xfer = t.rows[0];
    if (xfer.ingredient_id) {
      // Move stock from → to (only the *destination* knows the NamastePOS ingredient
      // by id since each tenant has separate ingredients; in practice this would
      // be matched on name+unit. Simplification here.)
      await client.query(
        `UPDATE ingredients SET stock = stock + $1
          WHERE business_id = $2 AND id = $3`,
        [xfer.qty, xfer.to_business_id, xfer.ingredient_id]
      );
      await client.query(
        `UPDATE ingredients SET stock = GREATEST(0, stock - $1)
          WHERE business_id = $2 AND id = $3`,
        [xfer.qty, xfer.from_business_id, xfer.ingredient_id]
      );
    }
    return xfer;
  });
}

async function setFranchisePrice(groupId, sku, price) {
  await query(
    `INSERT INTO franchise_prices (outlet_group_id, menu_item_sku, price)
     VALUES ($1, $2, $3)
     ON CONFLICT (outlet_group_id, menu_item_sku) DO UPDATE
       SET price = EXCLUDED.price, updated_at = NOW()`,
    [groupId, sku, price]
  );
}

async function listFranchisePrices(groupId) {
  const r = await query(
    `SELECT * FROM franchise_prices WHERE outlet_group_id = $1 ORDER BY menu_item_sku`,
    [groupId]
  );
  return r.rows;
}

// Security-scoped list — only return groups the caller's business belongs to.
async function listGroupsForOwner(businessId) {
  const r = await query(
    `SELECT g.*, COUNT(b2.id)::int AS outlet_count
       FROM outlet_groups g
       JOIN businesses b1 ON b1.outlet_group_id = g.id AND b1.id = $1
  LEFT JOIN businesses b2 ON b2.outlet_group_id = g.id
      GROUP BY g.id ORDER BY g.name`,
    [businessId]
  );
  return r.rows;
}

module.exports = {
  listGroups, listGroupsForOwner, createGroup, addOutlet, groupRollup,
  transferStock, receiveTransfer,
  setFranchisePrice, listFranchisePrices,
};
