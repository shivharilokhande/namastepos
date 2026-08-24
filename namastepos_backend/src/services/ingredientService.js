// NamastePOS backend - raw-ingredient inventory service
//
// Weighted-average cost:
//   When a purchase comes in, we recompute cost_per_unit_paise as
//   ((old_stock * old_cost) + (purchase_qty * purchase_unit_cost)) / new_stock
//   so the food-cost reports stay accurate as supplier prices fluctuate.

const { query, withTransaction } = require('../config/db');
const { NotFound, Conflict, BadRequest } = require('../utils/errors');

function serialize(i) {
  return {
    id: i.id,
    businessId: i.business_id,
    name: i.name,
    category: i.category,
    unit: i.unit,
    stock: parseFloat(i.stock),
    reorderLevel: parseFloat(i.reorder_level),
    costPerUnitInr: i.cost_per_unit_paise / 100,
    costPerUnitPaise: i.cost_per_unit_paise,
    vendor: i.vendor,
    vendorPhone: i.vendor_phone,
    notes: i.notes,
    isActive: i.is_active,
    isLow: parseFloat(i.stock) <= parseFloat(i.reorder_level) && parseFloat(i.reorder_level) > 0,
    createdAt: i.created_at,
  };
}

function serializeTxn(t) {
  return {
    id: t.id,
    ingredientId: t.ingredient_id,
    qtyChange: parseFloat(t.qty_change),
    balanceAfter: parseFloat(t.balance_after),
    unitCostPaise: t.unit_cost_paise,
    kind: t.kind,
    orderId: t.order_id,
    menuItemId: t.menu_item_id,
    note: t.note,
    createdAt: t.created_at,
  };
}

// ── CRUD ───────────────────────────────────────────────────────────────
async function list(businessId, { search, category, onlyActive = true, onlyLow = false } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId];
  let idx = 2;
  if (onlyActive) where.push(`is_active = TRUE`);
  if (search) {
    where.push(`name ILIKE $${idx++}`);
    values.push(`%${search}%`);
  }
  if (category) { where.push(`category = $${idx++}`); values.push(category); }
  if (onlyLow) where.push(`stock <= reorder_level AND reorder_level > 0`);

  const r = await query(
    `SELECT * FROM ingredients WHERE ${where.join(' AND ')}
     ORDER BY category NULLS LAST, name ASC`,
    values
  );
  return r.rows.map(serialize);
}

async function byId(businessId, id) {
  const r = await query(
    `SELECT * FROM ingredients WHERE business_id = $1 AND id = $2 LIMIT 1`,
    [businessId, id]
  );
  if (r.rowCount === 0) throw new NotFound('Ingredient not found');
  return serialize(r.rows[0]);
}

async function create(businessId, body) {
  if (!body.name) throw new BadRequest('Name is required');
  try {
    const r = await query(
      `INSERT INTO ingredients
         (business_id, name, category, unit, stock, reorder_level,
          cost_per_unit_paise, vendor, vendor_phone, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [businessId, body.name, body.category || null, body.unit || 'g',
       body.stock || 0, body.reorderLevel || 0,
       Math.round((body.costPerUnitInr || 0) * 100),
       body.vendor || null, body.vendorPhone || null,
       body.notes || null, body.isActive !== false]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict(`Ingredient "${body.name}" already exists`);
    throw err;
  }
}

async function update(businessId, id, patch) {
  const allowed = {
    name: 'name', category: 'category', unit: 'unit',
    reorderLevel: 'reorder_level', vendor: 'vendor',
    vendorPhone: 'vendor_phone', notes: 'notes', isActive: 'is_active',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(patch[k]); }
  }
  if (patch.costPerUnitInr !== undefined) {
    sets.push(`cost_per_unit_paise = $${idx++}`);
    values.push(Math.round(patch.costPerUnitInr * 100));
  }
  if (sets.length === 0) return byId(businessId, id);
  values.push(businessId, id);
  const r = await query(
    `UPDATE ingredients SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Ingredient not found');
  return serialize(r.rows[0]);
}

async function softDelete(businessId, id) {
  await query(
    `UPDATE ingredients SET is_active = FALSE
      WHERE business_id = $1 AND id = $2`,
    [businessId, id]
  );
  return { id };
}

// ── Purchase / stock adjustment ───────────────────────────────────────
/**
 * Receive a purchase: bumps stock + recalculates weighted-avg cost.
 * Pass either unitCostInr (per-unit cost) or totalCostInr (line total).
 */
async function recordPurchase(businessId, id, { qty, unitCostInr, totalCostInr, vendor, note }) {
  if (!qty || qty <= 0) throw new BadRequest('qty must be > 0');
  const unitCostPaise = unitCostInr !== undefined
    ? Math.round(unitCostInr * 100)
    : Math.round((Number(totalCostInr) * 100) / qty);

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT stock, cost_per_unit_paise FROM ingredients
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, id]
    );
    if (cur.rowCount === 0) throw new NotFound('Ingredient not found');
    const oldStock = parseFloat(cur.rows[0].stock);
    const oldCost = cur.rows[0].cost_per_unit_paise;
    const newStock = oldStock + Number(qty);
    // Weighted-average — only update cost if it actually shifts
    const newCost = oldStock <= 0
      ? unitCostPaise
      : Math.round(((oldStock * oldCost) + (qty * unitCostPaise)) / newStock);

    await client.query(
      `UPDATE ingredients
          SET stock = $1, cost_per_unit_paise = $2,
              vendor = COALESCE($3, vendor)
        WHERE id = $4`,
      [newStock, newCost, vendor || null, id]
    );

    await client.query(
      `INSERT INTO ingredient_transactions
         (business_id, ingredient_id, qty_change, balance_after,
          unit_cost_paise, kind, note)
       VALUES ($1, $2, $3, $4, $5, 'purchase', $6)`,
      [businessId, id, qty, newStock, unitCostPaise, note || null]
    );

    return byId(businessId, id);
  });
}

/** Generic stock adjustment (waste, spoilage, manual) — does NOT change avg cost. */
async function adjustStock(businessId, id, { delta, kind = 'adjustment', note }) {
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT stock, cost_per_unit_paise FROM ingredients
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, id]
    );
    if (cur.rowCount === 0) throw new NotFound('Ingredient not found');
    const newStock = parseFloat(cur.rows[0].stock) + Number(delta);
    await client.query(`UPDATE ingredients SET stock = $1 WHERE id = $2`, [newStock, id]);
    await client.query(
      `INSERT INTO ingredient_transactions
         (business_id, ingredient_id, qty_change, balance_after,
          unit_cost_paise, kind, note)
       VALUES ($1, $2, $3, $4, $5, $6::ingredient_txn_kind, $7)`,
      [businessId, id, delta, newStock, cur.rows[0].cost_per_unit_paise, kind, note || null]
    );
    return byId(businessId, id);
  });
}

async function transactions(businessId, id, { limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM ingredient_transactions
      WHERE business_id = $1 AND ingredient_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [businessId, id, limit]
  );
  return r.rows.map(serializeTxn);
}

module.exports = {
  list, byId, create, update, softDelete,
  recordPurchase, adjustStock, transactions,
  serialize,
};
