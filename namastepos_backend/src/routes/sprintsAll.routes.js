// Aggregate routes for Sprints 2-10. Mounted under /v1/businesses/:businessId.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const {
  requireAuth, requireBusinessOwnership, requireRole, requireNotImpersonating,
} = require('../middleware/auth');

const aggregator = require('../services/aggregatorService');
const dailyClosing = require('../services/dailyClosingService');
const wastage = require('../services/wastageService');
const reservation = require('../services/reservationService');
const discountApproval = require('../services/discountApprovalService');
const customerHistory = require('../services/customerHistoryService');
const membership = require('../services/membershipService');
const printer = require('../services/printerService');
const driver = require('../services/driverService');
const accountingExport = require('../services/accountingExportService');
const multiOutlet = require('../services/multiOutletService');
const site = require('../services/siteService');
const retail = require('../services/retailService');
const whatsapp = require('../services/whatsappService');
const actionCenter = require('../services/actionCenterService');
const leakage = require('../services/revenueLeakageService');
const giftCard = require('../services/giftCardService');
const nps = require('../services/npsService');
const menuEng = require('../services/menuEngineeringService');
const eway = require('../services/ewayBillService');
const gstr = require('../services/gstrExportService');
const featureFlags = require('../services/featureFlagsService');
const push = require('../services/pushService');
const zones = require('../services/deliveryZoneService');
const shifts = require('../services/staffShiftService');
const referral = require('../services/referralService');
const promo = require('../services/promoRulesService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── Partial refund from an order (FF-304) ──────────────────────────────
const refundSvc = require('../services/refundService');
const auditSvc = require('../services/auditService');
router.post('/orders/:orderId/refund',
  requireRole(['business_owner']),
  requireNotImpersonating,
  validate({ body: Joi.object({
    itemIds:  Joi.array().items(Joi.string().uuid()).default([]),
    // 2026-08-23 — partial-qty item refunds ("1 of the 2 chai"):
    // [{id, qty}]. Server recomputes value from order_items prices.
    items: Joi.array().items(Joi.object({
      id: Joi.string().uuid().required(),
      qty: Joi.number().positive().required(),
    })).default([]),
    amountInr: Joi.number().positive().precision(2),
    reason:   Joi.string().max(500).allow('', null),
  }).or('itemIds', 'items', 'amountInr') }),
  auditSvc.tenantMiddlewareLog('refunds', 'refund_order',
    (req) => ({ type: 'order', id: req.params.orderId })),
  asyncHandler(async (req, res) =>
    res.json(await refundSvc.refundOrder({
      businessId: req.params.businessId,
      orderId:    req.params.orderId,
      itemIds:    req.body.itemIds || [],
      items:      req.body.items || [],
      amountInr:  req.body.amountInr,
      reason:     req.body.reason,
      ownerId:    req.user.id,
    }))));

// ── Owner-facing refunds list (2026-08-23) ─────────────────────────────
// The owner could initiate refunds from the app / dashboard Orders screen,
// but there was no place on their OWN dashboard to SEE the refund history —
// refunds were only visible on the platform admin panel (which lists every
// tenant). This scoped route backs a Refunds page on the owner dashboard.
router.get('/refunds',
  requireRole(['business_owner', 'staff_manager']),
  validate({ query: Joi.object({
    status: Joi.string().valid('pending', 'processed', 'failed', 'cancelled'),
    limit:  Joi.number().integer().min(1).max(200).default(100), // S12: capped
  }) }),
  asyncHandler(async (req, res) =>
    res.json({ refunds: await refundSvc.list({
      businessId: req.params.businessId,   // always scoped to the caller's tenant
      status:     req.query.status,
      limit:      req.query.limit,
    }) })));

// ── Action Center (FF-244) ─────────────────────────────────────────────
router.get('/action-center',
  asyncHandler(async (req, res) =>
    res.json(await actionCenter.fetch(req.params.businessId))));

// ── FF-1005 Gift cards + wallet ────────────────────────────────────────
router.get('/gift-cards',
  asyncHandler(async (req, res) =>
    res.json({ cards: await giftCard.listGiftCards(req.params.businessId) })));
router.post('/gift-cards',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    faceValueInr: Joi.number().positive().precision(2).required(),
    issuedToPhone: Joi.string().max(20).allow('', null),
    expiresAt: Joi.date().iso().allow(null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json(await giftCard.issueGiftCard(req.params.businessId, {
      ...req.body, issuedByUserId: req.user.id,
    }))));
router.get('/gift-cards/lookup/:code',
  asyncHandler(async (req, res) => {
    const gc = await giftCard.findGiftCardByCode(req.params.businessId, req.params.code);
    res.json({ card: gc ? { code: gc.code, balance: gc.balance_paise / 100, expiresAt: gc.expires_at } : null });
  }));
router.post('/customers/:customerId/wallet/topup',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    amountInr: Joi.number().positive().precision(2).required(),
    note: Joi.string().max(500).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.json(await giftCard.topUpWallet(
      req.params.businessId, req.params.customerId,
      req.body.amountInr, req.body.note))));
