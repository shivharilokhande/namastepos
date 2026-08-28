// NamastePOS backend - super admin endpoints (full SaaS surface)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const logger = require('../config/logger');

const adminTeam   = require('../services/adminTeamService');
const adminCust   = require('../services/customerAdminService');
const sub         = require('../services/subscriptionService');
const coupons     = require('../services/couponService');
const refunds     = require('../services/refundService');
const settings    = require('../services/settingsService');
const gst         = require('../services/gstService');
const reports     = require('../services/platformReportsService');
const audit       = require('../services/auditService');
const adminLegacy = require('../services/adminService');     // kept for old metrics()
const razorpay    = require('../services/razorpayService');
const features    = require('../services/featureService');   // Push 14d feature catalog
const menuService = require('../services/menuService');       // Push 20b bulk import
const { query }   = require('../config/db');

const loginBody = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

// ── Auth ────────────────────────────────────────────────────────────────
const login = [
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const r = await adminTeam.login(req.body.email, req.body.password);
    res.json(r);
  }),
];

const me = asyncHandler(async (req, res) => {
  const admin = await adminTeam.me(req.user.id);
  res.json({ admin });
});

// ── 2FA (QA-8 P1) ───────────────────────────────────────────────────────
const twoFactor = require('../services/twoFactorService');

const twoFaVerify = [
  validate({ body: Joi.object({
    challengeId: Joi.string().uuid().required(),
    code: Joi.string().min(6).max(20).required(),
  })}),
  asyncHandler(async (req, res) => {
    const r = await adminTeam.complete2faLogin(req.body.challengeId, req.body.code);
    res.json(r);
  }),
];

const twoFaEnrolStart = asyncHandler(async (req, res) => {
  const r = await twoFactor.startEnrolment(req.user.id, req.user.email);
  res.json(r); // { otpauth, secret, recoveryCodes }
});

const twoFaEnrolConfirm = [
  validate({ body: Joi.object({ code: Joi.string().length(6).required() })}),
  asyncHandler(async (req, res) => {
    const r = await twoFactor.confirmEnrolment(req.user.id, req.body.code);
    res.json(r);
  }),
];

// Security fix (2026-08-25): require a valid current TOTP / recovery code in
// the body to disable 2FA (see twoFactorService.disable).
const twoFaDisable = [
  validate({ body: Joi.object({ code: Joi.string().min(6).max(20).required() })}),
  asyncHandler(async (req, res) => {
    await twoFactor.disable(req.user.id, req.body.code);
    res.json({ disabled: true });
  }),
];

// ── Admin team CRUD ─────────────────────────────────────────────────────
const teamList = asyncHandler(async (_req, res) => {
  res.json({ admins: await adminTeam.list() });
});
const teamCreate = [
  validate({ body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    displayName: Joi.string().allow(null),
    role: Joi.string().valid('super_admin', 'finance', 'support', 'sales').default('support'),
  })}),
  asyncHandler(async (req, res) => {
    const admin = await adminTeam.create({ ...req.body, invitedBy: req.user.id });
    res.status(201).json({ admin });
  }),
];
const teamUpdate = [
  validate({ body: Joi.object({
    display_name: Joi.string().allow(null, ''),
    role: Joi.string().valid('super_admin', 'finance', 'support', 'sales'),
    is_active: Joi.boolean(),
    password: Joi.string().min(6),
  }).min(1)}),
  asyncHandler(async (req, res) => {
    const admin = await adminTeam.update(req.params.adminId, req.body, req.user.id);
    res.json({ admin });
  }),
];
const teamDeactivate = asyncHandler(async (req, res) => {
  await adminTeam.deactivate(req.params.adminId, req.user.id);
  res.json({ success: true });
});

