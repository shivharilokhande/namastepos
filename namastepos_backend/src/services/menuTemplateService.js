// NamastePOS - starter menu templates (2026-09-05).
//
// THE WALL THIS REMOVES: typing 30-80 dishes with prices on a phone is 45-90
// minutes, it sits between signup and the first bill, and it is the single
// most likely reason a 7-day trial ends on day one (activation audit
// 2026-09-04, finding 1). A first-time owner, or one moving off paper, has no
// CSV to import - the existing /migrate wizard cannot help them. A template
// turns those 45 minutes into one tap.
//
// WHERE THE DATA LIVES: `src/data/menu-templates/*.json`, NOT a migration.
// Reasons in that directory's README - short version: it is product content,
// not tenant data; migrations here are forward-only so a price typo would be
// permanent; and every environment gets the same list with no DB drift.
//
// APPLY IS A MERGE, NOT A REPLACE. See applyTemplate below.

const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');
const logger = require('../config/logger');

const DATA_DIR = path.join(__dirname, '..', 'data', 'menu-templates');

// Hard ceiling per template. Starter is 60 menu items (verified live against
// GET /v1/public/plans on 2026-09-05), so a template has to leave the owner
// room for their own dishes inside the free plan. A template that breaks this
// is a bug in the DATA, so it fails loudly at boot rather than 403-ing an
// owner at the moment they tap "Load this menu".
const MAX_TEMPLATE_ITEMS = 40;

let cache = null;

function validate(tpl, file) {
  const bad = (msg) => { throw new Error(`menu template ${file}: ${msg}`); };
  if (!tpl || typeof tpl !== 'object') bad('not an object');
  if (!tpl.slug || !/^[a-z0-9-]{2,60}$/.test(tpl.slug)) bad('missing or invalid slug');
  if (!tpl.name) bad('missing name');
  if (!Array.isArray(tpl.items) || tpl.items.length === 0) bad('no items');
  if (tpl.items.length > MAX_TEMPLATE_ITEMS) {
    bad(`${tpl.items.length} items — the cap is ${MAX_TEMPLATE_ITEMS} so a template fits inside Starter`);
  }
  const seen = new Set();
  for (const it of tpl.items) {
    if (!it || !it.name || typeof it.name !== 'string') bad('an item has no name');
    const key = it.name.trim().toLowerCase();
    if (seen.has(key)) bad(`duplicate item name "${it.name}"`);
    seen.add(key);
    if (!Number.isFinite(Number(it.price)) || Number(it.price) < 0) {
      bad(`item "${it.name}" has no usable price`);
    }
  }
  return tpl;
}

/** Read every template off disk once. Sorted by name for a stable picker. */
function load() {
  if (cache) return cache;
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.error('Menu template directory unreadable', { err: err.message });
    cache = [];
    return cache;
  }
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const tpl = validate(JSON.parse(raw), f);
    out.push(tpl);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  cache = out;
  return cache;
}

/** Test seam — forget the parsed files. */
function clearCache() { cache = null; }

/** Everything the picker needs, without shipping ~300 item rows to draw a list. */
function listTemplates() {
  return load().map((t) => ({
    slug: t.slug,
    name: t.name,
    tagline: t.tagline || null,
    format: t.format || null,
    itemCount: t.items.length,
    categories: Array.from(new Set(t.items.map((i) => i.category || 'Menu'))),
    defaultGstPct: t.defaultGstPct ?? 5,
    notes: t.notes || [],
    // A three-item taste of the menu, so the picker card is recognisable
    // without a second request.
    sample: t.items.slice(0, 3).map((i) => ({ name: i.name, price: Number(i.price) })),
  }));
}

/** One template with every item — the "see what's inside" view. */
function getTemplate(slug) {
  const t = load().find((x) => x.slug === slug);
  if (!t) throw new NotFound('Menu template not found');
  return {
    slug: t.slug,
    name: t.name,
    tagline: t.tagline || null,
    format: t.format || null,
    defaultGstPct: t.defaultGstPct ?? 5,
    defaultHsnCode: t.defaultHsnCode || null,
    notes: t.notes || [],
    itemCount: t.items.length,
    items: t.items.map((i) => ({
      name: i.name,
      price: Number(i.price),
      category: i.category || 'Menu',
      isVeg: i.isVeg !== false,
      description: i.description || null,
      gstPct: i.gstPct !== undefined ? Number(i.gstPct) : (t.defaultGstPct ?? 5),
      hsnCode: i.hsnCode !== undefined ? (i.hsnCode || null) : (t.defaultHsnCode || null),
    })),
  };
}

