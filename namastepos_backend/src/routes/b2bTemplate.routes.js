// B2B invoice template routes (2026-09-06, round-2 review D-04 / CONTRACTS §1).
// Mounted in app.js under /businesses/:businessId → /b2b-invoice-template.
//
// Gate: `b2b_invoice` (Pro+) on BOTH view and save — founder decision, not
// `custom_branding`. Staff: any member may view; saving needs the
// `bill_template` permission (the same key that guards the receipt template)
// or the owner.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth, requireBusinessOwnership, requireNotImpersonating } = require('../middleware/auth');
const requireStaffPerm = require('../middleware/requireStaffPerm');
const requireFeature = require('../middleware/requireFeature');
const svc = require('../services/b2bTemplateService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

const putBody = Joi.object({
  letterhead: Joi.string().max(4000).allow('', null),
  terms: Joi.string().max(4000).allow('', null),
  signatureUrl: Joi.string().max(500).allow('', null),
  bankDetails: Joi.string().max(4000).allow('', null),
  showHsn: Joi.boolean(),
  showEway: Joi.boolean(),
});

router.get(
  '/b2b-invoice-template',
  requireFeature('b2b_invoice'),
  asyncHandler(async (req, res) => {
    res.json({ template: await svc.get(req.params.businessId) });
  }),
);

router.put(
  '/b2b-invoice-template',
  requireFeature('b2b_invoice'),
  requireNotImpersonating,
  requireStaffPerm('bill_template'),
  validate({ body: putBody }),
  asyncHandler(async (req, res) => {
    res.json({ template: await svc.put(req.params.businessId, req.body) });
  }),
);

module.exports = router;
