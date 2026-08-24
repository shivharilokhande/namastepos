// NamastePOS backend - menu CRUD service

const { query, withTransaction } = require('../config/db');
const { NotFound, Conflict } = require('../utils/errors');

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: parseFloat(row.price),
    costPrice: row.cost_price !== null ? parseFloat(row.cost_price) : null,
    sku: row.sku,
    unit: row.unit,
    stock: parseFloat(row.stock),
    reorderLevel: parseFloat(row.reorder_level),
    isActive: row.is_active,
    isVeg: row.is_veg,
    imageUrl: row.image_url,
    // Combo + display polish (migration 012)
    isCombo: row.is_combo || false,
    comboItems: row.combo_items || null,
    prepMinutes: row.prep_minutes || null,
    displayOrder: row.display_order ?? 100,
    tags: row.tags || null,
    // GST (migration 017 + 033)
    gstPct: row.gst_pct !== null && row.gst_pct !== undefined
      ? parseFloat(row.gst_pct) : null,
    hsnCode: row.hsn_code || null,
    // 86'd until (2026-08-23): the mobile toggle + POS grid need this —
    // it was never serialized, so "Marked sold-out" changed nothing on
    // screen and the item stayed orderable.
    soldOutUntil: row.sold_out_until || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list(businessId, { category, isActive, isCombo, search } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId];
  let idx = 2;
  if (category) { where.push(`category = $${idx++}`); values.push(category); }
  if (typeof isActive === 'boolean') {
    where.push(`is_active = $${idx++}`); values.push(isActive);
  }
  if (typeof isCombo === 'boolean') {
    where.push(`is_combo = $${idx++}`); values.push(isCombo);
  }
  if (search) {
    where.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
    values.push(`%${search}%`); idx += 1;
  }
  const r = await query(
    `SELECT * FROM menu_items WHERE ${where.join(' AND ')}
     ORDER BY category ASC, display_order ASC, name ASC`,
    values
  );
  return r.rows.map(serialize);
}

async function byId(businessId, itemId) {
  const r = await query(
    `SELECT * FROM menu_items WHERE business_id = $1 AND id = $2 LIMIT 1`,
    [businessId, itemId]
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return serialize(r.rows[0]);
}

async function create(businessId, body) {
  const {
    name, description, category = 'Food', price, costPrice = null, sku = null,
    unit = 'piece', stock = 0, reorderLevel = 10, isActive = true, isVeg = true,
    imageUrl = null,
    // Combo polish (migration 012)
    isCombo = false, comboItems = null, prepMinutes = null,
    displayOrder = 100, tags = null,
  } = body;

  try {
    const r = await query(
      `INSERT INTO menu_items
       (business_id, name, description, category, price, cost_price, sku, unit,
        stock, reorder_level, is_active, is_veg, image_url,
        is_combo, combo_items, prep_minutes, display_order, tags,
        gst_pct, hsn_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               COALESCE($19, 5),$20)
       RETURNING *`,
      [businessId, name, description, category, price, costPrice, sku, unit,
       stock, reorderLevel, isActive, isVeg, imageUrl,
       isCombo, comboItems ? JSON.stringify(comboItems) : null,
       prepMinutes, displayOrder, tags,
       body.gstPct, body.hsnCode]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('SKU already exists in this business');
    throw err;
  }
}

async function update(businessId, itemId, body) {
  const allowed = {
    name: 'name', description: 'description', category: 'category',
    price: 'price', costPrice: 'cost_price', sku: 'sku', unit: 'unit',
    stock: 'stock', reorderLevel: 'reorder_level', isActive: 'is_active',
    isVeg: 'is_veg', imageUrl: 'image_url',
    isCombo: 'is_combo', prepMinutes: 'prep_minutes',
    displayOrder: 'display_order', tags: 'tags',
    gstPct: 'gst_pct', hsnCode: 'hsn_code',
  };
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (body[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(body[k]); }
  }
  // comboItems needs JSON-stringification for pg
  if (body.comboItems !== undefined) {
    sets.push(`combo_items = $${idx++}`);
    values.push(body.comboItems ? JSON.stringify(body.comboItems) : null);
  }
  if (!sets.length) return byId(businessId, itemId);
  values.push(businessId, itemId);
  const r = await query(
    `UPDATE menu_items SET ${sets.join(', ')}
     WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return serialize(r.rows[0]);
}

async function softDelete(businessId, itemId) {
  const r = await query(
    `UPDATE menu_items SET is_active = FALSE
     WHERE business_id = $1 AND id = $2 RETURNING id`,
    [businessId, itemId]
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return { id: r.rows[0].id };
}

/** Adjust stock and log an inventory transaction. */
async function adjustStock(businessId, itemId, { delta, reason = 'adjustment', note = null }) {
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT stock FROM menu_items WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, itemId]
    );
    if (cur.rowCount === 0) throw new NotFound('Menu item not found');
    const before = parseFloat(cur.rows[0].stock);
    const after = before + delta;

    const upd = await client.query(
      `UPDATE menu_items SET stock = $1 WHERE id = $2 RETURNING *`,
      [after, itemId]
    );
    await client.query(
      `INSERT INTO inventory_transactions
       (business_id, menu_item_id, qty_change, balance_after, reason, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [businessId, itemId, delta, after, reason, note]
    );
    return serialize(upd.rows[0]);
  });
}

async function stockHistory(businessId, itemId, { limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM inventory_transactions
     WHERE business_id = $1 AND menu_item_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [businessId, itemId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    menuItemId: row.menu_item_id,
    qtyChange: parseFloat(row.qty_change),
    balanceAfter: parseFloat(row.balance_after),
    reason: row.reason,
    orderId: row.order_id,
    note: row.note,
    createdAt: row.created_at,
  }));
}