/**
 * Apply a template to ONE business.
 *
 * MERGE, NOT REPLACE — and the reason matters.
 *
 *   • Never wipe. The owner may have typed ten dishes with their real prices
 *     before finding this button. Deleting those to "load a menu" is the worst
 *     thing this feature could do, so it is not an option at any price.
 *   • Never refuse either. Refusing on a non-empty menu punishes exactly the
 *     owner we are trying to help: the one who typed three items in the setup
 *     wizard, realised how long the rest would take, and came looking for a
 *     shortcut. That is the most common non-empty menu there is.
 *   • So: SKIP BY NAME. Any template item whose name already exists as an
 *     ACTIVE item in this business is left completely alone — not updated, not
 *     re-priced, not deactivated — and reported back in `alreadyPresent`.
 *     Everything else is inserted. Applying the same template twice therefore
 *     inserts nothing the second time, which is what makes a double-tap or a
 *     retried request safe.
 *
 * PLAN CAP: the dedup happens FIRST, then the surviving rows go through
 * menuService.bulkImport, which runs subscriptionService.assertCapacity over
 * the whole batch before writing a single row and throws the documented 403
 * PLAN_LIMIT (error:'PLAN_LIMIT', details:{metric,limit,current,plan}). Doing
 * it in this order matters: a re-apply of a 38-item template on a 60-item plan
 * must not be refused for 38 items it is not going to insert.
 *
 * PRICES ARE SERVER-SIDE. The caller sends a slug and nothing else. Every
 * name, price, category, GST rate and HSN code comes off disk here, so a
 * client cannot inject a price through this route.
 *
 * TENANT SCOPE: `businessId` is the ownership-checked path parameter, it is
 * the only business touched by the existence probe and by every insert, and
 * bulkImport scopes its own writes the same way.
 */
async function applyTemplate(businessId, slug) {
  if (!businessId) throw new BadRequest('Missing business');
  const tpl = getTemplate(slug); // throws NotFound for an unknown slug

  const existing = await query(
    `SELECT LOWER(name) AS name FROM menu_items
      WHERE business_id = $1 AND is_active = TRUE`,
    [businessId],
  );
  const have = new Set(existing.rows.map((r) => r.name));

  const alreadyPresent = [];
  const rows = [];
  for (const it of tpl.items) {
    if (have.has(it.name.toLowerCase())) {
      alreadyPresent.push(it.name);
      continue;
    }
    rows.push({
      name: it.name,
      price: it.price,
      category: it.category,
      description: it.description,
      isVeg: it.isVeg,
      gstPct: it.gstPct,
      hsnCode: it.hsnCode,
      // Templates never guess an opening stock: `create()` reads stock 0 as
      // "unlimited" (migration 084), which is right for a menu nobody has
      // counted yet. An item that shows as sold out on its first day would be
      // a worse first impression than no menu at all.
      stock: 0,
      isActive: true,
    });
  }

  if (rows.length === 0) {
    return {
      template: { slug: tpl.slug, name: tpl.name, itemCount: tpl.itemCount },
      inserted: 0,
      skipped: 0,
      alreadyPresent,
      errors: [],
    };
  }

  // eslint-disable-next-line global-require
  const menu = require('./menuService');
  const result = await menu.bulkImport(businessId, rows);

  return {
    template: { slug: tpl.slug, name: tpl.name, itemCount: tpl.itemCount },
    inserted: result.inserted,
    skipped: result.skipped,
    alreadyPresent,
    errors: result.errors || [],
  };
}

module.exports = {
  MAX_TEMPLATE_ITEMS,
  listTemplates,
  getTemplate,
  applyTemplate,
  clearCache,
};
