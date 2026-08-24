// NamastePOS backend - ingredient + recipe + food-cost endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const ingredients = require('../services/ingredientService');
const recipes = require('../services/recipeService');

const ingredientBody = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  category: Joi.string().max(50).allow('', null),
  unit: Joi.string().valid('g', 'kg', 'ml', 'l', 'piece', 'pack', 'dozen').default('g'),
  stock: Joi.number().min(0).default(0),
  reorderLevel: Joi.number().min(0).default(0),
  costPerUnitInr: Joi.number().min(0).default(0),
  vendor: Joi.string().max(255).allow('', null),
  vendorPhone: Joi.string().max(20).allow('', null),
  notes: Joi.string().max(500).allow('', null),
  isActive: Joi.boolean().default(true),
});

// Fix (2026-08-23, review): strip inherited .default()s — a partial patch
// was zeroing stock/reorderLevel/costPerUnitInr and resetting unit to 'g'.
const ingredientPatch = ingredientBody.fork(['name', 'unit'], (s) => s.optional()).min(1)
  .prefs({ noDefaults: true });

const purchaseBody = Joi.object({
  qty: Joi.number().positive().required(),
  unitCostInr: Joi.number().min(0),
  totalCostInr: Joi.number().min(0),
  vendor: Joi.string().max(255).allow('', null),
  note: Joi.string().max(500).allow('', null),
}).or('unitCostInr', 'totalCostInr');

const adjustBody = Joi.object({
  delta: Joi.number().required(),
  kind: Joi.string().valid('waste', 'adjustment', 'spoilage', 'manual_in', 'manual_out').default('adjustment'),
  note: Joi.string().max(500).allow('', null),
});

const setRecipeBody = Joi.object({
  lines: Joi.array().items(Joi.object({
    ingredientId: Joi.string().uuid().required(),
    qty: Joi.number().positive().required(),
    note: Joi.string().max(500).allow('', null),
  })).required(),
});

module.exports = {
  // ── Ingredients CRUD ─────────────────────────────────────────────────
  list: asyncHandler(async (req, res) => {
    const list = await ingredients.list(req.params.businessId, req.query);
    res.json({ ingredients: list });
  }),
  get: asyncHandler(async (req, res) => {
    const ing = await ingredients.byId(req.params.businessId, req.params.ingredientId);
    const txns = await ingredients.transactions(req.params.businessId, req.params.ingredientId);
    res.json({ ingredient: ing, transactions: txns });
  }),
  create: [
    validate({ body: ingredientBody }),
    asyncHandler(async (req, res) => {
      res.status(201).json({ ingredient: await ingredients.create(req.params.businessId, req.body) });
    }),
  ],
  update: [
    validate({ body: ingredientPatch }),
    asyncHandler(async (req, res) => {
      res.json({ ingredient: await ingredients.update(req.params.businessId, req.params.ingredientId, req.body) });
    }),
  ],
  remove: asyncHandler(async (req, res) => {
    await ingredients.softDelete(req.params.businessId, req.params.ingredientId);
    res.json({ success: true });
  }),
  purchase: [
    validate({ body: purchaseBody }),
    asyncHandler(async (req, res) => {
      res.json({ ingredient: await ingredients.recordPurchase(req.params.businessId, req.params.ingredientId, req.body) });
    }),
  ],
  adjust: [
    validate({ body: adjustBody }),
    asyncHandler(async (req, res) => {
      res.json({ ingredient: await ingredients.adjustStock(req.params.businessId, req.params.ingredientId, req.body) });
    }),
  ],

  // ── Recipes ─────────────────────────────────────────────────────────
  getRecipe: asyncHandler(async (req, res) => {
    res.json({ lines: await recipes.listForItem(req.params.businessId, req.params.menuItemId) });
  }),
  setRecipe: [
    validate({ body: setRecipeBody }),
    asyncHandler(async (req, res) => {
      const lines = await recipes.setRecipe(req.params.businessId, req.params.menuItemId, req.body.lines);
      res.json({ lines });
    }),
  ],

  // ── Food-cost report ────────────────────────────────────────────────
  foodCostReport: asyncHandler(async (req, res) => {
    res.json({ report: await recipes.reportFoodCost(req.params.businessId, req.query) });
  }),
};