// ── Customers (list / detail / drilldown / CRUD) ────────────────────────
const listCustomers = asyncHandler(async (req, res) => {
  const result = await adminLegacy.listCustomers({
    search: req.query.search,
    plan: req.query.plan,
    status: req.query.status,
    limit: Math.min(parseInt(req.query.limit || '50', 10), 200),
    offset: parseInt(req.query.offset || '0', 10),
  });
  res.json(result);
});

const getCustomer = asyncHandler(async (req, res) => {
  res.json({ customer: await adminLegacy.getCustomer(req.params.businessId) });
});

const drilldown = asyncHandler(async (req, res) => {
  res.json(await adminCust.drilldown(req.params.businessId));
});

// GST-compliant subscription invoice PDF for a customer's invoice — generated
// on demand (no dependency on Razorpay hosting a PDF). Scoped to the business
// so the id in the path must belong to that customer.
const subInvoice = require('../services/subscriptionInvoiceService');
const invoicePdf = asyncHandler(async (req, res) => {
  await subInvoice.renderPdf(res, {
    invoiceId: req.params.invoiceId,
    businessId: req.params.businessId,
  });
});

const createCustomerBody = Joi.object({
  email: Joi.string().email().required(),
  name: Joi.string().min(1).max(255).required(),
  ownerName: Joi.string().max(255).allow('', null),
  phone: Joi.string().max(20).allow('', null),
  city: Joi.string().max(100).allow('', null),
  category: Joi.string().max(50).allow('', null),
  // Push 18a — plan tiers are now arbitrary VARCHAR (e.g. starter/pro/enterprise/custom).
  // Allow any reasonable kebab/snake string; the service layer verifies the
  // tier exists in the plans table and 404s otherwise.
  planTier: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).default('free'),
  trialDays: Joi.number().integer().min(0).max(365).default(14),
});

const createCustomer = [
  validate({ body: createCustomerBody }),
  asyncHandler(async (req, res) => {
    const business = await adminCust.createCustomer(req.body);
    res.status(201).json({ business });
  }),
];

const updateCustomer = asyncHandler(async (req, res) => {
  const business = await adminCust.updateCustomer(req.params.businessId, req.body);
  res.json({ business });
});

const extendTrialBody = Joi.object({
  days: Joi.number().integer().min(1).max(365).required(),
});
const extendTrial = [
  validate({ body: extendTrialBody }),
  asyncHandler(async (req, res) => {
    const sub2 = await adminCust.extendTrial(req.params.businessId, req.body.days);
    res.json({ subscription: sub2 });
  }),
];

const setPlanBody = Joi.object({
  tier: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).required(),
  // FF-402c — cadence lives on the SUBSCRIPTION, not the plan. Admin
  // picks monthly or yearly independently of which plan tier.
  billingPeriod: Joi.string().valid('monthly', 'yearly'),
});
const setPlanManually = [
  validate({ body: setPlanBody }),
  asyncHandler(async (req, res) => {
    const sub2 = await adminCust.setPlanManually(
      req.params.businessId, req.body.tier,
      { billingPeriod: req.body.billingPeriod }
    );
    // FF-402 — auto-log to the CRM activity feed so support sees the
    // plan change alongside notes/refunds in one timeline.
    require('../services/crmService').logActivity({
      businessId: req.params.businessId, kind: 'plan_change',
      title: `Plan set to ${req.body.tier}${req.body.billingPeriod ? ` (${req.body.billingPeriod})` : ''}`,
      meta: { toTier: req.body.tier, billingPeriod: req.body.billingPeriod,
              subscriptionStatus: sub2?.status },
      actorType: 'admin', actorEmail: req.admin?.email,
    });
    res.json({ subscription: sub2 });
  }),
];

const suspend = asyncHandler(async (req, res) => {
  await adminLegacy.suspend(req.params.businessId);
  res.json({ success: true });
});
const restore = asyncHandler(async (req, res) => {
  await adminLegacy.restore(req.params.businessId);
  res.json({ success: true });
});
const impersonate = asyncHandler(async (req, res) => {
  res.json(await adminLegacy.impersonate(req.params.businessId));
});
const deleteCustomer = asyncHandler(async (req, res) => {
  await adminCust.deleteCustomer(req.params.businessId);
  res.json({ success: true });
});

