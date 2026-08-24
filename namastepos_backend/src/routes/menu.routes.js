// NamastePOS backend - menu routes (mounted at /businesses/:businessId/menu)

const express = require('express');
const c = require('../controllers/menuController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.get   ('/',                  ...c.list);
router.post  ('/',
              requireRole(['business_owner', 'staff_manager']),
              sub.enforceLimit('menu_items'),
              ...c.create);
// FF-218 — bulk CSV import. Owner-only. Skips the `sub.enforceLimit`
// middleware because bulkImport internally calls create() per row, which
// itself is limit-checked; running enforceLimit twice would double-count.
router.post  ('/bulk',
              requireRole(['business_owner', 'staff_manager']),
              ...c.bulkImport);
router.get   ('/:itemId',           c.get);
router.put   ('/:itemId',           requireRole(['business_owner', 'staff_manager']), ...c.update);
router.delete('/:itemId',           requireRole(['business_owner', 'staff_manager']), c.remove);
router.put   ('/:itemId/stock',     requireRole(['business_owner', 'staff_manager']), ...c.adjustStock);
router.get   ('/:itemId/history',   c.history);

// Sprint 1 — variants + modifiers + 86 toggle
router.get   ('/:itemId/variants',  c.listVariants);
router.put   ('/:itemId/variants',  requireRole(['business_owner', 'staff_manager']), c.setVariants);
router.get   ('/:itemId/modifier-groups',   c.getItemGroups);
router.put   ('/:itemId/modifier-groups',   requireRole(['business_owner', 'staff_manager']), c.setItemGroups);
router.put   ('/:itemId/sold-out',  requireRole(['business_owner', 'staff_manager', 'staff_cashier']), c.toggleSoldOut);

module.exports = router;
