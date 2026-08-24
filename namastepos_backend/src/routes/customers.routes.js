// NamastePOS backend - customer routes (mounted at /businesses/:businessId/customers)
// Gated behind the 'loyalty' add-on. Each business pays to access this CRM.

const express = require('express');
const c = require('../controllers/customerController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const requireAddon = require('../middleware/requireAddon');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership, requireAddon('loyalty'));

// Customer CRUD
router.get   ('/',                   ...c.list);
router.get   ('/lookup',             c.lookup);       // ?phone=…
router.post  ('/',                   ...c.upsert);
router.get   ('/:customerId',        c.get);
router.patch ('/:customerId',        ...c.update);
router.delete('/:customerId',        requireRole(['business_owner']), c.remove);
router.post  ('/:customerId/points',
              requireRole(['business_owner', 'staff_manager']),
              ...c.adjustPoints);

// Loyalty settings
router.get   ('/_settings/loyalty', c.getLoyaltySettings);
router.put   ('/_settings/loyalty',
              requireRole(['business_owner']),
              c.updateLoyaltySettings);

module.exports = router;