// 2026-08-25 (founder, wallet-as-tender): read API for the customer wallet
// card — balance + last 50 ledger movements (topups, order payments,
// shortfall debts, membership refunds). Ungated like the gift-card list
// above; any authenticated staff member settling a bill needs to see the
// balance before offering "pay by wallet".
router.get('/customers/:customerId/wallet',
  asyncHandler(async (req, res) =>
    res.json(await giftCard.getWallet(
      req.params.businessId, req.params.customerId))));

// ── FF-1002 NPS ─────────────────────────────────────────────────────────
router.get('/reports/nps',
  asyncHandler(async (req, res) =>
    res.json(await nps.summary(req.params.businessId,
      parseInt(req.query.days, 10) || 30))));

// ── FF-1106 Menu engineering ────────────────────────────────────────────
router.get('/reports/menu-engineering',
  asyncHandler(async (req, res) =>
    res.json(await menuEng.classify(req.params.businessId,
      req.query.from, req.query.to))));

// ── FF-1103 E-way bill ──────────────────────────────────────────────────
router.get('/eway-bills',
  asyncHandler(async (req, res) =>
    res.json({ bills: await eway.list(req.params.businessId) })));
router.post('/eway-bills',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    taxInvoiceId: Joi.string().uuid().allow(null),
    fromPincode: Joi.string().length(6).required(),
    toPincode:   Joi.string().length(6).required(),
    fromState: Joi.string().max(50).required(),
    toState:   Joi.string().max(50).required(),
    distanceKm: Joi.number().integer().min(1).max(4000).allow(null),
    vehicleNo: Joi.string().max(20).allow('', null),
    transporterId: Joi.string().max(30).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json(await eway.generate(req.params.businessId, req.body))));
router.post('/eway-bills/:id/cancel',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) =>
    res.json(await eway.cancel(req.params.businessId, req.params.id, req.body.reason))));

// ── FF-314 GSTR-1 / GSTR-3B CSV ─────────────────────────────────────────
router.get('/reports/gstr1.csv',
  asyncHandler(async (req, res) => {
    const csv = await gstr.gstr1(req.params.businessId, req.query.from, req.query.to);
    res.type('text/csv').attachment(`gstr1-${req.query.from}-to-${req.query.to}.csv`).send(csv);
  }));
router.get('/reports/gstr3b.csv',
  asyncHandler(async (req, res) => {
    const csv = await gstr.gstr3b(req.params.businessId, req.query.from, req.query.to);
    res.type('text/csv').attachment(`gstr3b-${req.query.from}-to-${req.query.to}.csv`).send(csv);
  }));

// ── FF-330 device tokens (mobile registers on cold start) ──────────────
router.post('/device-tokens',
  validate({ body: Joi.object({
    token: Joi.string().required(),
    platform: Joi.string().valid('android', 'ios', 'web').default('android'),
  })}),
  asyncHandler(async (req, res) => {
    await push.registerToken(req.user.id, req.params.businessId, req.body);
    res.json({ ok: true });
  }));

// ── FF-331 delivery zones ──────────────────────────────────────────────
router.get('/delivery-zones',
  asyncHandler(async (req, res) =>
    res.json({ zones: await zones.list(req.params.businessId) })));
router.put('/delivery-zones',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    id: Joi.string().uuid(),
    name: Joi.string().max(80).required(),
    feeInr: Joi.number().min(0).precision(2).default(0),
    minOrderInr: Joi.number().min(0).precision(2).default(0),
    pincodes: Joi.array().items(Joi.string().length(6)).default([]),
    displayOrder: Joi.number().integer().default(100),
  })}),
  asyncHandler(async (req, res) =>
    res.json(await zones.upsert(req.params.businessId, req.body))));
router.delete('/delivery-zones/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await zones.remove(req.params.businessId, req.params.id);
    res.json({ ok: true });
  }));

// ── FF-332 staff shifts + payroll ──────────────────────────────────────
router.post('/shifts/clock-in',
  asyncHandler(async (req, res) =>
    res.json(await shifts.clockIn(req.params.businessId, req.user.id))));
router.post('/shifts/clock-out',
  asyncHandler(async (req, res) =>
    res.json(await shifts.clockOut(req.params.businessId, req.user.id))));
router.get('/shifts/mine',
  asyncHandler(async (req, res) =>
    res.json({ shift: await shifts.myOpenShift(req.params.businessId, req.user.id) })));
router.get('/shifts',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) =>
    res.json({ shifts: await shifts.listForBusiness(
      req.params.businessId, req.query
    )})));
router.get('/shifts/payroll.csv',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    const csv = await shifts.payrollCsv(req.params.businessId, req.query.month);
    res.type('text/csv').attachment(`payroll-${req.query.month}.csv`).send(csv);
  }));

// ── FF-333 referral ────────────────────────────────────────────────────
router.get('/referral',
  asyncHandler(async (req, res) => {
    const code = await referral.myCode(req.params.businessId);
    const stats = await referral.stats(req.params.businessId);
    res.json({ code, stats });
  }));

// ── FF-329 promo evaluation ────────────────────────────────────────────
router.post('/promo/evaluate',
  validate({ body: Joi.object({
    code: Joi.string().required(),
    customerId: Joi.string().uuid().allow(null),
    orderSubtotalInr: Joi.number().min(0).required(),
  })}),
  asyncHandler(async (req, res) =>
    res.json(await promo.evaluate({ ...req.body, businessId: req.params.businessId }))));