const addNoteBody = Joi.object({
  body: Joi.string().min(1).required(),
  pinned: Joi.boolean().default(false),
});
const addNote = [
  validate({ body: addNoteBody }),
  asyncHandler(async (req, res) => {
    const note = await adminCust.addNote({
      businessId: req.params.businessId,
      adminId: req.user.id,
      body: req.body.body, pinned: req.body.pinned,
    });
    res.status(201).json({ note });
  }),
];
const deleteNote = asyncHandler(async (req, res) => {
  // P0-10: route is /customers/:businessId/notes/:noteId — pass both so the
  // delete is tenant-scoped and can't be exploited cross-tenant.
  await adminCust.deleteNote(req.params.businessId, req.params.noteId);
  res.json({ success: true });
});

// ── Plans CRUD ──────────────────────────────────────────────────────────
const listPlans = asyncHandler(async (_req, res) => {
  res.json({ plans: await sub.listAllPlans() });
});
const updatePlan = asyncHandler(async (req, res) => {
  const plan = await sub.updatePlan(req.params.tier, req.body);
  // Price-change fix (2026-08-25): Razorpay plans are immutable, so a
  // price edit must produce a replacement Razorpay plan. syncPlans is now
  // amount-aware; run it right away (best-effort — a Razorpay hiccup must
  // not fail the admin save; the manual Sync button remains as fallback).
  if (req.body && (req.body.price_inr_paise != null
      || req.body.price_yearly_paise != null)) {
    try { await razorpay.syncPlans(); } catch (err) {
      logger.warn(`Auto plan-sync after price change failed: ${err.message}`);
    }
  }
  res.json({ plan: (await sub.listAllPlans()).find((p) => p.tier === req.params.tier) || plan });
});
const syncRazorpayPlans = asyncHandler(async (_req, res) => {
  await razorpay.syncPlans();
  res.json({ plans: await sub.listAllPlans() });
});

// Push 14d / 18a — create / delete plan. `tier` is now any string (was
// previously locked to the plan_tier enum's free/basic/pro). The DB
// column is VARCHAR(40) after migration 039 so super-admin can spin
// up arbitrary tier names like 'pro_lite' or 'enterprise_plus'.
const createPlanBody = Joi.object({
  tier: Joi.string().min(1).max(40).pattern(/^[a-z0-9_]+$/).required()
    .messages({ 'string.pattern.base': 'tier must be lowercase letters, numbers, or underscores only' }),
  tier_kind: Joi.string().valid('starter', 'pro', 'enterprise').required(),
  name: Joi.string().min(1).max(60).required(),
  price_inr_paise: Joi.number().integer().min(0).default(0),
  // FF-402c — yearly is now a SIBLING price on the same plan row.
  // Null = plan doesn't offer yearly; undefined = auto-fill 10× monthly.
  price_yearly_paise: Joi.number().integer().min(0).allow(null),
  billing_period: Joi.string().valid('monthly', 'yearly').default('monthly'),
  is_active: Joi.boolean().default(true),
  limits: Joi.object().default({}),
  features: Joi.object().default({}),
  razorpay_plan_id: Joi.string().allow(null, ''),
  razorpay_plan_id_yearly: Joi.string().allow(null, ''),
});
const createPlan = [
  validate({ body: createPlanBody }),
  asyncHandler(async (req, res) => {
    const p = await sub.createPlan(req.body);
    res.status(201).json({ plan: sub.serializePlan(p) });
  }),
];
const deletePlan = asyncHandler(async (req, res) => {
  await sub.deletePlan(req.params.tier);
  res.json({ success: true });
});

