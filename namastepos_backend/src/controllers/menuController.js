// NamastePOS backend - menu endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const menu = require('../services/menuService');
const variants = require('../services/variantService');

// Combo component shape: a reference to an existing menu item with a qty.
const comboLine = Joi.object({
  menuItemId: Joi.string().uuid().required(),
  name: Joi.string().max(255), // denormalized for display, optional
  qty: Joi.number().positive().default(1),
});

const itemBody = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().max(1000).allow('', null),
  category: Joi.string().max(50).default('Food'),
  price: Joi.number().positive().precision(2).required(),
  costPrice: Joi.number().min(0).precision(2).allow(null),
  sku: Joi.string().max(50).allow('', null),
  unit: Joi.string().valid('piece', 'kg', 'gram', 'liter', 'ml', 'plate').default('piece'),
  stock: Joi.number().min(0).precision(2).default(0),
  // NP-205 (migration 084): explicit "is this item's stock finite?".
  // NO Joi default on purpose — `undefined` is meaningful: menuService.create
  // then infers it from `stock` (non-zero ⇒ track), which is what keeps every
  // already-shipped client and the CSV importer behaving correctly. A default
  // here would make every legacy create write `track_stock = false` and turn
  // the whole feature off for them.
  trackStock: Joi.boolean(),
  reorderLevel: Joi.number().min(0).precision(2).default(10),
  isActive: Joi.boolean().default(true),
  isVeg: Joi.boolean().default(true),
  // Accepts both absolute (https://cdn…) and relative (/uploads/…) URLs.
  // The latter is what our local-upload route returns; uri() would reject it.
  imageUrl: Joi.string().max(500).allow('', null),
  // Combo + display polish (migration 012)
  isCombo: Joi.boolean().default(false),
  comboItems: Joi.array().items(comboLine).allow(null),
  prepMinutes: Joi.number().integer().min(0).max(240)
    .allow(null),
  displayOrder: Joi.number().integer().min(0).max(9999)
    .default(100),
  tags: Joi.array().items(Joi.string().max(40)).allow(null),
  // GST per-item slab (migration 017). Indian GST council allows 0/5/12/18/28.
  gstPct: Joi.number().valid(0, 5, 12, 18, 28).allow(null),
  hsnCode: Joi.string().max(15).allow('', null),
});

// CRITICAL fix (2026-08-23, review): updateBody inherited itemBody's
// .default()s, so a partial update like { price: 90 } was validated into
// { price: 90, stock: 0, isVeg: true, category: 'Food', ... } — silently
// resetting stock/flags on every edit. noDefaults keeps updates truly partial.
const updateBody = itemBody
  .fork(['name', 'price'], (s) => s.optional())
  .min(1)
  .prefs({ noDefaults: true });

const stockBody = Joi.object({
  delta: Joi.number().required(),
  reason: Joi.string().valid('purchase', 'sale', 'waste', 'adjustment', 'returned', 'transfer').default('adjustment'),
  note: Joi.string().max(500).allow('', null),
  // NP-205: optional override. Omitted → the service infers (a non-zero
  // balance means the owner is tracking). Sent → obeyed, so an owner can
  // switch an item back to "unlimited" from the inventory screen.
  trackStock: Joi.boolean(),
});

// NP-205 — one variant row of the menu editor's replace-all list. `unknown`
// stays open because this schema is NEW on an endpoint that never validated
// its body: an older client sending a field we don't know about must keep
// working exactly as it did. The typed fields below are the ones the service
// writes, so a string where a number belongs is now a 400 instead of a
// `NaN` that Postgres rejects mid-transaction.
const variantRow = Joi.object({
  id: Joi.string().uuid(),
  label: Joi.string().min(1).max(80).required(),
  price: Joi.number().min(0).precision(2).required(),
  costPrice: Joi.number().min(0).precision(2).allow(null),
  sku: Joi.string().max(50).allow('', null),
  // Per-variant stock (migration 084). null = no count recorded.
  stock: Joi.number().precision(2).allow(null),
  trackStock: Joi.boolean(),
  isActive: Joi.boolean(),
  displayOrder: Joi.number().integer().min(0).max(9999),
}).unknown(true);

const variantsBody = Joi.object({
  variants: Joi.array().items(variantRow).max(50).default([]),
}).unknown(true);

