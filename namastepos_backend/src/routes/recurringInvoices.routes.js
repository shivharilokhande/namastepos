// Recurring invoices routes (2026-09-06, round-2 review / CONTRACTS §2).
// Mounted in app.js at /businesses/:businessId/recurring-invoices.
//
// Plan gate: featureGate rule { match: '/recurring-invoices', key:
// 'recurring_invoices' } fires before this router (registry enforcement:
// 'route'), so a Growth tenant gets 402 FEATURE_LOCKED on every path here.
// Staff gate: these are statutory tax documents, so the same `tax_invoices`
// permission that guards /tax-invoices applies (owner always passes).

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth, requireBusinessOwnership, requireNotImpersonating } = require('../middleware/auth');
const requireStaffPerm = require('../middleware/requireStaffPerm');
const idempotent = require('../middleware/idempotent');
const svc = require('../services/recurringInvoiceService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership, requireStaffPerm('tax_invoices'));

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('must be YYYY-MM-DD');
const itemSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200)
    .required(),
  hsn: Joi.string().trim().max(8).allow('', null),
  qty: Joi.number().positive().max(100000).required(),
  unitPricePaise: Joi.number().integer().min(0).max(1_000_000_000)
    .required(),
  // GST slabs in force: 0 / 5 / 12 / 18 / 28 (and the 3 / 0.25 goods slabs).
  gstPct: Joi.number().min(0).max(28).required(),
});
const common = {
  name: Joi.string().trim().max(120).allow('', null),
  customerId: Joi.string().uuid(),
  frequency: Joi.string().valid(...svc.FREQUENCIES),
  startDate: DATE,
  endDate: DATE.allow(null, ''),
  items: Joi.array().items(itemSchema).min(1).max(100),
  notes: Joi.string().max(2000).allow('', null),
  recipientGstin: Joi.string().trim().length(15).allow('', null),
  recipientAddress: Joi.string().max(1000).allow('', null),
};
const createBody = Joi.object({
  ...common,
  customerId: common.customerId.required(),
  frequency: common.frequency.required(),
  startDate: DATE.required(),
  items: common.items.required(),
});
const patchBody = Joi.object({ ...common, isActive: Joi.boolean() }).min(1);
const idParams = Joi.object({
  businessId: Joi.string().uuid().required(),
  id: Joi.string().uuid().required(),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json({ schedules: await svc.list(req.params.businessId) });
}));

router.post(
  '/',
  requireNotImpersonating,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ schedule: await svc.create(req.params.businessId, req.body) });
  }),
);

router.get('/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json({ schedule: await svc.getById(req.params.businessId, req.params.id) });
}));

router.patch(
  '/:id',
  requireNotImpersonating,
  validate({ params: idParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    res.json({ schedule: await svc.update(req.params.businessId, req.params.id, req.body) });
  }),
);

router.delete(
  '/:id',
  requireNotImpersonating,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await svc.remove(req.params.businessId, req.params.id);
    res.status(204).end();
  }),
);

// run-now mints a statutory invoice and advances the schedule. The service is
// already idempotent per period; the Idempotency-Key gate replays the exact
// response for a retried double-tap instead of billing the FOLLOWING period.
router.post(
  '/:id/run-now',
  requireNotImpersonating,
  validate({ params: idParams }),
  idempotent('POST /recurring-invoices/:id/run-now'),
  asyncHandler(async (req, res) => {
    const out = await svc.runNow(req.params.businessId, req.params.id, { userId: req.user?.id || null });
    res.json(out);
  }),
);

module.exports = router;
