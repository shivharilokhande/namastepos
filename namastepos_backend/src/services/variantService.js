// NamastePOS — Variants + modifier groups + modifiers (Sprint 1 / FF-201, FF-202)
//
// Variants are price-and-stock siblings of a parent menu_item.
// Modifier groups attach to a menu_item; modifiers within a group can shift
// the line price (e.g. "Extra cheese +₹30") and are captured on the
// order_item's modifier_lines JSONB.

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

// ── Variants ─────────────────────────────────────────────────────────────
function serializeVariant(r) {
  return {
    id: r.id,
    menuItemId: r.menu_item_id,
    label: r.label,
    price: parseFloat(r.price),
    costPrice: r.cost_price != null ? parseFloat(r.cost_price) : null,
    sku: r.sku,
    stock: r.stock != null ? parseFloat(r.stock) : null,
    isActive: r.is_active,
    displayOrder: r.display_order,
  };
}

async function listVariants(businessId, menuItemId) {
  const r = await query(
    `SELECT * FROM menu_item_variants
      WHERE business_id = $1 AND menu_item_id = $2
      ORDER BY display_order, label`,
    [businessId, menuItemId]
  );
  return r.rows.map(serializeVariant);
}

async function setVariants(businessId, menuItemId, variants) {
  // Replace-all: simpler UX from the menu editor. We diff inserts/updates
  // so existing variant IDs keep their FKs intact (order_items.variant_id).
  return withTransaction(async (client) => {
    // IDOR fix (2026-08-30): confirm the item belongs to THIS business before
    // touching its variants. The route only validates :businessId; :itemId was
    // passed straight through, so tenant A could deactivate tenant B's variants
    // by posting an empty list against B's item id.
    const own = await client.query(
      `SELECT 1 FROM menu_items WHERE id = $1 AND business_id = $2`,
      [menuItemId, businessId]
    );
    if (own.rowCount === 0) throw new NotFound('Menu item not found');
    const existing = await client.query(
      `SELECT id FROM menu_item_variants WHERE menu_item_id = $1 AND business_id = $2`,
      [menuItemId, businessId]
    );
    const keepIds = new Set();
    for (const v of variants || []) {
      if (!v.label || v.price == null) {
        throw new BadRequest('Each variant needs a label + price');
      }
      if (v.id) {
        await client.query(
          `UPDATE menu_item_variants
              SET label = $1, price = $2, cost_price = $3, sku = $4,
                  stock = $5, is_active = COALESCE($6, is_active),
                  display_order = COALESCE($7, display_order)
            WHERE id = $8 AND business_id = $9`,
          [v.label, v.price, v.costPrice ?? null, v.sku ?? null,
           v.stock ?? null, v.isActive, v.displayOrder, v.id, businessId]
        );
        keepIds.add(v.id);
      } else {
        const ins = await client.query(
          `INSERT INTO menu_item_variants
             (business_id, menu_item_id, label, price, cost_price, sku, stock, display_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 100), COALESCE($9, TRUE))
           RETURNING id`,
          [businessId, menuItemId, v.label, v.price, v.costPrice ?? null,
           v.sku ?? null, v.stock ?? null, v.displayOrder, v.isActive]
        );
        keepIds.add(ins.rows[0].id);
      }
    }
    // Soft-deactivate variants no longer in the list (don't hard-delete —
    // referenced by historical order_items.variant_id with ON DELETE SET NULL).
    for (const row of existing.rows) {
      if (!keepIds.has(row.id)) {
        await client.query(
          `UPDATE menu_item_variants SET is_active = FALSE WHERE id = $1 AND business_id = $2`,
          [row.id, businessId]
        );
      }
    }
    return listVariants(businessId, menuItemId);
  });
}

async function variantById(businessId, variantId) {
  const r = await query(
    `SELECT * FROM menu_item_variants WHERE business_id = $1 AND id = $2`,
    [businessId, variantId]
  );
  if (r.rowCount === 0) throw new NotFound('Variant not found');
  return serializeVariant(r.rows[0]);
}

// ── Modifier groups + modifiers ──────────────────────────────────────────
function serializeGroup(g, mods = []) {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    minSelect: g.min_select,
    maxSelect: g.max_select,
    displayOrder: g.display_order,
    isActive: g.is_active,
    modifiers: mods.map((m) => ({
      id: m.id,
      name: m.name,
      priceDeltaInr: parseFloat(m.price_delta_inr),
      isActive: m.is_active,
      displayOrder: m.display_order,
    })),
  };
}

async function listGroups(businessId) {
  const groups = await query(
    `SELECT * FROM modifier_groups
      WHERE business_id = $1 AND is_active = TRUE
      ORDER BY display_order, name`,
    [businessId]
  );
  if (groups.rowCount === 0) return [];
  const mods = await query(
    `SELECT * FROM modifiers
      WHERE business_id = $1 AND is_active = TRUE
      ORDER BY display_order, name`,
    [businessId]
  );
  const byGroup = new Map();
  for (const m of mods.rows) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  }
  return groups.rows.map((g) => serializeGroup(g, byGroup.get(g.id) || []));
}

