// Payments & money movement — refunds, gift cards + wallet, tips, discount
// approvals, and the retired dual-ledger tombstones.
//
// NP-145 (2026-09-03): split out of sprintsAll.routes.js. Pure move — same
// paths, same middleware order, same handlers. Mounted by sprintsAll.routes.js
// under /v1/businesses/:businessId AFTER requireAuth + requireBusinessOwnership
// — do not mount this router directly.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireRole, requireNotImpersonating } = require('../middleware/auth');

const membership = require('../services/membershipService');
const giftCard = require('../services/giftCardService');
const discountApproval = require('../services/discountApprovalService');

const router = express.Router({ mergeParams: true });

// ── Partial refund from an order (FF-304) ──────────────────────────────
const refundSvc = require('../services/refundService');
const auditSvc = require('../services/auditService');

router.post(
  '/orders/:orderId/refund',
  requireRole(['business_owner']),
  requireNotImpersonating,
  validate({ body: Joi.object({
    itemIds: Joi.array().items(Joi.string().uuid()).default([]),
    // 2026-08-23 — partial-qty item refunds ("1 of the 2 chai"):
    // [{id, qty}]. Server recomputes value from order_items prices.
    items: Joi.array().items(Joi.object({
      id: Joi.string().uuid().required(),
      qty: Joi.number().positive().required(),
    })).default([]),
    amountInr: Joi.number().positive().precision(2),
    reason: Joi.string().max(500).allow('', null),
  }).or('itemIds', 'items', 'amountInr') }),
  auditSvc.tenantMiddlewareLog(
    'refunds',
    'refund_order',
    (req) => ({ type: 'order', id: req.params.orderId }),
  ),
  asyncHandler(async (req, res) => res.json(await refundSvc.refundOrder({
    businessId: req.params.businessId,
    orderId: req.params.orderId,
    itemIds: req.body.itemIds || [],
    items: req.body.items || [],
    amountInr: req.body.amountInr,
    reason: req.body.reason,
    ownerId: req.user.id,
  }))),
);

// ── Owner-facing refunds list (2026-08-23) ─────────────────────────────
// The owner could initiate refunds from the app / dashboard Orders screen,
// but there was no place on their OWN dashboard to SEE the refund history —
// refunds were only visible on the platform admin panel (which lists every
// tenant). This scoped route backs a Refunds page on the owner dashboard.
router.get(
  '/refunds',
  requireRole(['business_owner', 'staff_manager']),
  validate({ query: Joi.object({
    status: Joi.string().valid('pending', 'processed', 'failed', 'cancelled'),
    limit: Joi.number().integer().min(1).max(200)
      .default(100), // S12: capped
  }) }),
  asyncHandler(async (req, res) => res.json({ refunds: await refundSvc.list({
    businessId: req.params.businessId, // always scoped to the caller's tenant
    status: req.query.status,
    limit: req.query.limit,
  }) })),
);

// ── FF-1005 Gift cards + wallet ────────────────────────────────────────
router.get(
  '/gift-cards',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json({ cards: await giftCard.listGiftCards(req.params.businessId) })),
);
router.post(
  '/gift-cards',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    faceValueInr: Joi.number().positive().precision(2).required(),
    issuedToPhone: Joi.string().max(20).allow('', null),
    expiresAt: Joi.date().iso().allow(null),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json(await giftCard.issueGiftCard(req.params.businessId, {
    ...req.body, issuedByUserId: req.user.id,
  }))),
);
router.get(
  '/gift-cards/lookup/:code',
  asyncHandler(async (req, res) => {
    const gc = await giftCard.findGiftCardByCode(req.params.businessId, req.params.code);
    res.json({ card: gc ? { code: gc.code, balance: gc.balance_paise / 100, expiresAt: gc.expires_at } : null });
  }),
);
router.post(
  '/customers/:customerId/wallet/topup',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    amountInr: Joi.number().positive().precision(2).required(),
    note: Joi.string().max(500).allow('', null),
  }) }),
  asyncHandler(async (req, res) => res.json(await giftCard.topUpWallet(
    req.params.businessId,
    req.params.customerId,
    req.body.amountInr,
    req.body.note,
  ))),
);
// 2026-08-25 (founder, wallet-as-tender): read API for the customer wallet
// card — balance + last 50 ledger movements (topups, order payments,
// shortfall debts, membership refunds). Ungated like the gift-card list
// above; any authenticated staff member settling a bill needs to see the
// balance before offering "pay by wallet".
router.get(
  '/customers/:customerId/wallet',
  requireRole(['business_owner', 'staff_manager', 'staff_cashier']),
  asyncHandler(async (req, res) => res.json(await giftCard.getWallet(req.params.businessId, req.params.customerId))),
);

