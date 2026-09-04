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
// FF-218 — bulk CSV import. Owner-only. Skips the `sub.enforceLimit`
// middleware because bulkImport internally calls create() per row, which
// itself is limit-checked; running enforceLimit twice would double-count.
router.post(
  '/bulk',
  requireRole(['business_owner', 'staff_manager']),
  ...c.bulkImport,
);
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
