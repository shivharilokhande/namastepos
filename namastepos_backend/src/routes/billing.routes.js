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

// 2026-09-05 (churn batch) — the cancel flow, pause and the account export.
//
// The reason picker is a read of a static list; every write is owner-only and
// audit-logged, exactly like the plan-change writes above. The export is a
// READ of the tenant's own data and is deliberately NOT plan-gated: an owner on
// the way out is about to stop paying, and charging them for a copy of their
// own menu is the one thing the win-back promise says we never do.
router.get('/cancel/reasons', c.cancelReasons);
router.post('/cancel/survey', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'cancel_survey', () => ({ type: 'subscription' })), ...c.cancelSurvey);
router.post('/pause', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'plan_pause', () => ({ type: 'subscription' })), ...c.pause);
router.get('/export', requireRole('business_owner'), audit.tenantMiddlewareLog('billing', 'account_export', () => ({ type: 'subscription' })), c.exportAccount);
router.get('/invoices', requireRole(['business_owner', 'staff_manager']), c.invoices);
router.get(
  '/invoices/:invoiceId/pdf',
  requireRole(['business_owner', 'staff_manager']),
  c.invoicePdf,
);

module.exports = router;