// ── FF-315 Feature-flag overrides (owner-scoped read; write is admin-only elsewhere) ──
router.get('/feature-overrides',
  asyncHandler(async (req, res) =>
    res.json({ overrides: await featureFlags.list(req.params.businessId) })));

// ── Revenue leakage (FF-246) ───────────────────────────────────────────
router.get('/reports/leakage',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) =>
    res.json(await leakage.summary(
      req.params.businessId,
      req.query.from, req.query.to,
    ))));

// ── Aggregator credentials + mapping ─────────────────────────────────────
router.get ('/aggregators',                          asyncHandler(async (req, res) =>
  res.json({ credentials: await aggregator.listCredentials(req.params.businessId) })));
router.put ('/aggregators',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato','swiggy','dunzo','magicpin').required(),
    outletId: Joi.string().max(100).allow('', null),
    apiKey: Joi.string().allow('', null),
    webhookSecret: Joi.string().allow('', null),
    autoAccept: Joi.boolean().default(false),
  })}),
  asyncHandler(async (req, res) => res.json({ credentials: await aggregator.upsertCredentials(req.params.businessId, req.body) }))
);
router.get ('/aggregators/mapping-issues',           asyncHandler(async (req, res) =>
  res.json({ issues: await aggregator.listMappingIssues(req.params.businessId) })));
router.post('/aggregators/menu-items/:itemId/sku',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato','swiggy','dunzo','magicpin').required(),
    sku: Joi.string().max(80).required(),
  })}),
  asyncHandler(async (req, res) => {
    await aggregator.setExternalSku(req.params.businessId, req.params.itemId, req.body.provider, req.body.sku);
    res.json({ success: true });
  })
);

// ── Aggregator OTP-based merchant linking (2026-08-22) ───────────────────
// UX: owner picks Zomato/Swiggy → enters their merchant-linked phone →
// receives OTP → enters OTP → link created. See aggregatorLinkService.js
// for the full design + Partner-API vs reverse-engineered discussion.
const aggregatorLink = require('../services/aggregatorLinkService');
router.post('/aggregators/link/start',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato', 'swiggy').required(),
    phone: Joi.string().max(20).required(),
  })}),
  asyncHandler(async (req, res) => {
    const out = await aggregatorLink.startLink({
      businessId: req.params.businessId,
      provider: req.body.provider,
      phone: req.body.phone,
    });
    res.json(out);
  }),
);
router.post('/aggregators/link/verify',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    sessionId: Joi.string().uuid().required(),
    code: Joi.string().length(6).pattern(/^\d+$/).required(),
  })}),
  asyncHandler(async (req, res) => {
    const out = await aggregatorLink.verifyLink({
      businessId: req.params.businessId,
      sessionId: req.body.sessionId,
      code: req.body.code,
    });
    res.json(out);
  }),
);
router.get('/aggregators/link/sessions',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    const sessions = await aggregatorLink.listSessions(req.params.businessId);
    res.json({ sessions });
  }),
);

// ── Daily closing / Z-report ─────────────────────────────────────────────
router.get ('/daily-closings/preview',
  asyncHandler(async (req, res) =>
    res.json({ preview: await dailyClosing.preview(req.params.businessId, req.query.date) })
  )
);
router.get ('/daily-closings', asyncHandler(async (req, res) =>
  res.json({ closings: await dailyClosing.list(req.params.businessId) })));
router.post('/daily-closings',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    date: Joi.date().iso().required(),
    cashCounted: Joi.number().integer().min(0).required(),
    notes: Joi.string().max(2000).allow('', null),
    signature: Joi.string().max(255).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ closing: await dailyClosing.close(req.params.businessId, {
      ...req.body, closedByUserId: req.user?.id,
    })})
  )
);
router.post('/daily-closings/:date/reopen',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await dailyClosing.reopen(req.params.businessId, req.params.date);
    res.json({ success: true });
  })
);

// ── Wastage ──────────────────────────────────────────────────────────────
router.get ('/wastage', asyncHandler(async (req, res) =>
  res.json({ report: await wastage.report(req.params.businessId, req.query) })));
