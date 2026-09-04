// NamastePOS backend - menu routes (mounted at /businesses/:businessId/menu)

const express = require('express');
const c = require('../controllers/menuController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const idempotent = require('../middleware/idempotent');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.get('/', ...c.list);
router.post(
  '/',
  requireRole(['business_owner', 'staff_manager']),
  sub.enforceLimit('menu_items'),
  ...c.create,
);
// FF-218 — bulk CSV import (also the migration wizard's menu step).
//
// No `sub.enforceLimit` here ON PURPOSE, and the reason is NOT the one this
// comment used to give ("bulkImport calls create() per row, which is itself
// limit-checked" — create() has never checked a limit; the cap lives in this
// middleware). enforceLimit only asks "room for ONE more?", which for a
// 45-row file on a 10-item plan let the import through and refused row 46
// after the work was done. menuService.bulkImport now measures the WHOLE file
// against the cap before writing anything and throws the same 403 PLAN_LIMIT.
router.post(
  '/bulk',
  requireRole(['business_owner', 'staff_manager']),
  ...c.bulkImport,
);
// ── Activation: the three real ways to get a menu in ────────────────────
//
// 2026-09-05. These MUST be declared before '/:itemId' — Express matches in
// order, so a later '/templates' would be swallowed by the item route and
// answered with "Menu item not found".
//
// 1. LOAD A TEMPLATE. GET is read-only product content (any authenticated
//    member of the business may look), POST writes and needs the same roles
//    as creating an item by hand.
router.get('/templates', c.listTemplates);
router.get('/templates/:slug', c.getTemplate);
router.post(
  '/templates/:slug/apply',
  requireRole(['business_owner', 'staff_manager']),
  c.applyTemplate,
);
// 2. PASTE A MENU. Parse-only: it writes nothing, so no plan cap and no
//    idempotency key. The confirmed rows are posted to '/bulk' above, which
//    is where the cap and the all-or-nothing transaction live.
router.post(
  '/parse-text',
  requireRole(['business_owner', 'staff_manager']),
  ...c.parseText,
);
// 3. IMPORT A CSV / POS export — POST '/bulk', already above.

router.get('/:itemId', c.get);
router.put('/:itemId', requireRole(['business_owner', 'staff_manager']), ...c.update);
router.delete('/:itemId', requireRole(['business_owner', 'staff_manager']), c.remove);
// NP-401 (2026-09-04): `delta` is a RELATIVE movement, so a replayed request
// decrements twice — the single worst double-apply in the app (a lost response
// on "received 20 kg" silently books 40). idempotent() dedupes on the client's
// Idempotency-Key header; without the header the route behaves exactly as before.
router.put(
  '/:itemId/stock',
  requireRole(['business_owner', 'staff_manager']),
  idempotent('PUT /menu/:itemId/stock'),
  ...c.adjustStock,
);
router.get('/:itemId/history', c.history);

// Sprint 1 — variants + modifiers + 86 toggle
router.get('/:itemId/variants', c.listVariants);
router.put('/:itemId/variants', requireRole(['business_owner', 'staff_manager']), ...c.setVariants);
// NP-205 (2026-09-04) — set ONE variant's stock from an inventory screen.
// Mirrors `/:itemId/stock` (same body, same roles) so the inventory UI does
// not have to PUT the whole replace-all variant list back just to book a
// delivery of Large pizzas — which would race with a concurrent menu edit and
// could soft-delete a variant somebody else just added.
// Feature-gated automatically: featureGate matches '/variants' anywhere in
// the path, so this needs `menu_variants_modifiers` like the rest.
router.put(
  '/:itemId/variants/:variantId/stock',
  requireRole(['business_owner', 'staff_manager']),
  // NP-401: same relative-delta hazard as the item endpoint above.
  idempotent('PUT /menu/:itemId/variants/:variantId/stock'),
  ...c.adjustVariantStock,
);
router.get('/:itemId/modifier-groups', c.getItemGroups);
router.put('/:itemId/modifier-groups', requireRole(['business_owner', 'staff_manager']), c.setItemGroups);
router.put('/:itemId/sold-out', requireRole(['business_owner', 'staff_manager', 'staff_cashier']), c.toggleSoldOut);

module.exports = router;
