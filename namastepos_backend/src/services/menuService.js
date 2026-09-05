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
    // NP-205 (migration 084): FALSE = stock not tracked (unlimited — the
    // number above is ignored by the order path); TRUE = finite, and <= 0
    // means SOLD OUT. Every UI that renders "Out of stock" must read this
    // first, or an untracked item at 0 looks sold out when it isn't.
    trackStock: row.track_stock === true,
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

async function list(businessId, {
  category, isActive, isCombo, search, withVariants,
} = {}) {
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
    values,
  );
  const items = r.rows.map(serialize);

  // NP-205 — `?withVariants=true` hydrates each item with its ACTIVE variants
  // in ONE extra query.
  //
  // WHY this exists: the web POS (NewOrderDialog) decided whether to open the
  // variant/modifier picker from `item.variants`, but `GET /menu` never
  // returned that key — so on the dashboard a dish with sizes was added
  // straight to the cart at the parent price and the picker was dead code.
  // The inventory screens need the same payload to show a row per size.
  // Opt-in rather than always-on so the existing consumers (offline sync,
  // aggregator menu push, mobile menu cache) keep their exact response shape
  // and cost.
  if (withVariants && items.length > 0) {
    const { serializeVariant } = require('./variantService');
    const vr = await query(
      `SELECT * FROM menu_item_variants
        WHERE business_id = $1 AND menu_item_id = ANY($2::uuid[])
          AND is_active = TRUE
        ORDER BY display_order, label`,
      [businessId, items.map((i) => i.id)],
    );
    const byItem = new Map();
    for (const row of vr.rows) {
      if (!byItem.has(row.menu_item_id)) byItem.set(row.menu_item_id, []);
      byItem.get(row.menu_item_id).push(serializeVariant(row));
    }
    for (const it of items) it.variants = byItem.get(it.id) || [];
  }
  return items;
}

