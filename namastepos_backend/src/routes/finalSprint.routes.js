// Final-sprint routes (bill split, food coupons, P&L, forecast, upsell,
// reviews, FX, surge, KDS, captain mode, voice ordering, B2B template, etc.)

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');

const billSplit = require('../services/billSplitService');
const foodCoupons = require('../services/foodCouponService');
const reviews = require('../services/reviewsService');
const forecast = require('../services/forecastService');
const upsell = require('../services/upsellService');
const pnl = require('../services/pnlService');
const tdsTcs = require('../services/tdsTcsService');
const fx = require('../services/fxService');
const bankRecon = require('../services/bankReconcileService');
const surge = require('../services/surgePricingService');
const kds = require('../services/kdsService');
const { query } = require('../config/db');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── Heat-map endpoint (F40) ──────────────────────────────────────────────
router.get('/reports/orders-by-hour', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT day_of_week, hour_of_day, order_count, revenue_inr
       FROM vw_orders_by_hour WHERE business_id = $1
      ORDER BY day_of_week, hour_of_day`,
    [req.params.businessId],
  );
  res.json({ rows: r.rows });
}));

// ── Dead-stock report (FF-1105) ──────────────────────────────────────────
router.get('/reports/dead-stock', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => {
  // P2 fix (2026-08-22): ?days=abc → NaN → invalid INTERVAL → 500.
  // Clamp to a sane 1–365 window.
  const daysRaw = parseInt(req.query.days || '30', 10);
  const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;
  const r = await query(
    `SELECT * FROM vw_dead_stock
      WHERE business_id = $1
        AND (last_sold_at IS NULL OR last_sold_at < NOW() - INTERVAL '${days} days')
      ORDER BY last_sold_at NULLS FIRST`,
    [req.params.businessId],
  );
  res.json({ rows: r.rows });
}));

// ── Bill split ───────────────────────────────────────────────────────────
router.post(
  '/sessions/:sessionId/split',
  validate({ body: Joi.object({
    mode: Joi.string().valid('equal', 'by_item', 'custom').required(),
    splits: Joi.array().items(Joi.object({
      guestLabel: Joi.string().allow('', null),
      customerPhone: Joi.string().allow('', null),
      amount: Joi.number().min(0),
      items: Joi.array().items(Joi.object({
        orderItemId: Joi.string().uuid().required(),
        qty: Joi.number().positive().required(),
      })),
    })).min(2).required(),
  }) }),
  asyncHandler(async (req, res) => res.json({ split: await billSplit.splitSession(req.params.businessId, req.params.sessionId, req.body) })),
);
router.put(
  '/bill-split-invoices/:id/pay',
  validate({ body: Joi.object({ paymentMethod: Joi.string().valid('cash', 'upi', 'card', 'online').default('cash') }) }),
  asyncHandler(async (req, res) => res.json({ invoice: await billSplit.paySplit(req.params.businessId, req.params.id, req.body.paymentMethod) })),
);
router.get('/sessions/:sessionId/splits', asyncHandler(async (req, res) => res.json({ splits: await billSplit.listForSession(req.params.businessId, req.params.sessionId) })));

// ── Food coupons ─────────────────────────────────────────────────────────
// 2026-08-25 — ?includeInactive=true lets the dashboard list deactivated
// coupons too (soft-deleted rows stay for redemption history).
router.get('/food-coupons', asyncHandler(async (req, res) => res.json({ coupons: await foodCoupons.listForBusiness(req.params.businessId, { includeInactive: req.query.includeInactive === 'true' }) })));
router.post(
  '/food-coupons/apply',
  validate({ body: Joi.object({
    code: Joi.string().required(),
    subtotal: Joi.number().positive().required(),
    customerId: Joi.string().uuid().allow(null),
  }) }),
  asyncHandler(async (req, res) => res.json(await foodCoupons.applyToOrder(req.params.businessId, req.body))),
);
// 2026-08-25 — owner-managed coupon CRUD (founder #13: "10% off upto ₹50").
// maxDiscountInr caps percent coupons only — a flat coupon IS its own cap.
router.post(
  '/food-coupons',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    code: Joi.string().alphanum().min(3).max(30)
      .required(),
    type: Joi.string().valid('percent', 'flat').required(),
    value: Joi.when('type', {
      is: 'percent',
      then: Joi.number().positive().max(100).required(),
      otherwise: Joi.number().positive().required(),
    }),
    maxDiscountInr: Joi.when('type', {
      is: 'percent',
      then: Joi.number().positive(),
      otherwise: Joi.forbidden(),
    }),
    expiresAt: Joi.date().iso(),
    maxRedemptions: Joi.number().integer().positive(),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ coupon: await foodCoupons.createForBusiness(req.params.businessId, req.body) })),
);
router.put(
  '/food-coupons/:id',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    code: Joi.string().alphanum().min(3).max(30),
    value: Joi.number().positive(), // percent ≤ 100 enforced in service (type isn't editable here)
    maxDiscountInr: Joi.number().positive().allow(null),
    expiresAt: Joi.date().iso().allow(null),
    maxRedemptions: Joi.number().integer().positive().allow(null),
    status: Joi.string().valid('active', 'inactive'),
  }).min(1) }),
  asyncHandler(async (req, res) => res.json({ coupon: await foodCoupons.updateForBusiness(req.params.businessId, req.params.id, req.body) })),
);
// DELETE = deactivate (soft), so redemption history survives.
router.delete(
  '/food-coupons/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json({ coupon: await foodCoupons.deactivate(req.params.businessId, req.params.id) })),
);

// ── Reviews ──────────────────────────────────────────────────────────────
router.get('/reviews', asyncHandler(async (req, res) => res.json({ reviews: await reviews.listReviews(req.params.businessId, req.query) })));
router.get('/reviews/stats', asyncHandler(async (req, res) => res.json({ stats: await reviews.reviewStats(req.params.businessId) })));
router.post(
  '/reviews/:id/reply',
  validate({ body: Joi.object({ reply: Joi.string().min(1).max(2000).required() }) }),
  asyncHandler(async (req, res) => res.json({ review: await reviews.postReply(req.params.businessId, req.params.id, req.body.reply) })),
);
router.post(
  '/reviews/fetch',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await reviews.fetchAllProviders(req.params.businessId))),
);

// ── Forecast + upsell ────────────────────────────────────────────────────
router.get('/forecast', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ forecast: await forecast.getForecast(req.params.businessId, req.query.date) })));
router.post(
  '/forecast/refresh',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json(await forecast.refreshForecast(req.params.businessId))),
);
router.get('/upsell/:menuItemId', asyncHandler(async (req, res) => res.json({ suggestions: await upsell.suggestFor(req.params.businessId, req.params.menuItemId, Number(req.query.limit) || 3) })));
router.post(
  '/upsell/refresh',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await upsell.refreshRules(req.params.businessId))),
);

// ── Accounting (P&L + Balance Sheet + Trial Balance) ────────────────────
router.post(
  '/accounting/seed-coa',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await pnl.seedCoa(req.params.businessId);
    res.json({ success: true });
  }),
);
router.get(
  '/accounting/trial-balance',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json({ tb: await pnl.trialBalance(req.params.businessId, req.query.asOf) })),
);
router.get(
  '/accounting/profit-loss',
  requireRole(['business_owner', 'staff_manager']),
  validate({ query: Joi.object({
    startDate: Joi.date().iso().required(), endDate: Joi.date().iso().required(),
  }) }),
  asyncHandler(async (req, res) => res.json({ pnl: await pnl.profitAndLoss(req.params.businessId, req.query) })),
);
router.get(
  '/accounting/balance-sheet',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json({ bs: await pnl.balanceSheet(req.params.businessId, req.query.asOf) })),
);

// ── TDS / TCS ────────────────────────────────────────────────────────────
router.get('/tds-tcs/rules', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ rules: await tdsTcs.listRules(req.params.businessId) })));
router.post(
  '/tds-tcs/rules',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await tdsTcs.upsertRule(req.params.businessId, req.body);
    res.json({ rules: await tdsTcs.listRules(req.params.businessId) });
  }),
);

// ── FX rates ────────────────────────────────────────────────────────────
router.get('/fx/:base/:quote', asyncHandler(async (req, res) => {
  const rate = await fx.getRate(req.params.base, req.params.quote);
  res.json({ rate });
}));
// P0 fix (2026-08-22): route used to let any business_owner overwrite
// the platform-wide fx_rates table — same rows shared by all tenants,
// no business_id column. Since fx rates are globally shared until we
// migrate to per-tenant storage, the write path is now super-admin-only.
// Owners still get read via GET /fx/:base/:quote.
router.put(
  '/fx/:base/:quote',
  asyncHandler(async (_req, res) => res.status(403).json({
    error: 'FX_WRITE_SUPERADMIN_ONLY',
    message: 'FX rates are managed centrally. Contact support.',
  })),
);

// ── Bank reconciliation ─────────────────────────────────────────────────
router.post(
  '/bank/import',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    bankName: Joi.string().required(),
    accountNo: Joi.string().required(),
    rows: Joi.array().items(Joi.object().unknown(true)).required(),
  }) }),
  asyncHandler(async (req, res) => res.json(await bankRecon.importStatement(req.params.businessId, req.body.bankName, req.body.accountNo, req.body.rows))),
);
router.post(
  '/bank/auto-match',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await bankRecon.autoMatch(req.params.businessId))),
);
router.get('/bank/unmatched', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ rows: await bankRecon.listUnmatched(req.params.businessId) })));

// ── Surge pricing ────────────────────────────────────────────────────────
router.get('/surge/current', asyncHandler(async (req, res) => res.json({ surge: await surge.currentSurge(req.params.businessId) })));
router.get('/surge/rules', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ rules: await surge.listRules(req.params.businessId) })));
router.post(
  '/surge/rules',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    name: Joi.string().required(),
    dayOfWeek: Joi.number().integer().min(0).max(6)
      .allow(null),
    startMinute: Joi.number().integer().min(0).max(1440)
      .required(),
    endMinute: Joi.number().integer().min(0).max(1440)
      .required(),
    multiplier: Joi.number().positive().required(),
    flatExtraPaise: Joi.number().integer().min(0).default(0),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ rule: await surge.createRule(req.params.businessId, req.body) })),
);
// 2026-08-23 — edit + delete (owner-only, like create)
router.put(
  '/surge/rules/:ruleId',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    name: Joi.string(),
    dayOfWeek: Joi.number().integer().min(0).max(6)
      .allow(null),
    startMinute: Joi.number().integer().min(0).max(1440),
    endMinute: Joi.number().integer().min(0).max(1440),
    multiplier: Joi.number().positive(),
    flatExtraPaise: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
  }).min(1) }),
  asyncHandler(async (req, res) => res.json({ rule: await surge.updateRule(req.params.businessId, req.params.ruleId, req.body) })),
);
router.delete(
  '/surge/rules/:ruleId',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await surge.deleteRule(req.params.businessId, req.params.ruleId))),
);

// ── KDS (Kitchen Display System) ─────────────────────────────────────────
router.get('/kds/:stationId/poll', asyncHandler(async (req, res) => res.json({ tickets: await kds.ticketsForStation(req.params.businessId, req.params.stationId, req.query.since) })));
router.put(
  '/kds/tickets/:id/status',
  validate({ body: Joi.object({ status: Joi.string().valid('in_progress', 'done').required() }) }),
  asyncHandler(async (req, res) => res.json({ ticket: await kds.markTicketStatus(req.params.businessId, req.params.id, req.body.status) })),
);
router.post(
  '/kds/heartbeat',
  validate({ body: Joi.object({ stationId: Joi.string().uuid().required(), label: Joi.string().max(80) }) }),
  asyncHandler(async (req, res) => {
    await kds.heartbeat(req.params.businessId, req.body.stationId, req.body.label);
    res.json({ ok: true });
  }),
);

module.exports = router;
