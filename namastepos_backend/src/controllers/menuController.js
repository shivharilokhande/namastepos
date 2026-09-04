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
});

const listQuery = Joi.object({
  category: Joi.string().max(50),
  isActive: Joi.boolean(),
  isCombo: Joi.boolean(),
  search: Joi.string().max(100),
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
  history: asyncHandler(async (req, res) => {
    const history = await menu.stockHistory(req.params.businessId, req.params.itemId, {
      limit: Math.min(parseInt(req.query.limit || '50', 10), 200),
    });
    res.json({ history });
  }),

  // ── Sprint 1 — variants + modifiers + 86 ──────────────────────────────
  listVariants: asyncHandler(async (req, res) => {
    res.json({ variants: await variants.listVariants(req.params.businessId, req.params.itemId) });
  }),
  setVariants: asyncHandler(async (req, res) => {
    const out = await variants.setVariants(req.params.businessId, req.params.itemId, req.body.variants || []);
    res.json({ variants: out });
  }),
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