router.post('/wastage',
  // 2026-08-25 (founder): dish wastage — "prepared 20 plates, sold 17" →
  // log the 3 unsold plates against the MENU ITEM. Either ingredientId or
  // menuItemId must be set (service enforces; Joi can't cleanly express
  // "at least one non-null" with allow(null)). New reason 'extra_prepared'
  // for exactly that case. costPaise is optional for dishes — the service
  // values plates at recipe cost when omitted.
  validate({ body: Joi.object({
    ingredientId: Joi.string().uuid().allow(null),
    menuItemId: Joi.string().uuid().allow(null),
    qty: Joi.number().positive().required(),
    unit: Joi.string().max(20).allow('', null),
    costPaise: Joi.number().integer().min(0),
    reason: Joi.string().valid('expired','spilled','over_prep','extra_prepared','damaged','other').required(),
    note: Joi.string().max(500).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ entry: await wastage.log(req.params.businessId, req.body, req.user?.id) })
  )
);

// ── Reservations + wait list ─────────────────────────────────────────────
router.get ('/reservations', asyncHandler(async (req, res) =>
  res.json({ reservations: await reservation.list(req.params.businessId, req.query) })));
router.post('/reservations',
  validate({ body: Joi.object({
    customerName: Joi.string().min(1).max(255).required(),
    customerPhone: Joi.string().min(7).max(20).required(),
    customerEmail: Joi.string().email().allow('', null),
    partySize: Joi.number().integer().min(1).max(50).required(),
    // Founder bug #11 (2026-08-25): reservations could be booked in the
    // past or years ahead. Enforced via .custom() so "now" is computed at
    // REQUEST time — a module-load-time `new Date()` would freeze the
    // boundary at server boot and rot as the process stays up.
    reservedAt: Joi.date().iso().required().custom((value, helpers) => {
      const now = Date.now();
      const t = value.getTime();
      if (t < now) {
        return helpers.message('Reservation time must be in the future');
      }
      if (t > now + 90 * 24 * 60 * 60 * 1000) {
        return helpers.message('Reservations can be made at most 90 days ahead');
      }
      return value;
    }),
    durationMin: Joi.number().integer().min(15).max(360).default(90),
    tableId: Joi.string().uuid().allow(null),
    specialRequests: Joi.string().max(1000).allow('', null),
    source: Joi.string().max(40).default('phone'),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ reservation: await reservation.create(req.params.businessId, req.body, req.user?.id) })
  )
);
router.put ('/reservations/:id', asyncHandler(async (req, res) =>
  res.json({ reservation: await reservation.update(req.params.businessId, req.params.id, req.body) })));
router.post('/reservations/:id/seat', asyncHandler(async (req, res) =>
  res.json({ reservation: await reservation.seat(req.params.businessId, req.params.id) })));
router.get ('/wait-list', asyncHandler(async (req, res) =>
  res.json({ entries: await reservation.listWaitList(req.params.businessId) })));
router.post('/wait-list',
  validate({ body: Joi.object({
    customerName: Joi.string().required(), customerPhone: Joi.string().required(),
    partySize: Joi.number().integer().positive().required(),
    estimatedWaitMin: Joi.number().integer().min(0),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ entry: await reservation.addToWaitList(req.params.businessId, req.body) })
  )
);

// ── Discount approvals ──────────────────────────────────────────────────
router.get ('/discount-approvals',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.json({ approvals: await discountApproval.listApprovals(req.params.businessId) })
  )
);
router.post('/discount-approvals',
  validate({ body: Joi.object({
    orderId: Joi.string().uuid().allow(null),
    managerUserId: Joi.string().uuid().required(),
    managerPin: Joi.string().min(4).max(20).required(),
    amountInr: Joi.number().positive().required(),
    reason: Joi.string().max(500).allow('', null),
  })}),
  asyncHandler(async (req, res) => {
    await discountApproval.verifyManagerPin(req.params.businessId, req.body.managerUserId, req.body.managerPin);
    const approval = await discountApproval.logApproval(req.params.businessId, {
      orderId: req.body.orderId, managerUserId: req.body.managerUserId,
      amountPaise: Math.round(req.body.amountInr * 100), reason: req.body.reason,
    });
    res.status(201).json({ approval });
  })
);
router.put ('/discount-approvals/threshold',
  requireRole(['business_owner']),
  validate({ body: Joi.object({ inr: Joi.number().integer().min(0).max(100000).required() })}),
  asyncHandler(async (req, res) => {
    await discountApproval.setThreshold(req.params.businessId, req.body.inr);
    res.json({ success: true });
  })
);
router.post('/me/discount-pin',
  validate({ body: Joi.object({ pin: Joi.string().min(4).max(20).required() })}),
  asyncHandler(async (req, res) => {
    await discountApproval.setMyPin(req.params.businessId, req.user.id, req.body.pin);
    res.json({ success: true });
  })
);

// ── Customer history ─────────────────────────────────────────────────────
router.get ('/customer-history/:phone', asyncHandler(async (req, res) => {
  const profile = await customerHistory.profileForCashier(req.params.businessId, req.params.phone);
  if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(profile);
}));
router.get ('/customers/:id/reorder-last', asyncHandler(async (req, res) => {
  const items = await customerHistory.reorderSameAsLast(req.params.businessId, req.params.id);
  res.json({ items });
}));

// ── Membership / gift card / tip ─────────────────────────────────────────
router.get ('/memberships', asyncHandler(async (req, res) =>
  res.json({ memberships: await membership.listMemberships(req.params.businessId) })));
// 2026-08-26: roster of customers who hold a membership (name/phone/plan/
// amount/status/expiry) for the Members list on mobile + web.
router.get ('/memberships/subscribers', asyncHandler(async (req, res) =>
  res.json({ subscribers: await membership.listSubscribers(req.params.businessId) })));
router.post('/memberships',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    name: Joi.string().required(), description: Joi.string().allow('', null),
    priceInr: Joi.number().positive().required(),
    validityDays: Joi.number().integer().min(1).max(3650).default(30),
    benefits: Joi.object().unknown(true).allow(null),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ membership: await membership.createMembership(req.params.businessId, req.body) }))
);
// Membership plan Update + Delete (2026-08-24): screen had create+read only.
router.put('/memberships/:id',
  requireRole(['business_owner']),
  // NB: don't validate params here — mergeParams injects businessId too and
  // the strict validator rejects unknown keys. The :id is used in a
  // business-scoped query, so a bad/foreign id simply 404s.
  validate({
    body: Joi.object({
      name: Joi.string(), description: Joi.string().allow('', null),
      priceInr: Joi.number().positive(),
      validityDays: Joi.number().integer().min(1).max(3650),
      benefits: Joi.object().unknown(true).allow(null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ membership: await membership.updateMembership(req.params.businessId, req.params.id, req.body) }))
);
router.delete('/memberships/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await membership.deleteMembership(req.params.businessId, req.params.id)))
);
router.post('/memberships/subscribe',
  validate({ body: Joi.object({
    customerId: Joi.string().uuid().required(),
    membershipId: Joi.string().uuid().required(),
    // 2026-08-25 (founder): membership sell is a real payment now —
    // 'wallet' debits the customer wallet atomically with the sale, and an
    // optional paymentBreakdown splits the plan price across 1-3 tenders
    // (service enforces legs sum = plan price ±₹0.01, else 400).
    paymentMethod: Joi.string().valid('cash','upi','card','online','wallet').default('cash'),
    paymentBreakdown: Joi.array().items(Joi.object({
      method: Joi.string().valid('cash','upi','card','online','wallet').required(),
      amountInr: Joi.number().positive().required(),
    })).min(1).max(3).allow(null),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ subscription: await membership.subscribe(req.params.businessId, req.body) }))
);
// 2026-08-25 (founder): cancel a sold membership → refund the unused share.
// Remaining value = price paid × (remaining bundle qty ÷ original bundle
// qty) — time-prorated for plans without an item bundle — minus the
// cancellation charge (cancellationPct, default 10). mode 'wallet' credits
// the customer wallet (ledger reason 'membership_refund'); 'cash'/'upi'
// records a payout in `refunds` so the income statement can net it off as
// 'Membership refunds'. Owner/manager only — refunds move money.
router.post('/customer-memberships/:id/cancel',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    mode: Joi.string().valid('wallet', 'cash', 'upi').required(),
    cancellationPct: Joi.number().min(0).max(100).allow(null),
  })}),
  asyncHandler(async (req, res) => res.json(
    await membership.cancelSubscription(
      req.params.businessId, req.params.id, {
        mode: req.body.mode,
        cancellationPct: req.body.cancellationPct ?? null,
      })))
);
// SECURITY FIX (2026-08-23, review H1): these membership.* gift-card /
// wallet variants formed a SECOND ledger on the same gift_cards table
// (remaining_paise + wallet_transactions) parallel to the canonical
// FF-1005 giftCardService routes (balance_paise + wallet_ledger).
// Redeeming through one path never debited the other's column —
// a double-spend. Disabled (410) rather than deleted; the canonical
// /gift-cards and /gift-cards/:code/redeem routes at the top of this
// file are the single authority now.
const goneDualLedger = (_req, res) => res.status(410).json({
  error: 'GONE',
  message: 'This endpoint was retired — use /gift-cards (canonical ledger).',
});
router.get ('/memberships/gift-cards', goneDualLedger);
router.post('/memberships/gift-cards', goneDualLedger);
router.post('/memberships/gift-cards/:code/redeem', goneDualLedger);
router.post('/wallet/:customerId/topup', goneDualLedger);
router.post('/tips',
  validate({ body: Joi.object({
    orderId: Joi.string().uuid().allow(null),
    serverUserId: Joi.string().uuid().allow(null),
    amountInr: Joi.number().positive().required(),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ tip: await membership.recordTip(req.params.businessId, req.body) }))
);
router.get ('/tips/report', asyncHandler(async (req, res) =>
  res.json({ report: await membership.tipReport(req.params.businessId, req.query) })));

// ── Printer + KDS ────────────────────────────────────────────────────────
router.get ('/printers', asyncHandler(async (req, res) =>
  res.json({ printers: await printer.listPrinters(req.params.businessId) })));
router.put ('/printers',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    id: Joi.string().uuid().allow(null),
    name: Joi.string().required(),
    kind: Joi.string().valid('bill','kot').required(),
    connection: Joi.string().valid('bluetooth','wifi','usb','network').required(),
    address: Joi.string().max(120).allow('', null),
    paperWidthMm: Joi.number().valid(58, 80),
    stationId: Joi.string().uuid().allow(null),
    isDefault: Joi.boolean(),
  })}),
  asyncHandler(async (req, res) =>
    res.json({ printer: await printer.upsertPrinter(req.params.businessId, req.body) })
  )
);
router.delete('/printers/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await printer.deletePrinter(req.params.businessId, req.params.id);
    res.json({ success: true });
  })
);
router.get ('/print-jobs/next', asyncHandler(async (req, res) =>
  res.json({ job: await printer.dequeueNext(req.params.businessId) })));
