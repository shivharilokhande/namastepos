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

// NP-201: billing is a money surface. The plan-change/cancel/resume writes
// were owner-gated, but the reads were not — any authenticated member could
// see the subscription state and download every GST subscription invoice PDF.
// Reads are owner/manager (a manager may need to see whether the plan is
// past-due); every write stays owner-only.
//
// NOTE: `/` (current subscription) stays readable by ALL staff on purpose —
// the mobile app calls it on every launch to detect a trial-expired /
// past-due tenant and show the blocking screen. Gating it would strand staff
// on a broken home screen instead of the correct "renew" message. It returns
// tier + status only, no invoice or payment-instrument data.
router.get('/', c.current);
router.post('/change', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'plan_change', () => ({ type: 'subscription' })), ...c.changePlan);
router.post('/cancel', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'plan_cancel', () => ({ type: 'subscription' })), c.cancel);
router.post('/resume', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'plan_resume', () => ({ type: 'subscription' })), c.resume);
router.get('/invoices', requireRole(['business_owner', 'staff_manager']), c.invoices);
router.get(
  '/invoices/:invoiceId/pdf',
  requireRole(['business_owner', 'staff_manager']),
  c.invoicePdf,
);

module.exports = router;
