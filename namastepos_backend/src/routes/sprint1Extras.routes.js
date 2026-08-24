// NamastePOS backend - Sprint 1 routes that didn't fit elsewhere:
//   • modifier groups CRUD (catalog level, not per-item)
//   • cancel-reasons CRUD
//   • bill template (per-tenant)
//   • order reprint
//
// Mounted under /businesses/:businessId from app.js.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const {
  requireAuth, requireBusinessOwnership, requireRole, requireNotImpersonating,
} = require('../middleware/auth');

const variants = require('../services/variantService');
const billTemplate = require('../services/billTemplateService');
const cancelReasons = require('../services/cancelReasonService');
const orders = require('../services/orderService');
const auditService = require('../services/auditService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── Modifier groups (catalog) ────────────────────────────────────────────
router.get('/modifier-groups', asyncHandler(async (req, res) => {
  res.json({ groups: await variants.listGroups(req.params.businessId) });
}));

router.put('/modifier-groups',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    id: Joi.string().uuid().allow(null),
    name: Joi.string().min(1).max(100).required(),
    kind: Joi.string().valid('single_select', 'multi_select').default('single_select'),
    minSelect: Joi.number().integer().min(0).default(0),
    maxSelect: Joi.number().integer().min(0).default(1),
    displayOrder: Joi.number().integer().min(0).default(100),
    isActive: Joi.boolean().default(true),
    modifiers: Joi.array().items(Joi.object({
      id: Joi.string().uuid().allow(null),
      name: Joi.string().min(1).max(100).required(),
      priceDeltaInr: Joi.number().default(0),
      displayOrder: Joi.number().integer().min(0),
    })).default([]),
  })}),
  asyncHandler(async (req, res) => {
    const groups = await variants.upsertGroup(req.params.businessId, req.body);
    res.json({ groups });
  })
);

// ── Cancel-reason picker ─────────────────────────────────────────────────
router.get('/cancel-reasons', asyncHandler(async (req, res) => {
  res.json({ reasons: await cancelReasons.list(req.params.businessId, {
    includeInactive: req.query.all === 'true',
  })});
}));

router.post('/cancel-reasons',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    code: Joi.string().min(1).max(40).required(),
    label: Joi.string().min(1).max(120).required(),
    displayOrder: Joi.number().integer().min(0).default(100),
  })}),
  asyncHandler(async (req, res) => {
    res.status(201).json({ reason: await cancelReasons.create(req.params.businessId, req.body) });
  })
);

router.put('/cancel-reasons/:id',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    label: Joi.string().min(1).max(120),
    displayOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
  })}),
  asyncHandler(async (req, res) => {
    res.json({ reasons: await cancelReasons.update(req.params.businessId, req.params.id, req.body) });
  })
);

// ── Bill template ────────────────────────────────────────────────────────
router.get('/bill-template', asyncHandler(async (req, res) => {
  res.json({ template: await billTemplate.get(req.params.businessId) });
}));

router.put('/bill-template',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    logoUrl: Joi.string().uri().allow('', null),
    headerLines: Joi.array().items(Joi.string().max(200)).max(8),
    gstin: Joi.string().max(15).allow('', null),
    fssaiNo: Joi.string().max(20).allow('', null),
    footerText: Joi.string().max(500).allow('', null),
    showToken: Joi.boolean(),
    showTaxBreakdown: Joi.boolean(),
    paperWidthMm: Joi.number().integer().valid(58, 80),
  })}),
  asyncHandler(async (req, res) => {
    res.json({ template: await billTemplate.update(req.params.businessId, req.body) });
  })
);

// ── Order reprint (FF-305) ───────────────────────────────────────────────
router.post('/orders/:orderId/reprint',
  requireRole(['business_owner', 'staff_manager', 'staff_cashier']),
  requireNotImpersonating,
  asyncHandler(async (req, res) => {
    const r = await orders.markReprint(req.params.businessId, req.params.orderId);
    // Log to audit for fraud monitoring (frequent reprints = possible cash skim)
    try {
      await auditService.log({
        businessId: req.params.businessId,
        actorId: req.user?.id,
        action: 'order.reprint',
        entityType: 'order',
        entityId: req.params.orderId,
        payload: { reprintCount: r.reprint_count },
      });
    } catch (_) {}
    res.json({
      reprintCount: r.reprint_count,
      lastReprintAt: r.last_reprint_at,
    });
  })
);

module.exports = router;