router.post('/print-jobs/:id/done',
  validate({ body: Joi.object({ ok: Joi.boolean().required(), errorMessage: Joi.string().allow('', null) })}),
  asyncHandler(async (req, res) => {
    await printer.markJobDone(req.params.businessId, req.params.id, req.body.ok, req.body.errorMessage);
    res.json({ success: true });
  })
);

// ── Drivers ──────────────────────────────────────────────────────────────
// Sync-fix (2026-08-22): the following routes previously had no role
// gate — any authenticated user (including kitchen role) could list
// drivers, edit them, ping their location, or assign them to orders.
// Aligned with the driver-management responsibility (owner + manager
// for CRUD; owner + manager + cashier for assign/mark-status because
// the counter staff are the ones who actually dispatch).
router.get ('/drivers',
  // staff_driver added 2026-08-22 — riders pick themselves in the app.
  requireRole(['business_owner','staff_manager','staff_cashier','staff_driver']),
  asyncHandler(async (req, res) =>
    res.json({ drivers: await driver.list(req.params.businessId) })));
router.post('/drivers',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(), phone: Joi.string().required(),
    vehicleNo: Joi.string().allow('', null), vehicleType: Joi.string().valid('bike','scooter','car','cycle','other'),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ driver: await driver.create(req.params.businessId, req.body) }))
);
router.put ('/drivers/:id',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.json({ driver: await driver.update(req.params.businessId, req.params.id, req.body) })));
router.post('/drivers/:id/ping',
  // Ping is called by the driver's own app — the driver is authenticated
  // as their own user. Allow all roles so both the driver's PIN-login
  // session and the manager (for admin overrides) can call it.
  validate({ body: Joi.object({ lat: Joi.number().required(), lng: Joi.number().required() })}),
  asyncHandler(async (req, res) => {
    await driver.ping(req.params.businessId, req.params.id, req.body);
    res.json({ success: true });
  })
);
router.post('/orders/:orderId/assign-driver',
  requireRole(['business_owner','staff_manager','staff_cashier']),
  validate({ body: Joi.object({
    driverId: Joi.string().uuid().required(),
    address: Joi.string().allow('', null),
    lat: Joi.number().allow(null), lng: Joi.number().allow(null),
    distanceKm: Joi.number().allow(null),
    deliveryFeePaise: Joi.number().integer().min(0).default(0),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ assignment: await driver.assignOrder(req.params.businessId, req.params.orderId, req.body.driverId, req.body) })
  )
);
router.put ('/delivery-assignments/:id/status',
  // staff_driver added 2026-08-22 — riders mark picked-up/delivered.
  requireRole(['business_owner','staff_manager','staff_cashier','staff_driver']),
  validate({ body: Joi.object({ status: Joi.string().valid('assigned','picked_up','delivered','failed').required() })}),
  asyncHandler(async (req, res) =>
    res.json({ assignment: await driver.markStatus(req.params.businessId, req.params.id, req.body.status) })
  )
);
router.get ('/delivery-assignments/live',
  // staff_driver added 2026-08-22 — riders see their own job queue.
  requireRole(['business_owner','staff_manager','staff_cashier','staff_driver']),
  asyncHandler(async (req, res) =>
    res.json({ assignments: await driver.liveAssignments(req.params.businessId) })));

// ── Accounting export + e-invoice ────────────────────────────────────────
router.post('/exports/tally',
  validate({ body: Joi.object({ startDate: Joi.date().iso().required(), endDate: Joi.date().iso().required() })}),
  asyncHandler(async (req, res) => {
    const r = await accountingExport.tallyExport(req.params.businessId, req.body);
    res.set('Content-Type', 'application/xml').send(r.xml);
  })
);
router.post('/exports/zoho',
  validate({ body: Joi.object({ startDate: Joi.date().iso().required(), endDate: Joi.date().iso().required() })}),
  asyncHandler(async (req, res) => {
    const csv = await accountingExport.zohoCsv(req.params.businessId, req.body);
    res.set('Content-Type', 'text/csv').send(csv);
  })
);
router.get ('/exports', asyncHandler(async (req, res) =>
  res.json({ exports: await accountingExport.listExports(req.params.businessId) })));
// WHY (2026-08-25): the POST below stores the IRN in einvoice_irns but
// nothing ever read it back — the founder saw "IRN generated · 580ce2…"
// and the IRN then vanished. Read-only list (same ungated GET shape as
// /exports above) so Orders + Tax Invoices pages can badge e-invoiced rows.
router.get ('/einvoice', asyncHandler(async (req, res) =>
  res.json({ irns: await accountingExport.listIrns(req.params.businessId) })));
router.post('/einvoice/:orderId',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ irn: await accountingExport.generateIrn(req.params.businessId, req.params.orderId) })
  )
);
// FF-402 code-review pass — namespaced under `/accounting/` to avoid
// colliding with FF-1103 `/eway-bills` above (which uses the dedicated
// `eway` service with a different validator). This variant is the
// accounting-export flavour used by the Tally / GSTR pipeline.
router.post('/accounting/eway-bills',
  validate({ body: Joi.object({
    invoiceId: Joi.string().uuid().required(),
    vehicleNo: Joi.string().required(),
    distanceKm: Joi.number().integer().min(0).required(),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ ewayBill: await accountingExport.generateEwayBill(req.params.businessId, req.body.invoiceId, req.body) })
  )
);

// ── Site (online ordering brand site) ───────────────────────────────────
router.get ('/site', asyncHandler(async (req, res) =>
  res.json({ site: await site.get(req.params.businessId) })));
router.put ('/site',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    brandSlug: Joi.string().lowercase().pattern(/^[a-z0-9-]{2,60}$/).allow('', null),
    heroImageUrl: Joi.string().uri().allow('', null),
    primaryColor: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null),
    brandStory: Joi.string().max(2000).allow('', null),
    contactEmail: Joi.string().email().allow('', null),
    contactPhone: Joi.string().max(20).allow('', null),
    address: Joi.string().max(500).allow('', null),
    deliveryRadiusKm: Joi.number().min(0).max(100),
    minOrderInr: Joi.number().min(0),
    deliveryFeeInr: Joi.number().min(0),
    isPublished: Joi.boolean(),
  })}),
  asyncHandler(async (req, res) =>
    res.json({ site: await site.update(req.params.businessId, req.body) })
  )
);