async function byId(businessId, itemId) {
  const r = await query(
    'SELECT * FROM menu_items WHERE business_id = $1 AND id = $2 LIMIT 1',
    [businessId, itemId],
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return serialize(r.rows[0]);
}

/**
 * @param {object} [client] run on an open transaction's client instead of the
 *   pool. REQUIRED when called from inside withTransaction (see bulkImport) —
 *   a pool write would land outside the transaction and survive its rollback.
 *   Same convention as variantService.listVariants.
 */
async function create(businessId, body, client = null) {
  const run = client ? client.query.bind(client) : query;
  const {
    name, description, category = 'Food', price, costPrice = null, sku = null,
    unit = 'piece', stock = 0, reorderLevel = 10, isActive = true, isVeg = true,
    imageUrl = null,
    // Combo polish (migration 012)
    isCombo = false, comboItems = null, prepMinutes = null,
    displayOrder = 100, tags = null,
  } = body;

  // NP-205 (migration 084): tracking is EXPLICIT. When the caller doesn't say,
  // infer it exactly the way the 084 backfill did — an owner who typed an
  // opening stock meant to track it; stock 0 / omitted means "unlimited".
  // Without this inference every CSV import and every existing client (which
  // sends `stock` but not `trackStock`) would create items whose stock is
  // silently ignored by the order path.
  const trackStock = body.trackStock !== undefined
    ? !!body.trackStock
    : (stock != null && Number(stock) !== 0);

  // 2026-09-05 (migration 092) — the GST slab an omitted `gstPct` falls back
  // to is the BUSINESS's declared scheme, not the literal 5 that used to sit
  // in the SQL below. A composition dealer charges the diner nothing (0), a
  // specified-premises restaurant charges 18, everyone else 5 — which is what
  // the hardcoded default meant all along, it just never asked.
  //
  // Resolved here, once, only when the caller did not send a slab. bulkImport
  // resolves it ONCE for the whole file and stamps every row, so a 200-row
  // CSV does not run 200 of these reads; `body.gstPct` is always set by the
  // time those rows reach us.
  //
  // The COALESCE($19, 5) in the INSERT below is belt-and-braces only now:
  // `gstPct` is already scheme-resolved and non-null by the time it is bound.
  // It stays so a future caller passing an explicit null still lands on a
  // valid slab rather than violating the NOT NULL.
  const gstPct = body.gstPct != null
    ? body.gstPct
    // eslint-disable-next-line global-require
    : await require('./gstSchemeService').defaultGstPctFor(businessId, client);

  try {
    const r = await run(
      `INSERT INTO menu_items
       (business_id, name, description, category, price, cost_price, sku, unit,
        stock, reorder_level, is_active, is_veg, image_url,
        is_combo, combo_items, prep_minutes, display_order, tags,
        gst_pct, hsn_code, track_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               COALESCE($19, 5),$20,$21)
       RETURNING *`,
      [businessId, name, description, category, price, costPrice, sku, unit,
        stock, reorderLevel, isActive, isVeg, imageUrl,
        isCombo, comboItems ? JSON.stringify(comboItems) : null,
        prepMinutes, displayOrder, tags,
        gstPct, body.hsnCode, trackStock],
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('SKU already exists in this business');
    throw err;
  }
}

async function update(businessId, itemId, body) {
  const allowed = {
    name: 'name',
    description: 'description',
    category: 'category',
    price: 'price',
    costPrice: 'cost_price',
    sku: 'sku',
    unit: 'unit',
    stock: 'stock',
    // NP-205: no inference on UPDATE — a partial edit that touches `stock`
    // must not flip a deliberate tracking choice behind the owner's back
    // (that is the `noDefaults` lesson from 2026-08-23 applied to a boolean).
    trackStock: 'track_stock',
    reorderLevel: 'reorder_level',
    isActive: 'is_active',
    isVeg: 'is_veg',
    imageUrl: 'image_url',
    isCombo: 'is_combo',
    prepMinutes: 'prep_minutes',
    displayOrder: 'display_order',
    tags: 'tags',
    gstPct: 'gst_pct',
    hsnCode: 'hsn_code',
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
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return serialize(r.rows[0]);
}

async function softDelete(businessId, itemId) {
  const r = await query(
    `UPDATE menu_items SET is_active = FALSE
     WHERE business_id = $1 AND id = $2 RETURNING id`,
    [businessId, itemId],
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  return { id: r.rows[0].id };
}

/**
 * Adjust stock and log an inventory transaction.
 *
 * NP-205: recording a count IS the act of choosing to track. An owner who
 * opens Inventory and books "+10 received" on an item that was never tracked
 * expects the number to mean something afterwards, so a non-zero balance
 * turns tracking ON (same rule as the 084 backfill and `create` above).
 * `trackStock` in the body overrides that outright — including turning
 * tracking OFF, which is how an owner says "stop nagging me about this one,
 * it's unlimited" without having to zero the count first.
 */
async function adjustStock(
  businessId,
  itemId,
  { delta, reason = 'adjustment', note = null, trackStock = undefined },
) {
  return withTransaction(async (client) => {
    const cur = await client.query(
      'SELECT stock, track_stock FROM menu_items WHERE business_id = $1 AND id = $2 FOR UPDATE',
      [businessId, itemId],
    );
    if (cur.rowCount === 0) throw new NotFound('Menu item not found');
    const before = parseFloat(cur.rows[0].stock);
    const after = before + delta;
    const track = trackStock !== undefined
      ? !!trackStock
      : (cur.rows[0].track_stock === true || after !== 0);

    const upd = await client.query(
      'UPDATE menu_items SET stock = $1, track_stock = $2 WHERE id = $3 RETURNING *',
      [after, track, itemId],
    );
    await client.query(
      `INSERT INTO inventory_transactions
       (business_id, menu_item_id, qty_change, balance_after, reason, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [businessId, itemId, delta, after, reason, note],
    );
    return serialize(upd.rows[0]);
  });
}

/**
 * NP-205 — the variant twin of `adjustStock`, so an inventory screen can set
 * one size's count without PUTting the whole variant list back (which is
 * replace-all and would race with a concurrent menu edit).
 *
 * Tenant-scoped through `menu_item_variants.business_id`, and the parent id
 * is resolved from the row itself so the ledger's `menu_item_id` (still the
 * PARENT, see 084) can never be spoofed by the caller.
 */
async function adjustVariantStock(
  businessId,
  variantId,
  { delta, reason = 'adjustment', note = null, trackStock = undefined },
) {
  const variants = require('./variantService');
  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT id, menu_item_id, stock, track_stock FROM menu_item_variants
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, variantId],
    );
    if (cur.rowCount === 0) throw new NotFound('Variant not found');
    // NULL stock (013's "share parent stock") starts from 0 — under NP-205 a
    // variant tracks its own stock or is unlimited; there is no sharing.
    const before = cur.rows[0].stock == null ? 0 : parseFloat(cur.rows[0].stock);
    const after = before + delta;
    const track = trackStock !== undefined
      ? !!trackStock
      : (cur.rows[0].track_stock === true || after !== 0);

    const upd = await client.query(
      `UPDATE menu_item_variants SET stock = $1, track_stock = $2
        WHERE id = $3 RETURNING *`,
      [after, track, variantId],
    );
    await client.query(
      `INSERT INTO inventory_transactions
       (business_id, menu_item_id, variant_id, qty_change, balance_after, reason, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [businessId, cur.rows[0].menu_item_id, variantId, delta, after, reason, note],
    );
    return variants.serializeVariant(upd.rows[0]);
  });
}

async function stockHistory(businessId, itemId, { limit = 50, variantId } = {}) {
  // NP-205: `menu_item_id` on the ledger is always the PARENT, so the item
  // history keeps showing every movement of the dish (all sizes together) —
  // that is what the owner wants on the item screen. `variantId` narrows it
  // to one size for the variant row's own history drawer.
  const r = await query(
    `SELECT * FROM inventory_transactions
     WHERE business_id = $1 AND menu_item_id = $2
       AND ($4::uuid IS NULL OR variant_id = $4::uuid)
     ORDER BY created_at DESC LIMIT $3`,
    [businessId, itemId, limit, variantId || null],
  );
  return r.rows.map((row) => ({
    id: row.id,
    menuItemId: row.menu_item_id,
    variantId: row.variant_id || null,
    qtyChange: parseFloat(row.qty_change),
    balanceAfter: parseFloat(row.balance_after),
    reason: row.reason,
    orderId: row.order_id,
    note: row.note,
    createdAt: row.created_at,
  }));
}

/**
 * Push 20b — bulk import. Used by the tenant menu screen, the "switch to
 * NamastePOS" migration wizard (`/migrate` → POST /menu/bulk, the same route)
 * and by super-admin to ingest a CSV of menu items for a customer in one shot.
 *
 * PLAN CAP (2026-09-04). The route used to skip `sub.enforceLimit` on the
 * theory that "create() is limit-checked per row" — it never was: the cap
 * lives in the ROUTE middleware, not in create(). So an owner on Starter
 * (10 items) imported a 45-row menu successfully and only met the wall on
 * item 46, i.e. AFTER all the work. The whole batch is now measured against
 * the plan cap BEFORE the first row is written (subscriptionService
 * .assertCapacity, which throws the standard 403 PLAN_LIMIT), and the item
 * pass runs in ONE transaction, so a refusal — or any mid-import failure —
 * leaves zero rows behind. Pass `{ enforcePlanCap: false }` for callers that
 * are deliberately exempt (super-admin, who `enforceLimit` also skips).
 *
 * Only rows that would create an ACTIVE menu item count towards the cap:
 * variant rows collapse onto a parent, `is_active=false` rows are not counted
 * by the usage meter (`currentUsage` counts is_active = TRUE), and rows that
 * fail validation are never written.
 *
 * Row-level validation is still per row: bad rows are collected as errors and
 * skipped (each inside its own SAVEPOINT so one bad row cannot poison the
 * transaction) so the operator sees "47/50 imported, 3 had issues" rather than
 * losing a good file to one typo.
 *
 * Accepted row shape (all string-or-number; case-insensitive keys):
 *   name (required), price (required),
 *   category, description, sku, unit, stock, gst_pct, hsn_code,
 *   is_active, is_veg
 *
 * Returns { inserted, skipped, errors[] } where each error is
 * { row: <index 1-based>, name, message }.
 */
async function bulkImport(businessId, items, { enforcePlanCap = true } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { inserted: 0, skipped: 0, errors: [{ row: 0, message: 'No items in payload' }] };
  }
  let inserted = 0; let skipped = 0;
  const errors = [];
  // Migration wizard (2026-09-03): optional variant columns. A row with a
  // `variant_name` is a VARIANT of the item named in its `name` column — it
  // never creates a menu item itself; it collapses onto the parent (the
  // plain row with the same name earlier in the file). variant_price falls
  // back to the row's price column. Plain CSVs without variant columns hit
  // exactly the old code path, row for row.
  const variantsByName = new Map(); // lower(name) → [{ label, price }]
  const variantFirstRow = new Map(); // lower(name) → 1-based row of first variant
  const createdByName = new Map(); // lower(name) → menu_item id created this batch
  let variantsApplied = 0;
  // 2026-09-05 (092) — the slab a row without a `gst_pct` column falls back
  // to. Resolved ONCE for the whole file rather than per row: a 200-row CSV
  // must not run 200 identical reads of the same business, and every row in
  // one file belongs to one business by definition.
  // eslint-disable-next-line global-require
  const schemeGstPct = await require('./gstSchemeService')
    .defaultGstPctFor(businessId);

  // ── Pass 1: parse + validate every row. Nothing is written yet, which is
  // what lets the cap be checked against the real number of new items.
  const pending = []; // { row, name, body }
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
    const variantLabel = String(get('variant_name', 'variantName', 'Variant Name', 'variant') || '').trim();
    if (variantLabel) {
      const vpRaw = get('variant_price', 'variantPrice', 'Variant Price');
      const vPrice = vpRaw != null && vpRaw !== '' ? Number(vpRaw) : price;
      if (!Number.isFinite(vPrice) || vPrice < 0) {
        errors.push({ row: i + 1, name, message: `Invalid variant price for "${variantLabel}"` });
        skipped++; continue;
      }
      const key = name.toLowerCase();
      if (!variantsByName.has(key)) {
        variantsByName.set(key, []);
        variantFirstRow.set(key, i + 1);
      }
      variantsByName.get(key).push({ label: variantLabel, price: vPrice });
      continue; // collapsed onto the parent — applied after the item pass
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ row: i + 1, name, message: 'Invalid price' });
      skipped++; continue;
    }
    pending.push({
      row: i + 1,
      name,
      body: {
        name,
        price,
        description: get('description', 'Description') || null,
        category: get('category', 'Category') || 'Other',
        sku: get('sku', 'SKU') || null,
        unit: get('unit', 'Unit') || 'piece',
        stock: Number(get('stock', 'Stock') || 0),
        // A file that names a GST column still wins — an owner who put the
        // slab in their export knows something we don't. Otherwise fall back
        // to the business's declared scheme (was a hardcoded 5).
        gstPct: get('gst_pct', 'gstPct', 'GST') != null
          ? Number(get('gst_pct', 'gstPct', 'GST')) : schemeGstPct,
        hsnCode: get('hsn_code', 'hsnCode', 'HSN') || null,
        isActive: String(get('is_active', 'isActive', 'Active') ?? 'true').toLowerCase() !== 'false',
        isVeg: String(get('is_veg', 'isVeg', 'Veg') ?? 'true').toLowerCase() !== 'false',
      },
    });
  }

  // ── The wall, BEFORE any write. Throws 403 PLAN_LIMIT for the whole file.
  if (enforcePlanCap) {
    const wanted = pending.filter((p) => p.body.isActive).length;
    // eslint-disable-next-line global-require
    await require('./subscriptionService')
      .assertCapacity(businessId, 'menu_items', wanted);
  }

  // ── Pass 2: write. One transaction for the whole file (all-or-nothing on
  // any unexpected failure); one SAVEPOINT per row so a single bad row is
  // still just a skipped row and not an aborted batch.
  if (pending.length > 0) {
    await withTransaction(async (client) => {
      for (const p of pending) {
        await client.query('SAVEPOINT row_import');
        try {
          const item = await create(businessId, p.body, client);
          await client.query('RELEASE SAVEPOINT row_import');
          createdByName.set(p.name.toLowerCase(), item.id);
          inserted++;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT row_import');
          await client.query('RELEASE SAVEPOINT row_import');
          errors.push({ row: p.row, name: p.name, message: e.message || 'Insert failed' });
          skipped++;
        }
      }
    });
  }

  // Attach collected variants — prefer the item created in THIS batch; fall
  // back to an existing active item of the same name (re-import case).
  for (const [key, variants] of variantsByName) {
    const rowNo = variantFirstRow.get(key);
    try {
      let itemId = createdByName.get(key);
      if (!itemId) {
        const r = await query(
          `SELECT id FROM menu_items
            WHERE business_id = $1 AND LOWER(name) = $2 AND is_active = TRUE
            ORDER BY created_at LIMIT 1`,
          [businessId, key],
        );
        itemId = r.rows[0]?.id;
      }
      if (!itemId) {
        errors.push({ row: rowNo,
          name: key,
          message:
          'Variant rows need a base item row with the same name (add a plain row for the item first)' });
        skipped += variants.length;
        continue;
      }
      // setVariants is replace-all per item, so one call with the full
      // list per item — a re-import of the same CSV converges instead of
      // stacking duplicates.
      const variantSvc = require('./variantService');
      await variantSvc.setVariants(businessId, itemId, variants);
      variantsApplied += variants.length;
    } catch (e) {
      errors.push({ row: rowNo, name: key, message: e.message || 'Variant import failed' });
      skipped += variants.length;
    }
  }

  return { inserted, skipped, errors, variants: variantsApplied };
}

module.exports = {
  serialize,
  list,
  byId,
  create,
  update,
  softDelete,
  adjustStock,
  adjustVariantStock,
  stockHistory,
  bulkImport,
};