// ── Discount approvals ──────────────────────────────────────────────────
router.get(
  '/discount-approvals',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json({ approvals: await discountApproval.listApprovals(req.params.businessId) })),
);
router.post(
  '/discount-approvals',
  validate({ body: Joi.object({
    orderId: Joi.string().uuid().allow(null),
    managerUserId: Joi.string().uuid().required(),
    managerPin: Joi.string().min(4).max(20).required(),
    amountInr: Joi.number().positive().required(),
    reason: Joi.string().max(500).allow('', null),
  }) }),
  asyncHandler(async (req, res) => {
    await discountApproval.verifyManagerPin(req.params.businessId, req.body.managerUserId, req.body.managerPin);
    const approval = await discountApproval.logApproval(req.params.businessId, {
      orderId: req.body.orderId,
      managerUserId: req.body.managerUserId,
      amountPaise: Math.round(req.body.amountInr * 100),
      reason: req.body.reason,
    });
    res.status(201).json({ approval });
  }),
);
router.put(
  '/discount-approvals/threshold',
  requireRole(['business_owner']),
  validate({ body: Joi.object({ inr: Joi.number().integer().min(0).max(100000)
    .required() }) }),
  asyncHandler(async (req, res) => {
    await discountApproval.setThreshold(req.params.businessId, req.body.inr);
    res.json({ success: true });
  }),
);
router.post(
  '/me/discount-pin',
  validate({ body: Joi.object({ pin: Joi.string().min(4).max(20).required() }) }),
  asyncHandler(async (req, res) => {
    await discountApproval.setMyPin(req.params.businessId, req.user.id, req.body.pin);
    res.json({ success: true });
  }),
);

// SECURITY FIX (2026-08-23, review H1): these membership.* gift-card /
// wallet variants formed a SECOND ledger on the same gift_cards table
// (remaining_paise + wallet_transactions) parallel to the canonical
// FF-1005 giftCardService routes (balance_paise + wallet_ledger).
// Redeeming through one path never debited the other's column —
// a double-spend. Disabled (410) rather than deleted; the canonical
// /gift-cards and /gift-cards/:code/redeem routes at the top of this
// file are the single authority now. Kept as 410 tombstones on purpose:
// fielded mobile builds may still call these paths, and a clear GONE
// message beats a generic 404.
const goneDualLedger = (_req, res) => res.status(410).json({
  error: 'GONE',
  message: 'This endpoint was retired — use /gift-cards (canonical ledger).',
});
router.get('/memberships/gift-cards', requireRole(['business_owner', 'staff_manager']), goneDualLedger);
router.post('/memberships/gift-cards', goneDualLedger);
router.post('/memberships/gift-cards/:code/redeem', goneDualLedger);
router.post('/wallet/:customerId/topup', goneDualLedger);

// ── Tips ─────────────────────────────────────────────────────────────────
router.post(
  '/tips',
  validate({ body: Joi.object({
    orderId: Joi.string().uuid().allow(null),
    serverUserId: Joi.string().uuid().allow(null),
    amountInr: Joi.number().positive().required(),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ tip: await membership.recordTip(req.params.businessId, req.body) })),
);
router.get('/tips/report', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ report: await membership.tipReport(req.params.businessId, req.query) })));

module.exports = router;