// ── WhatsApp campaigns ──────────────────────────────────────────────────
router.get ('/wa/campaigns', asyncHandler(async (req, res) =>
  res.json({ campaigns: await whatsapp.listCampaigns(req.params.businessId) })));
router.post('/wa/campaigns',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(),
    templateBody: Joi.string().required(),
    audienceFilter: Joi.object().unknown(true).allow(null),
    scheduledAt: Joi.date().iso().allow(null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ campaign: await whatsapp.createCampaign(req.params.businessId, req.body, req.user?.id) })
  )
);
router.post('/wa/campaigns/:id/run',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) =>
    res.json(await whatsapp.runCampaign(req.params.businessId, req.params.id))
  )
);

// ── Retail (mounted under same business path) ───────────────────────────
router.get ('/retail/items', asyncHandler(async (req, res) =>
  res.json({ items: await retail.listItems(req.params.businessId, req.query) })));
router.post('/retail/items',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(), category: Joi.string().allow('', null),
    unit: Joi.string().default('piece'), hsnCode: Joi.string().allow('', null),
    gstPct: Joi.number().valid(0, 5, 12, 18, 28).default(18),
    mrpPaise: Joi.number().integer().allow(null),
    priceInr: Joi.number().required(),
    costPaise: Joi.number().integer().allow(null),
    stock: Joi.number().default(0),
    reorderLevel: Joi.number().default(0),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ item: await retail.createItem(req.params.businessId, req.body) })
  )
);
router.post('/retail/items/:id/barcodes',
  validate({ body: Joi.object({ barcode: Joi.string().required(), isPrimary: Joi.boolean().default(false) })}),
  asyncHandler(async (req, res) => {
    await retail.addBarcode(req.params.businessId, req.params.id, req.body.barcode, req.body.isPrimary);
    res.status(201).json({ success: true });
  })
);
router.get ('/retail/barcode/:barcode', asyncHandler(async (req, res) => {
  const it = await retail.findByBarcode(req.params.businessId, req.params.barcode);
  if (!it) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ item: it });
}));
router.post('/retail/bulk-import',
  requireRole(['business_owner']),
  validate({ body: Joi.object({ rows: Joi.array().items(Joi.object().unknown(true)).max(1000).required() })}),
  asyncHandler(async (req, res) =>
    res.json(await retail.bulkImport(req.params.businessId, req.body.rows))
  )
);
router.get ('/retail/vendors', asyncHandler(async (req, res) =>
  res.json({ vendors: await retail.listVendors(req.params.businessId) })));