/**
 * Push 20b — bulk import. Used by super-admin to ingest a CSV of menu
 * items for a customer in one shot. Each row independently validated;
 * collects per-row errors instead of rolling back on the first bad row
 * so the operator sees "47/50 imported, 3 had issues" rather than an
 * all-or-nothing failure.
 *
 * Accepted row shape (all string-or-number; case-insensitive keys):
 *   name (required), price (required),
 *   category, description, sku, unit, stock, gst_pct, hsn_code,
 *   is_active, is_veg
 *
 * Returns { inserted, skipped, errors[] } where each error is
 * { row: <index 1-based>, name, message }.
 */
async function bulkImport(businessId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { inserted: 0, skipped: 0, errors: [{ row: 0, message: 'No items in payload' }] };
  }
  let inserted = 0; let skipped = 0;
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] || {};
    // Normalise keys to camel/snake whichever the caller used
    const get = (...keys) => {
      for (const k of keys) {
        if (raw[k] != null && raw[k] !== '') return raw[k];
      }
      return undefined;
    };
    const name = String(get('name', 'Name') || '').trim();
    const priceRaw = get('price', 'Price');
    const price = priceRaw == null || priceRaw === '' ? NaN : Number(priceRaw);
    if (!name) {
      errors.push({ row: i + 1, message: 'Missing name' });
      skipped++; continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ row: i + 1, name, message: 'Invalid price' });
      skipped++; continue;
    }
    try {
      await create(businessId, {
        name,
        price,
        description: get('description', 'Description') || null,
        category: get('category', 'Category') || 'Other',
        sku: get('sku', 'SKU') || null,
        unit: get('unit', 'Unit') || 'piece',
        stock: Number(get('stock', 'Stock') || 0),
        gstPct: get('gst_pct', 'gstPct', 'GST') != null
          ? Number(get('gst_pct', 'gstPct', 'GST')) : 5,
        hsnCode: get('hsn_code', 'hsnCode', 'HSN') || null,
        isActive: String(get('is_active', 'isActive', 'Active') ?? 'true').toLowerCase() !== 'false',
        isVeg: String(get('is_veg', 'isVeg', 'Veg') ?? 'true').toLowerCase() !== 'false',
      });
      inserted++;
    } catch (e) {
      errors.push({ row: i + 1, name, message: e.message || 'Insert failed' });
      skipped++;
    }
  }
  return { inserted, skipped, errors };
}

module.exports = { serialize, list, byId, create, update, softDelete, adjustStock, stockHistory, bulkImport };
