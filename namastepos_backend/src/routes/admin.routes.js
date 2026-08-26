// NamastePOS backend - super admin routes (full SaaS surface)

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/adminController');
const { requireSuperAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/adminRbac');
const audit = require('../services/auditService');
const addonController = require('../controllers/addonController');
const env = require('../config/env');

const router = express.Router();

// In production, throttle to 20 admin logins/min/IP. In dev + test we make
// this a no-op so heavy E2E test runs don't trip on legitimate retries —
// production behaviour is unchanged.
const loginLimiter = env.isProd()
  ? rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
  : (_req, _res, next) => next();

// ── Public ──────────────────────────────────────────────────────────────
router.post('/auth/login',       loginLimiter, ...c.login);
// 2FA login-completion is public (no token yet). Audit it so a burst of failed
// verifies is visible; admin_id resolves once the challenge is validated.
router.post('/auth/2fa/verify',  loginLimiter,
            audit.middlewareLog('admin-auth', '2fa-verify', () => ({ type: 'admin' })),
            ...c.twoFaVerify);

// ── Protected ───────────────────────────────────────────────────────────
router.use(requireSuperAdmin);

router.get   ('/auth/me', c.me);

// 2FA enrolment (QA-8 P1) — current admin only. Audit enrol/confirm/disable
// (2026-08-25) so security-relevant 2FA changes show on the audit trail.
router.post  ('/auth/2fa/enrol',
              audit.middlewareLog('admin-auth', '2fa-enrol-start', (req) => ({ type: 'admin', id: req.user?.id })),
              c.twoFaEnrolStart);
router.post  ('/auth/2fa/enrol/confirm',
              audit.middlewareLog('admin-auth', '2fa-enrol-confirm', (req) => ({ type: 'admin', id: req.user?.id })),
              ...c.twoFaEnrolConfirm);
router.post  ('/auth/2fa/disable',
              audit.middlewareLog('admin-auth', '2fa-disable', (req) => ({ type: 'admin', id: req.user?.id })),
              ...c.twoFaDisable);

// Headline / DB health
router.get   ('/metrics',           requirePermission('reports.read'), c.metrics);
router.get   ('/health/db',         requirePermission('reports.read'), c.dbHealth);

// ── Customers ──────────────────────────────────────────────────────────
router.get   ('/customers',                     requirePermission('customers.read'), c.listCustomers);
router.get   ('/customers/:businessId',         requirePermission('customers.read'), c.getCustomer);
router.get   ('/customers/:businessId/drilldown', requirePermission('customers.read'), c.drilldown);
router.get   ('/customers/:businessId/invoices/:invoiceId/pdf', requirePermission('customers.read'), c.invoicePdf);
router.post  ('/customers',                     requirePermission('customers.write'),
              audit.middlewareLog('customers', 'create', (req, b) => ({ type: 'business', id: b.business?.id })),
              ...c.createCustomer);
router.patch ('/customers/:businessId',         requirePermission('customers.write'),
              audit.middlewareLog('customers', 'update', (req) => ({ type: 'business', id: req.params.businessId })),
              c.updateCustomer);
router.delete('/customers/:businessId',         requirePermission('customers.write'),
              audit.middlewareLog('customers', 'delete', (req) => ({ type: 'business', id: req.params.businessId })),
              c.deleteCustomer);
router.post  ('/customers/:businessId/suspend', requirePermission('customers.write'),
              audit.middlewareLog('customers', 'suspend', (req) => ({ type: 'business', id: req.params.businessId })),
              c.suspend);
router.post  ('/customers/:businessId/restore', requirePermission('customers.write'),
              audit.middlewareLog('customers', 'restore', (req) => ({ type: 'business', id: req.params.businessId })),
              c.restore);
router.post  ('/customers/:businessId/extend-trial', requirePermission('customers.write'),
              audit.middlewareLog('customers', 'extend-trial', (req) => ({ type: 'business', id: req.params.businessId })),
              ...c.extendTrial);
router.post  ('/customers/:businessId/set-plan',    requirePermission('plans.change'),
              audit.middlewareLog('customers', 'set-plan', (req) => ({ type: 'business', id: req.params.businessId })),
              ...c.setPlanManually);
router.post  ('/customers/:businessId/impersonate', requirePermission('customers.impersonate'),
              audit.middlewareLog('customers', 'impersonate', (req) => ({ type: 'business', id: req.params.businessId })),
              c.impersonate);

router.post  ('/customers/:businessId/notes',     requirePermission('notes.write'), ...c.addNote);
router.delete('/customers/:businessId/notes/:noteId', requirePermission('notes.write'), c.deleteNote);

// Push 20b — bulk menu CSV/JSON import for a specific customer
router.post  ('/customers/:businessId/menu/bulk',
              requirePermission('customers.write'),
              audit.middlewareLog('menu', 'bulk-import',
                (req) => ({ type: 'business', id: req.params.businessId })),
              c.customerMenuBulkImport);

// ── Add-ons (catalog CRUD) ─────────────────────────────────────────────
router.get   ('/addons',               requirePermission('plans.read'),   addonController.adminList);
router.post  ('/addons',               requirePermission('plans.change'),
              audit.middlewareLog('addons', 'create', (req, b) => ({ type: 'addon', id: b.addon?.id })),
              ...addonController.adminCreate);
router.put   ('/addons/:slug',         requirePermission('plans.change'),
              audit.middlewareLog('addons', 'update', (req) => ({ type: 'addon', id: req.params.slug })),
              ...addonController.adminUpdate);
router.post  ('/addons/sync-razorpay', requirePermission('plans.change'), addonController.adminSyncRazorpay);
router.get   ('/customers/:businessId/addons',
              requirePermission('customers.read'),
              addonController.adminActivationsForCustomer);
// Push 19b — attach/detach an addon from a customer (super-admin only).
router.post  ('/customers/:businessId/addons/:slug/attach',
              requirePermission('customers.write'),
              audit.middlewareLog('addons', 'attach',
                (req) => ({ type: 'business', id: req.params.businessId })),
              addonController.adminAttachToCustomer);
router.post  ('/customers/:businessId/addons/:slug/detach',
              requirePermission('customers.write'),
              audit.middlewareLog('addons', 'detach',
                (req) => ({ type: 'business', id: req.params.businessId })),
              addonController.adminDetachFromCustomer);

// ── Plans ──────────────────────────────────────────────────────────────
router.get   ('/plans',         requirePermission('plans.read'), c.listPlans);
router.put   ('/plans/:tier',   requirePermission('plans.change'),
              audit.middlewareLog('plans', 'update', (req) => ({ type: 'plan', id: req.params.tier })),
              c.updatePlan);
router.post  ('/plans',         requirePermission('plans.change'),
              audit.middlewareLog('plans', 'create', (req, b) => ({ type: 'plan', id: b.plan?.tier })),
              ...c.createPlan);
router.delete('/plans/:tier',   requirePermission('plans.change'),
              audit.middlewareLog('plans', 'delete', (req) => ({ type: 'plan', id: req.params.tier })),
              c.deletePlan);
router.post  ('/razorpay/sync', requirePermission('plans.change'), c.syncRazorpayPlans);

// Push 14d — feature catalog + tier feature matrix (source of truth that
// owner dashboard + mobile gate UI by). Tier kinds: starter/pro/enterprise.
router.get   ('/feature-catalog',                  requirePermission('plans.read'),   c.featureCatalog);
router.get   ('/tier-features/:tierKind',          requirePermission('plans.read'),   c.tierFeatures);
router.put   ('/tier-features/:tierKind',          requirePermission('plans.change'),
              audit.middlewareLog('plans', 'set-features', (req) => ({ type: 'tier', id: req.params.tierKind })),
              ...c.setTierFeatures);

// ── Coupons ────────────────────────────────────────────────────────────
router.get   ('/coupons',                      requirePermission('coupons.read'),  c.couponsList);
router.post  ('/coupons',                      requirePermission('coupons.write'),
              audit.middlewareLog('coupons', 'create', (req, b) => ({ type: 'coupon', id: b.coupon?.id })),
              ...c.couponsCreate);
router.patch ('/coupons/:couponId',            requirePermission('coupons.write'),
              audit.middlewareLog('coupons', 'update', (req) => ({ type: 'coupon', id: req.params.couponId })),
              c.couponsUpdate);
router.post  ('/coupons/:couponId/disable',    requirePermission('coupons.write'),
              audit.middlewareLog('coupons', 'disable', (req) => ({ type: 'coupon', id: req.params.couponId })),
              c.couponsDisable);
router.get   ('/coupons/:couponId/redemptions', requirePermission('coupons.read'), c.couponRedemptions);

// ── FF-402 CRM primitives ─────────────────────────────────────────────
// Activity feed + tasks + health score + renewal alerts. Uses the
// existing 'customers.read' / 'customers.write' / 'notes.write' scopes
// so support agents get read access without needing full write.
router.get ('/customers/:businessId/crm/activities',
            requirePermission('customers.read'), c.listActivitiesCtrl);
router.post('/customers/:businessId/crm/activities',
            requirePermission('notes.write'),
            audit.middlewareLog('crm', 'activity', (req) => ({ type: 'business', id: req.params.businessId })),
            ...c.addActivityCtrl);
router.post('/customers/:businessId/crm/recompute-health',
            requirePermission('customers.read'), c.recomputeHealthCtrl);

router.get ('/crm/tasks',           requirePermission('customers.read'), c.listTasksCtrl);
router.post('/crm/tasks',           requirePermission('notes.write'),
            audit.middlewareLog('crm', 'task-create', (req, b) => ({ type: 'task', id: b.task?.id })),
            ...c.createTaskCtrl);
router.post('/crm/tasks/:taskId/complete',
            requirePermission('notes.write'),
            audit.middlewareLog('crm', 'task-done', (req) => ({ type: 'task', id: req.params.taskId })),
            c.completeTaskCtrl);

router.get ('/crm/renewals',        requirePermission('customers.read'), c.renewalsCtrl);
router.post('/crm/recompute-all-health',
            requirePermission('customers.write'), c.recomputeAllHealthCtrl);

// ── Refunds ────────────────────────────────────────────────────────────
router.get   ('/refunds',  requirePermission('refunds.read'),  c.refundsList);
router.post  ('/refunds',  requirePermission('refunds.write'),
              audit.middlewareLog('refunds', 'initiate', (req, b) => ({ type: 'refund', id: b.refund?.id })),
              ...c.refundsInitiate);

// ── GST ────────────────────────────────────────────────────────────────
router.get   ('/gst/summary',  requirePermission('gst.read'), c.gstSummary);
router.get   ('/gst/gstr1.csv',requirePermission('gst.read'), c.gstr1Csv);
router.get   ('/gst/gstr3b',   requirePermission('gst.read'), c.gstr3b);
// Push 19d — HSN-wise summary + B2B/B2C split
router.get   ('/gst/hsn',      requirePermission('gst.read'), c.gstHsnSummary);
router.get   ('/gst/b2b-b2c',  requirePermission('gst.read'), c.gstB2bB2c);

// ── Settings ───────────────────────────────────────────────────────────
// P0-12 fix: PUT /settings was guarded by 'settings.read' which let any admin
// role write platform settings. Now requires 'settings.write' which is ONLY
// granted to super_admin (see middleware/adminRbac.js).
router.get   ('/settings',  requirePermission('settings.read'),  c.settingsList);
router.put   ('/settings',  requirePermission('settings.write'),
              audit.middlewareLog('settings', 'update'),
              c.settingsBulkSet);

// ── Reports (advanced) ─────────────────────────────────────────────────
router.get   ('/reports/cohorts',     requirePermission('reports.read'), c.reportCohorts);
router.get   ('/reports/funnel',      requirePermission('reports.read'), c.reportFunnel);
router.get   ('/reports/ltv',         requirePermission('reports.read'), c.reportLtv);
router.get   ('/reports/churn',       requirePermission('reports.read'), c.reportChurn);
router.get   ('/reports/top-items',   requirePermission('reports.read'), c.reportItems);
router.get   ('/reports/top-cities',  requirePermission('reports.read'), c.reportCities);
router.get   ('/reports/mrr-trend',   requirePermission('reports.read'), c.reportMrr);
// Push 19e — outstanding invoices + aging buckets
router.get   ('/reports/outstanding', requirePermission('reports.read'), c.reportOutstanding);
// Push 20d — platform consolidated P&L + customer KPIs + revenue split
router.get   ('/reports/pnl',                requirePermission('reports.read'), c.reportPnl);
router.get   ('/reports/customers-kpi',      requirePermission('reports.read'), c.reportCustomersKpi);
router.get   ('/reports/revenue-breakdown',  requirePermission('reports.read'), c.reportRevenueBreakdown);

// ── Audit & Webhooks ───────────────────────────────────────────────────
router.get   ('/audit',           requirePermission('audit.read'), c.auditLog);
router.get   ('/webhooks/events', requirePermission('audit.read'), c.webhookEvents);

// ── DPDP compliance (Push 21) ─────────────────────────────────────────
// We deliberately reuse the existing 'settings' permission family for
// settings reads/writes and 'audit' for DSR / grievance / breach views,
// so we don't need a fresh adminRbac column. If granular permissions
// are needed later, add 'compliance.read' / 'compliance.write' in a
// follow-up migration.
const compliance = require('../controllers/complianceController');
router.get   ('/compliance/settings',
              requirePermission('settings.read'),
              compliance.adminGetSettings);
router.put   ('/compliance/settings',
              requirePermission('settings.write'),
              audit.middlewareLog('compliance', 'settings-update', () => ({ type: 'compliance', id: 'settings' })),
              ...compliance.adminUpdateSettings);

router.get   ('/compliance/dsr',         requirePermission('audit.read'),  compliance.adminListDSRs);
router.patch ('/compliance/dsr/:id',     requirePermission('audit.read'),
              audit.middlewareLog('compliance', 'dsr-update',
                (req) => ({ type: 'dsr', id: req.params.id })),
              ...compliance.adminUpdateDSR);

router.get   ('/compliance/grievances',  requirePermission('audit.read'),  compliance.adminListGrievances);
router.patch ('/compliance/grievances/:id', requirePermission('audit.read'),
              audit.middlewareLog('compliance', 'grievance-update',
                (req) => ({ type: 'grievance', id: req.params.id })),
              ...compliance.adminUpdateGrievance);

router.get   ('/compliance/breaches',    requirePermission('audit.read'),  compliance.adminListBreaches);
router.post  ('/compliance/breaches',    requirePermission('settings.write'),
              audit.middlewareLog('compliance', 'breach-log', () => ({ type: 'breach' })),
              ...compliance.adminLogBreach);
router.patch ('/compliance/breaches/:id',requirePermission('settings.write'),
              audit.middlewareLog('compliance', 'breach-update',
                (req) => ({ type: 'breach', id: req.params.id })),
              ...compliance.adminUpdateBreach);

// ── Admin team ─────────────────────────────────────────────────────────
const onlySuper = (req, _res, next) => {
  // Only super_admin can manage admins (not finance / support / sales)
  if (req.user?.role !== 'super_admin') {
    return next(Object.assign(new Error('Only super_admin can manage admin team'),
      { statusCode: 403, code: 'FORBIDDEN' }));
  }
  next();
};

router.get   ('/team',                   onlySuper, c.teamList);
router.post  ('/team',                   onlySuper,
              audit.middlewareLog('admin-team', 'create', (req, b) => ({ type: 'admin', id: b.admin?.id })),
              ...c.teamCreate);
router.patch ('/team/:adminId',          onlySuper,
              audit.middlewareLog('admin-team', 'update', (req) => ({ type: 'admin', id: req.params.adminId })),
              ...c.teamUpdate);
router.delete('/team/:adminId',          onlySuper,
              audit.middlewareLog('admin-team', 'deactivate', (req) => ({ type: 'admin', id: req.params.adminId })),
              c.teamDeactivate);

// ── Force-close-unpaid session (P2, 2026-08-22) ────────────────────────
// Support ticket lands: guest walked out without paying, table is stuck,
// owner can't clear it. Super-admin closes the session on their behalf
// which (a) cancels open orders with reason='walkout', (b) frees the
// table, (c) records the loss into revenue_leakage_events so it shows
// on the owner's dashboard.
const forceClose = require('../services/forceCloseSessionService');
const asyncHandler = require('../utils/asyncHandler');
router.post(
  '/customers/:businessId/sessions/:sessionId/force-close-unpaid',
  requirePermission('customers.write'),
  audit.middlewareLog('sessions', 'force-close-unpaid',
    (req) => ({ type: 'table_session', id: req.params.sessionId })),
  asyncHandler(async (req, res) => {
    const out = await forceClose.forceCloseUnpaid(
      req.params.businessId,
      req.params.sessionId,
      // P2 fix (2026-08-22): auth middleware sets req.user, not req.admin
      { reason: req.body?.reason, adminId: req.user?.id || req.admin?.id || null },
    );
    res.json(out);
  }),
);

module.exports = router;