router.post('/retail/vendors',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ vendor: await retail.createVendor(req.params.businessId, req.body) })
  )
);
router.post('/retail/purchase-orders',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ po: await retail.createPO(req.params.businessId, req.body, req.user?.id) })
  )
);
router.post('/retail/purchase-orders/:poId/receive',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ grn: await retail.receivePO(req.params.businessId, req.params.poId, req.body, req.user?.id) })
  )
);
router.post('/retail/ledger',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ entry: await retail.postLedger(req.params.businessId, req.body) })
  )
);
router.get ('/retail/ledger/:partyKind/:partyId', asyncHandler(async (req, res) =>
  res.json({ entries: await retail.partyLedger(req.params.businessId, req.params.partyKind, req.params.partyId) })));
router.post('/retail/cheques',
  asyncHandler(async (req, res) =>
    res.status(201).json({ cheque: await retail.recordCheque(req.params.businessId, req.body) })
  )
);
router.put ('/retail/cheques/:id/status',
  validate({ body: Joi.object({
    status: Joi.string().valid('pending','cleared','bounced','cancelled').required(),
    clearedOn: Joi.date().iso().allow(null),
  })}),
  asyncHandler(async (req, res) =>
    res.json({ cheque: await retail.updateChequeStatus(req.params.businessId, req.params.id, req.body.status, req.body.clearedOn) })
  )
);
router.post('/retail/quotations',
  asyncHandler(async (req, res) =>
    res.status(201).json({ quotation: await retail.createQuotation(req.params.businessId, req.body) })
  )
);
router.post('/retail/warehouses',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ warehouse: await retail.createWarehouse(req.params.businessId, req.body) })
  )
);