const listQuery = Joi.object({
  category: Joi.string().max(50),
  isActive: Joi.boolean(),
  isCombo: Joi.boolean(),
  search: Joi.string().max(100),
  // NP-205: hydrate each item with its active variants (one extra query).
  // Opt-in — see menuService.list for why it isn't always on.
  withVariants: Joi.boolean(),
});

// FF-218: bulk-import body — array of rows, header names are lenient
// (Name/name, Price/price, Category/category, etc.) so a CSV exported
// from Excel or Google Sheets works without column renames.
const bulkImportBody = Joi.object({
  items: Joi.array().items(Joi.object().unknown(true)).min(1).max(1000)
    .required(),
});

module.exports = {
  bulkImport: [
    validate({ body: bulkImportBody }),
    asyncHandler(async (req, res) => {
      const result = await menu.bulkImport(req.params.businessId, req.body.items);
      res.json(result);
    }),
  ],
  list: [
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const items = await menu.list(req.params.businessId, req.query);
      res.json({ items });
    }),
  ],
  get: asyncHandler(async (req, res) => {
    const item = await menu.byId(req.params.businessId, req.params.itemId);
    res.json({ item });
  }),
  create: [
    validate({ body: itemBody }),
    asyncHandler(async (req, res) => {
      const item = await menu.create(req.params.businessId, req.body);
      res.status(201).json({ item });
    }),
  ],
  update: [
    validate({ body: updateBody }),
    asyncHandler(async (req, res) => {
      const item = await menu.update(req.params.businessId, req.params.itemId, req.body);
      res.json({ item });
    }),
  ],
  remove: asyncHandler(async (req, res) => {
    const result = await menu.softDelete(req.params.businessId, req.params.itemId);
    res.json(result);
  }),
  adjustStock: [
    validate({ body: stockBody }),
    asyncHandler(async (req, res) => {
      const item = await menu.adjustStock(req.params.businessId, req.params.itemId, req.body);
      res.json({ item });
    }),
  ],
  // NP-205 — variant twin of adjustStock. Same body, same reason enum, same
  // response envelope shape as the item endpoint ({ variant } instead of
  // { item }) so the inventory screens can reuse their adjust control.
  adjustVariantStock: [
    validate({ body: stockBody }),
    asyncHandler(async (req, res) => {
      const variant = await menu.adjustVariantStock(
        req.params.businessId, req.params.variantId, req.body,
      );
      res.json({ variant });
    }),
  ],
  history: asyncHandler(async (req, res) => {
    const history = await menu.stockHistory(req.params.businessId, req.params.itemId, {
      limit: Math.min(parseInt(req.query.limit || '50', 10), 200),
      // NP-205: `?variantId=` narrows the dish's movements to one size. The
      // ledger's menu_item_id is always the parent, so without the filter
      // this still returns every size together (what the item screen wants).
      variantId: req.query.variantId || null,
    });
    res.json({ history });
  }),

  // ── Sprint 1 — variants + modifiers + 86 ──────────────────────────────
  listVariants: asyncHandler(async (req, res) => {
    res.json({ variants: await variants.listVariants(req.params.businessId, req.params.itemId) });
  }),
  setVariants: [
    validate({ body: variantsBody }),
    asyncHandler(async (req, res) => {
      const out = await variants.setVariants(
        req.params.businessId, req.params.itemId, req.body.variants || [],
      );
      res.json({ variants: out });
    }),
  ],
  getItemGroups: asyncHandler(async (req, res) => {
    res.json({ groupIds: await variants.getItemModifierGroups(req.params.businessId, req.params.itemId) });
  }),
  setItemGroups: asyncHandler(async (req, res) => {
    await variants.setItemModifierGroups(req.params.businessId, req.params.itemId, req.body.groupIds || []);
    res.json({ success: true });
  }),
  toggleSoldOut: [
    validate({ body: Joi.object({
      until: Joi.alternatives().try(
        Joi.string().valid('tomorrow_open', 'forever'),
        Joi.date().iso(),
        Joi.allow(null),
      ),
    }) }),
    asyncHandler(async (req, res) => {
      const r = await variants.setSoldOut(req.params.businessId, req.params.itemId, req.body.until);
      res.json(r);
    }),
  ],
};
