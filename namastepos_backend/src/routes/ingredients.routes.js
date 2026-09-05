// NamastePOS backend - ingredients + recipes routes
// Gated behind the 'recipe-costing' add-on OR the 'recipe_costing' plan feature.

const express = require('express');
const c = require('../controllers/ingredientController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const requireAddon = require('../middleware/requireAddon');
const idempotent = require('../middleware/idempotent');

const router = express.Router({ mergeParams: true });
// 2026-09-05 (entitlements review D1 / dashboard D-02): this was
// requireAddon('recipe-costing') with NO orFeature. Pro, Advanced and
// Enterprise GRANT recipe_costing as a plan feature (the featureGate rule on
// '/ingredients' had already passed), and then this router-level addon check
// 402'd ADDON_REQUIRED — a Pro owner was told to buy again what their plan
// includes. The 2026-09-03 orFeature fix was applied to /customers (loyalty)
// and missed here. The addon still works: it grants the same key via
// addons.grants_features (migration 074).
router.use(
  requireAuth,
  requireBusinessOwnership,
  requireAddon('recipe-costing', { orFeature: 'recipe_costing' }),
);

// Ingredients
router.get('/', c.list);
router.post('/', requireRole(['business_owner', 'staff_manager']), ...c.create);
router.get('/_report/food-cost', requireRole(['business_owner', 'staff_manager']), c.foodCostReport);
router.get('/:ingredientId', c.get);
router.patch('/:ingredientId', requireRole(['business_owner', 'staff_manager']), ...c.update);
router.delete('/:ingredientId', requireRole(['business_owner']), c.remove);
// NP-401 (2026-09-04): both of these are RELATIVE stock movements that also
// move the weighted-average cost, so a replay after a lost response books the
// goods receipt / adjustment twice and corrupts food-cost reporting. Deduped
// on the client's Idempotency-Key; no header → unchanged behaviour.
router.post(
  '/:ingredientId/purchase',
  requireRole(['business_owner', 'staff_manager']),
  idempotent('POST /ingredients/:ingredientId/purchase'),
  ...c.purchase,
);
router.post(
  '/:ingredientId/adjust',
  requireRole(['business_owner', 'staff_manager']),
  idempotent('POST /ingredients/:ingredientId/adjust'),
  ...c.adjust,
);

// Recipes (one recipe per menu_item)
router.get('/_recipes/:menuItemId', c.getRecipe);
router.put('/_recipes/:menuItemId', requireRole(['business_owner', 'staff_manager']), ...c.setRecipe);

module.exports = router;