// ── Bulk-import hub (Founder request 2026-08-25) ────────────────────────
// CSV imports for ingredients, ingredient purchases, and expenses. The
// dashboard parses the CSV client-side (same minimal parser as the menu
// dialog) and POSTs a JSON `rows` array; each row is re-validated here with
// Joi because these endpoints are also reachable directly via the API.
//
// Path naming is deliberate (2026-08-25): featureGate matches substrings,
// and '/bulk-import' maps to the enterprise-only `bulk_import` key (that
// gate is meant for the retail SKU import). We mount under '/imports/…'
// instead so:
//   /imports/ingredients[…]  → matches the '/ingredients' rule →
//                              recipe_costing (Pro), same plan tier as the
//                              rest of the ingredients module;
//   /imports/expenses        → ungated, like the single-expense routes.
// No new tables — rows land in the existing ingredients /
// ingredient_transactions / expenses tables via the existing services.
const ingredientSvc = require('../services/ingredientService');
const expenseSvc = require('../services/expenseService');

const importRowsBody = Joi.object({
  rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(1000).required(),
});

// Mirrors ingredientController.ingredientBody — keep the two in sync.
const ingredientRowSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  category: Joi.string().max(50).allow('', null),
  unit: Joi.string().valid('g', 'kg', 'ml', 'l', 'piece', 'pack', 'dozen').default('g'),
  stock: Joi.number().min(0).default(0),
  reorderLevel: Joi.number().min(0).default(0),
  costPerUnitInr: Joi.number().min(0).default(0),
  vendor: Joi.string().max(255).allow('', null),
  vendorPhone: Joi.string().max(20).allow('', null),
  notes: Joi.string().max(500).allow('', null),
});

// Mirrors ingredientController.purchaseBody, plus `ingredient` (name lookup —
// CSV authors know names, not UUIDs).
const purchaseRowSchema = Joi.object({
  ingredient: Joi.string().min(1).max(255).required(),
  qty: Joi.number().positive().required(),
  unitCostInr: Joi.number().min(0),
  totalCostInr: Joi.number().min(0),
  vendor: Joi.string().max(255).allow('', null),
  note: Joi.string().max(500).allow('', null),
}).or('unitCostInr', 'totalCostInr');

// Mirrors expenseController.createBody (categories = expense_category enum,
// migrations 001/055/058) — keep in sync when the enum grows.
const expenseRowSchema = Joi.object({
  date: Joi.date().iso().required(),
  category: Joi.string().valid(
    'ingredients', 'fuel', 'labor', 'rent', 'utilities',
    'packaging', 'marketing', 'maintenance',
    'chef_salary', 'helper_salary', 'staff_salary', 'gas', 'electricity',
    'water', 'transport', 'equipment', 'cleaning', 'license_fees',
    'other'
  ).default('other'),
  amount: Joi.number().positive().precision(2).required(),
  description: Joi.string().max(500).allow('', null),
});

/**
 * Runs `handler` for each row, collecting a per-row report. Row numbers are
 * 1-based CSV *file* lines (data starts at line 2, after the header) so the
 * error table matches what the user sees in Excel/Sheets.
 */
async function runImport(rows, schema, handler) {
  let imported = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 2;
    // stripUnknown: CSVs often carry extra columns (totals, remarks) — drop
    // them instead of failing the whole row.
    const { value, error } = schema.validate(rows[i], { stripUnknown: true });
    if (error) { failed.push({ row: rowNo, error: error.message }); continue; }
    try {
      await handler(value);
      imported++;
    } catch (err) {
      // Service errors (Conflict on duplicate name, NotFound, …) become
      // per-row failures — one bad row must not abort the batch.
      failed.push({ row: rowNo, error: err.message || 'Import failed' });
    }
  }
  return { imported, failed };
}

router.post('/imports/ingredients',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, ingredientRowSchema, (row) =>
      ingredientSvc.create(req.params.businessId, row));
    res.json(result);
  })
);

// Purchases = goods received against existing ingredients. Reuses
// recordPurchase so stock + weighted-average cost + the
// ingredient_transactions audit log all update exactly like a manual entry.
// (The retail purchase_orders/goods_receipts tables are a multi-step
// PO→GRN flow scoped to retail SKUs — not a fit for a flat CSV.)
router.post('/imports/ingredients/purchases',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    // One name→id lookup up front instead of a query per row.
    const existing = await ingredientSvc.list(req.params.businessId, { onlyActive: true });
    const byName = new Map(existing.map((i) => [i.name.trim().toLowerCase(), i.id]));
    const result = await runImport(req.body.rows, purchaseRowSchema, async (row) => {
      const id = byName.get(row.ingredient.trim().toLowerCase());
      if (!id) throw new Error(`Ingredient "${row.ingredient}" not found — import it on the Ingredients tab first`);
      const { ingredient: _name, ...purchase } = row;
      await ingredientSvc.recordPurchase(req.params.businessId, id, purchase);
    });
    res.json(result);
  })
);

router.post('/imports/expenses',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, expenseRowSchema, (row) =>
      expenseSvc.create(req.params.businessId, row));
    res.json(result);
  })
);

module.exports = router;