async function upsertGroup(businessId, body) {
  return withTransaction(async (client) => {
    let groupId = body.id;
    if (groupId) {
      await client.query(
        `UPDATE modifier_groups
            SET name = $1, kind = $2, min_select = $3, max_select = $4,
                display_order = COALESCE($5, display_order),
                is_active = COALESCE($6, is_active)
          WHERE id = $7 AND business_id = $8`,
        [body.name, body.kind || 'single_select', body.minSelect ?? 0,
         body.maxSelect ?? 1, body.displayOrder, body.isActive, groupId, businessId]
      );
    } else {
      const ins = await client.query(
        `INSERT INTO modifier_groups
           (business_id, name, kind, min_select, max_select, display_order)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 100)) RETURNING id`,
        [businessId, body.name, body.kind || 'single_select',
         body.minSelect ?? 0, body.maxSelect ?? 1, body.displayOrder]
      );
      groupId = ins.rows[0].id;
    }

    // Replace modifiers for this group
    if (Array.isArray(body.modifiers)) {
      const existing = await client.query(
        `SELECT id FROM modifiers WHERE group_id = $1`, [groupId]
      );
      const keepIds = new Set();
      for (const m of body.modifiers) {
        if (!m.name) throw new BadRequest('Modifier needs a name');
        if (m.id) {
          await client.query(
            `UPDATE modifiers SET name = $1, price_delta_inr = $2,
                                   display_order = COALESCE($3, display_order)
              WHERE id = $4 AND business_id = $5`,
            [m.name, m.priceDeltaInr || 0, m.displayOrder, m.id, businessId]
          );
          keepIds.add(m.id);
        } else {
          const ins = await client.query(
            `INSERT INTO modifiers
               (business_id, group_id, name, price_delta_inr, display_order)
             VALUES ($1, $2, $3, $4, COALESCE($5, 100)) RETURNING id`,
            [businessId, groupId, m.name, m.priceDeltaInr || 0, m.displayOrder]
          );
          keepIds.add(ins.rows[0].id);
        }
      }
      for (const r of existing.rows) {
        if (!keepIds.has(r.id)) {
          await client.query(`UPDATE modifiers SET is_active = FALSE WHERE id = $1`, [r.id]);
        }
      }
    }
    return groupId;
  }).then(() => listGroups(businessId));
}

async function setItemModifierGroups(businessId, menuItemId, groupIds) {
  // IDOR fix (2026-08-30): confirm the target item belongs to this business.
  // The unscoped DELETE below would otherwise let tenant A wipe tenant B's
  // item→modifier-group links by passing B's item id (with an empty list the
  // group-ownership check is skipped entirely).
  const own = await query(
    `SELECT 1 FROM menu_items WHERE id = $1 AND business_id = $2`,
    [menuItemId, businessId]
  );
  if (own.rowCount === 0) throw new NotFound('Menu item not found');
  // Validate ownership
  if (groupIds && groupIds.length > 0) {
    const owned = await query(
      `SELECT id FROM modifier_groups WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, groupIds]
    );
    if (owned.rowCount !== groupIds.length) throw new BadRequest('Unknown modifier group');
  }
  return withTransaction(async (client) => {
    await client.query(
      `DELETE FROM item_modifier_groups WHERE menu_item_id = $1`, [menuItemId]
    );
    if (groupIds && groupIds.length > 0) {
      for (let i = 0; i < groupIds.length; i += 1) {
        await client.query(
          `INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
           VALUES ($1, $2, $3)`,
          [menuItemId, groupIds[i], i * 10]
        );
      }
    }
  });
}

async function getItemModifierGroups(businessId, menuItemId) {
  const r = await query(
    `SELECT g.id FROM item_modifier_groups img
       JOIN modifier_groups g ON g.id = img.group_id
      WHERE img.menu_item_id = $1 AND g.business_id = $2 AND g.is_active = TRUE
      ORDER BY img.display_order`,
    [menuItemId, businessId]
  );
  return r.rows.map((x) => x.id);
}

// ── 86 (sold-out) toggle ─────────────────────────────────────────────────
async function setSoldOut(businessId, menuItemId, until) {
  // until = null → restock now; otherwise ISO timestamp (or 'tomorrow_open' literal).
  let resolved = null;
  if (until === 'tomorrow_open') {
    // 06:00 local time next day
    resolved = new Date();
    resolved.setDate(resolved.getDate() + 1);
    resolved.setHours(6, 0, 0, 0);
  } else if (until === 'forever') {
    resolved = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  } else if (until) {
    resolved = new Date(until);
  }
  const r = await query(
    `UPDATE menu_items SET sold_out_until = $1
      WHERE business_id = $2 AND id = $3 RETURNING *`,
    [resolved, businessId, menuItemId]
  );
  if (r.rowCount === 0) throw new NotFound('Menu item not found');
  // FF-247: fan out to Zomato/Swiggy/etc. Fire-and-forget so the
  // owner's UX stays snappy — aggregator sync happens async in the
  // background. Failures are logged but never propagate to the
  // caller; cron retries missed pushes on the next tick.
  const isAvailable = resolved === null;
  const menuSync = require('./aggregatorMenuSyncService');
  menuSync.syncItemAvailability(businessId, menuItemId, isAvailable)
    .catch((e) => require('../config/logger')
      .warn(`[menu-sync] fanout failed: ${e.message}`));
  return { soldOutUntil: r.rows[0].sold_out_until };
}

module.exports = {
  listVariants, setVariants, variantById,
  listGroups, upsertGroup, setItemModifierGroups, getItemModifierGroups,
  setSoldOut,
  serializeVariant, serializeGroup,
};