// Push 14d — feature catalog + tier feature matrix CRUD. The feature
// matrix is the source of truth for what plan_features each tier_kind
// grants; the owner dashboard + mobile gate UI by these keys.
const featureCatalog = asyncHandler(async (_req, res) => {
  res.json({ features: await features.listFeatureCatalog() });
});
const tierFeatures = asyncHandler(async (req, res) => {
  res.json({
    tierKind: req.params.tierKind,
    features: await features.listTierFeatures(req.params.tierKind),
  });
});
const setTierFeaturesBody = Joi.object({
  features: Joi.array().items(Joi.string().min(1).max(60)).required(),
});
const setTierFeatures = [
  validate({ body: setTierFeaturesBody }),
  asyncHandler(async (req, res) => {
    const next = await features.setTierFeatures(req.params.tierKind, req.body.features);
    res.json({ tierKind: req.params.tierKind, features: next });
  }),
];

// ── Coupons CRUD ────────────────────────────────────────────────────────
const couponsList = asyncHandler(async (req, res) => {
  res.json({ coupons: await coupons.list(req.query) });
});
const couponBody = Joi.object({
  code: Joi.string().min(2).max(50).required(),
  description: Joi.string().max(500).allow('', null),
  type: Joi.string().valid('percent', 'flat', 'trial_extension').required(),
  value: Joi.number().positive().required(),
  appliesToPlan: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).allow(null, ''),
  maxRedemptions: Joi.number().integer().min(1).allow(null),
  expiresAt: Joi.date().allow(null),
});
const couponsCreate = [
  validate({ body: couponBody }),
  asyncHandler(async (req, res) => {
    const c = await coupons.create({ ...req.body, createdBy: req.user.id });
    res.status(201).json({ coupon: c });
  }),
];
const couponsUpdate = asyncHandler(async (req, res) => {
  const c = await coupons.update(req.params.couponId, req.body);
  res.json({ coupon: c });
});
const couponsDisable = asyncHandler(async (req, res) => {
  res.json({ coupon: await coupons.disable(req.params.couponId) });
});
const couponRedemptions = asyncHandler(async (req, res) => {
  res.json({ redemptions: await coupons.listRedemptions(req.params.couponId) });
});

// ── Refunds ─────────────────────────────────────────────────────────────
const refundsList = asyncHandler(async (req, res) => {
  res.json({ refunds: await refunds.list(req.query) });
});
const refundBody = Joi.object({
  paymentId: Joi.string().uuid().required(),
  amountPaise: Joi.number().integer().min(1),
  reason: Joi.string().max(500).allow('', null),
  // Fix (2026-08-25): the CRM-timeline logging below reads req.body.businessId
  // / orderId, but validate() runs with allowUnknown:false so these were
  // rejected before the handler ever saw them — the timeline branch was dead.
  // Accept them as optional context so the refund lands on the tenant's feed.
  businessId: Joi.string().uuid().allow(null),
  orderId: Joi.string().uuid().allow(null),
});
const refundsInitiate = [
  validate({ body: refundBody }),
  asyncHandler(async (req, res) => {
    const r = await refunds.initiate({ ...req.body, adminId: req.user.id });
    // FF-402 — refund lands on the tenant's CRM timeline.
    if (req.body.businessId) {
      require('../services/crmService').logActivity({
        businessId: req.body.businessId, kind: 'refund',
        title: `Refund initiated ₹${((req.body.amountPaise || 0) / 100).toFixed(2)}`,
        meta: { refundId: r?.id, orderId: req.body.orderId, reason: req.body.reason },
        actorType: 'admin', actorEmail: req.admin?.email,
      });
    }
    res.status(201).json({ refund: r });
  }),
];

// ── Settings ────────────────────────────────────────────────────────────
const settingsList = asyncHandler(async (_req, res) => {
  res.json({ settings: await settings.getAll() });
});
const settingsBulkSet = asyncHandler(async (req, res) => {
  const out = await settings.bulkSet(req.body, { adminId: req.user.id });
  res.json({ settings: out });
});

