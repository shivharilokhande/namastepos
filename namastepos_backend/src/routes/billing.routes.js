// NamastePOS backend - billing routes
//
// Two route bases:
//   /v1/plans                                — public plan catalog
//   /v1/businesses/:bid/billing/...          — per-tenant subscription
//   /v1/webhooks/razorpay                    — Razorpay POST (no auth)

const express = require('express');
const c = require('../controllers/billingController');
const audit = require('../services/auditService');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.get  ('/',              c.current);
router.post ('/change',        requireRole('business_owner'),
             audit.tenantMiddlewareLog('billing', 'plan_change', () => ({ type: 'subscription' })),
             ...c.changePlan);
router.post ('/cancel',        requireRole('business_owner'),
             audit.tenantMiddlewareLog('billing', 'plan_cancel', () => ({ type: 'subscription' })),
             c.cancel);
router.post ('/resume',        requireRole('business_owner'),
             audit.tenantMiddlewareLog('billing', 'plan_resume', () => ({ type: 'subscription' })),
             c.resume);
router.get  ('/invoices',      c.invoices);
router.get  ('/invoices/:invoiceId/pdf', c.invoicePdf);

module.exports = router;
