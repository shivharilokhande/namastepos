// NamastePOS backend — tax invoice routes (Push 15c).
//
// Mounted at /businesses/:businessId/tax-invoices.
// Owner/manager/cashier can issue + read; only owner can cancel an
// already-issued invoice (cancellation is a tax-significant event).

const express = require('express');
const c = require('../controllers/taxInvoiceController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.get(    '/', requireRole(['business_owner', 'staff_manager', 'staff_cashier']),                  c.list);
router.post(   '/',                  requireRole(['business_owner', 'staff_manager', 'staff_cashier']), ...c.issue);
router.get(    '/:invoiceId', requireRole(['business_owner', 'staff_manager', 'staff_cashier']),        c.getOne);
router.get(    '/:invoiceId/pdf', requireRole(['business_owner', 'staff_manager', 'staff_cashier']),    c.pdf);
router.post(   '/:invoiceId/cancel', requireRole(['business_owner']), ...c.cancel);

module.exports = router;