// ── GST ─────────────────────────────────────────────────────────────────
const gstSummary = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json({ summary: await gst.gstrSummary(month) });
});
const gstr1Csv = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const summary = await gst.gstrSummary(month);
  const csv = gst.gstr1Csv(summary);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="gstr1-${month}.csv"`);
  res.send(csv);
});
const gstr3b = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const summary = await gst.gstrSummary(month);
  res.json({ gstr3b: gst.gstr3bSummary(summary) });
});
// Push 19d — GSTR-1 Table 12 HSN summary
const gstHsnSummary = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const summary = await gst.gstrSummary(month);
  res.json({ month, hsn: gst.hsnSummary(summary) });
});
// Push 19d — B2B vs B2C split (Tables 4 / 5 / 7)
const gstB2bB2c = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const summary = await gst.gstrSummary(month);
  res.json({ month, ...gst.b2bB2cSplit(summary) });
});

// ── Reports (advanced) ──────────────────────────────────────────────────
const reportCohorts = asyncHandler(async (req, res) => {
  res.json({ cohorts: await reports.cohortRetention({ months: parseInt(req.query.months || '6', 10) }) });
});
const reportFunnel = asyncHandler(async (req, res) => {
  res.json({ funnel: await reports.signupFunnel({ days: parseInt(req.query.days || '30', 10) }) });
});
const reportLtv     = asyncHandler(async (_req, res) => res.json(await reports.ltv()));
const reportChurn   = asyncHandler(async (_req, res) => res.json(await reports.churnRate()));
const reportItems   = asyncHandler(async (req, res) => res.json({ topItems: await reports.topItems(req.query) }));
const reportCities  = asyncHandler(async (req, res) => res.json({ topCities: await reports.topCities(req.query) }));
const reportMrr     = asyncHandler(async (req, res) => res.json({ series: await reports.mrrTrend(req.query) }));
// Push 19e — outstanding (unpaid) invoices + aging buckets
const reportOutstanding = asyncHandler(async (_req, res) => res.json(await reports.outstandingInvoices()));

// N4 (2026-08-27) — consolidated subscription ledger (all tenants: plan,
// status, next-charge, trial, paid/comped/free) + summary.
const reportSubscriptions = asyncHandler(async (req, res) => res.json(
  await reports.subscriptionLedger({ status: req.query.status, billingMode: req.query.billingMode })
));

// X7 (2026-08-28) — support / ticketing (admin console side)
const support = require('../services/supportService');
const supportList = asyncHandler(async (req, res) =>
  res.json({ tickets: await support.listTickets({ status: req.query.status, businessId: req.query.businessId }) }));
const supportGet = asyncHandler(async (req, res) =>
  res.json({ ticket: await support.getTicket(req.params.ticketId) }));
const supportCreate = asyncHandler(async (req, res) => res.status(201).json({
  ticket: await support.createTicket({
    businessId: req.body.businessId, subject: req.body.subject,
    priority: req.body.priority, body: req.body.body,
    authorEmail: req.user?.email, byAdmin: true,
  }),
}));
const supportReply = asyncHandler(async (req, res) => res.json({
  ticket: await support.addMessage(req.params.ticketId, {
    body: req.body.body, authorType: 'admin', authorId: req.user?.id, authorEmail: req.user?.email,
  }),
}));
const supportSetStatus = asyncHandler(async (req, res) =>
  res.json({ ticket: await support.setStatus(req.params.ticketId, req.body.status) }));

// Tenant audit trail (owner/staff money mutations) for a business.
const tenantAudit = asyncHandler(async (req, res) => res.json({
  events: await audit.recentTenant({
    businessId: req.params.businessId,
    limit: Math.min(parseInt(req.query.limit || '100', 10), 500),
    offset: parseInt(req.query.offset || '0', 10),
  }),
}));

// L5 (2026-08-28) — add-on marketplace revenue-share payout report
const reportAddonPayouts = asyncHandler(async (_req, res) => res.json(await reports.addonPayouts()));

// L2 (2026-08-28) — referral program (admin view + reward)
const referral = require('../services/referralService');
const referralList = asyncHandler(async (req, res) =>
  res.json({ referrals: await referral.listAll({ status: req.query.status }) }));
const referralReward = asyncHandler(async (req, res) =>
  res.json({ referral: await referral.markAwarded(req.params.referralId) }));

// X4 (2026-08-28) — in-console tenant broadcast (email a segment via Brevo)
const broadcast = require('../services/broadcastService');
const broadcastPreview = asyncHandler(async (req, res) =>
  res.json(await broadcast.preview(req.query.segment || 'all')));
const broadcastSend = asyncHandler(async (req, res) => res.json(
  await broadcast.send({
    segment: req.body.segment || 'all', subject: req.body.subject,
    body: req.body.body, actorEmail: req.user?.email,
  })
));

// Push 20d — platform consolidated P&L (income, refunds, expenses, net)
const reportPnl = asyncHandler(async (req, res) => {
  res.json(await reports.consolidatedPnl({ from: req.query.from, to: req.query.to }));
});

// Push 20d — customer KPI counts by plan + status
const reportCustomersKpi = asyncHandler(async (_req, res) => {
  res.json(await reports.customersKpi());
});

// Push 20d — monthly revenue split (subscription / addons / refunds / net)
const reportRevenueBreakdown = asyncHandler(async (req, res) => {
  res.json({ series: await reports.revenueBreakdown({
    months: parseInt(req.query.months || '12', 10),
  }) });
});

// Push 20b — bulk menu import (super-admin uploads CSV for a customer)
const customerMenuBulkImport = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const result = await menuService.bulkImport(req.params.businessId, items);
  res.json(result);
});

// Headline metrics (kept for backward compat)
const metrics = asyncHandler(async (_req, res) => res.json(await adminLegacy.metrics()));

// ── Audit log ───────────────────────────────────────────────────────────
const auditLog = asyncHandler(async (req, res) => {
  res.json({ events: await audit.recent({
    limit: Math.min(parseInt(req.query.limit || '100', 10), 500),
    offset: parseInt(req.query.offset || '0', 10),
    module: req.query.module,
    adminId: req.query.adminId,
    businessId: req.query.businessId,
  })});
});

// ── Webhooks log ────────────────────────────────────────────────────────
const webhookEvents = asyncHandler(async (_req, res) => {
  const r = await query(
    `SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ events: r.rows });
});

// ── Health snapshot ─────────────────────────────────────────────────────
const dbHealth = asyncHandler(async (_req, res) => {
  const r = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM businesses)         AS businesses,
      (SELECT COUNT(*)::int FROM users)              AS users,
      (SELECT COUNT(*)::int FROM orders)             AS orders,
      (SELECT COUNT(*)::int FROM subscriptions)      AS subscriptions,
      (SELECT COUNT(*)::int FROM invoices)           AS invoices,
      (SELECT COUNT(*)::int FROM payments)           AS payments,
      (SELECT COUNT(*)::int FROM refunds)            AS refunds,
      (SELECT COUNT(*)::int FROM coupons)            AS coupons,
      pg_size_pretty(pg_database_size(current_database())) AS db_size;
  `);
  res.json(r.rows[0]);
});

// ── FF-402 Admin CRM primitives ─────────────────────────────────────
const crm = require('../services/crmService');

const listActivitiesCtrl = asyncHandler(async (req, res) => {
  const rows = await crm.listActivities(req.params.businessId, {
    limit: req.query.limit || 100,
    kind:  req.query.kind  || null,
  });
  res.json({ activities: rows });
});

const addActivityCtrl = [
  validate({ body: Joi.object({
    kind:  Joi.string().max(40).default('note'),
    title: Joi.string().max(500).required(),
    body:  Joi.string().max(5000).allow('', null),
    meta:  Joi.object().default({}),
  })}),
  asyncHandler(async (req, res) => {
    const id = await crm.logActivity({
      businessId: req.params.businessId,
      kind: req.body.kind, title: req.body.title, body: req.body.body,
      meta: req.body.meta || {},
      actorType: 'admin', actorEmail: req.admin?.email,
    });
    res.status(201).json({ id });
  }),
];

const listTasksCtrl = asyncHandler(async (req, res) => {
  const tasks = await crm.listTasks({
    businessId: req.query.businessId || null,
    ownerEmail: req.query.ownerEmail || null,
    openOnly:   req.query.openOnly !== 'false',
  });
  res.json({ tasks });
});

const createTaskCtrl = [
  validate({ body: Joi.object({
    businessId:  Joi.string().uuid().allow(null),
    title:       Joi.string().min(1).max(500).required(),
    notes:       Joi.string().max(5000).allow('', null),
    ownerEmail:  Joi.string().email().allow('', null),
    dueAt:       Joi.date().iso().allow(null),
  })}),
  asyncHandler(async (req, res) => {
    const task = await crm.createTask({
      ...req.body,
      createdBy: req.admin?.email,
    });
    res.status(201).json({ task });
  }),
];

const completeTaskCtrl = asyncHandler(async (req, res) => {
  const t = await crm.completeTask(req.params.taskId, req.admin?.email);
  if (!t) return res.status(404).json({ message: 'Task not found or already done' });
  res.json({ task: t });
});

const recomputeHealthCtrl = asyncHandler(async (req, res) => {
  const h = await crm.computeHealth(req.params.businessId);
  res.json({ health: h });
});

const recomputeAllHealthCtrl = asyncHandler(async (_req, res) => {
  const r = await crm.recomputeAllHealth();
  res.json(r);
});

const renewalsCtrl = asyncHandler(async (req, res) => {
  const days = Math.min(60, Math.max(1, +req.query.days || 7));
  const items = await crm.upcomingRenewals({ days });
  res.json({ items });
});

module.exports = {
  login, me,
  twoFaVerify, twoFaEnrolStart, twoFaEnrolConfirm, twoFaDisable,
  teamList, teamCreate, teamUpdate, teamDeactivate,
  listCustomers, getCustomer, drilldown, invoicePdf,
  createCustomer, updateCustomer,
  extendTrial, setPlanManually,
  suspend, restore, impersonate, deleteCustomer,
  addNote, deleteNote,
  listPlans, updatePlan, syncRazorpayPlans, createPlan, deletePlan,
  featureCatalog, tierFeatures, setTierFeatures,
  couponsList, couponsCreate, couponsUpdate, couponsDisable, couponRedemptions,
  refundsList, refundsInitiate,
  settingsList, settingsBulkSet,
  gstSummary, gstr1Csv, gstr3b, gstHsnSummary, gstB2bB2c,
  reportCohorts, reportFunnel, reportLtv, reportChurn, reportItems, reportCities, reportMrr,
  reportOutstanding, reportSubscriptions,
  reportPnl, reportCustomersKpi, reportRevenueBreakdown,
  supportList, supportGet, supportCreate, supportReply, supportSetStatus,
  broadcastPreview, broadcastSend,
  referralList, referralReward, reportAddonPayouts, tenantAudit,
  customerMenuBulkImport,
  auditLog, webhookEvents, dbHealth, metrics,
  // FF-402
  listActivitiesCtrl, addActivityCtrl,
  listTasksCtrl, createTaskCtrl, completeTaskCtrl,
  recomputeHealthCtrl, recomputeAllHealthCtrl, renewalsCtrl,
};
