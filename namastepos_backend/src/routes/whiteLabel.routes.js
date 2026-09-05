// NamastePOS backend — white-label settings (round-2 fix batch 2026-09-06, CONTRACTS §4)
//
// Mounted in app.js under the business prefix:
//   app.use(`${env.API_PREFIX}/businesses/:businessId/white-label`, require('./routes/whiteLabel.routes'));
//
//   GET /  → { whiteLabel: { enabled, brandName, hidePoweredBy, accentColor } }
//   PUT /  same body (all fields optional; missing = default) → same response
//
// Owner only, both behind requireFeature('white_label') (402 FEATURE_LOCKED on
// a plan without it). Saving is the SETTINGS half; the EFFECT is applied at
// render time by whiteLabelService.effective(), which re-checks the feature.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const audit = require('../services/auditService');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const whiteLabel = require('../services/whiteLabelService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership, requireFeature('white_label'), requireRole('business_owner'));

const body = Joi.object({
  enabled: Joi.boolean(),
  brandName: Joi.string().trim().max(80).allow('', null),
  hidePoweredBy: Joi.boolean(),
  accentColor: Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json({ whiteLabel: await whiteLabel.get(req.params.businessId) });
}));

router.put(
  '/',
  validate({ body }),
  audit.tenantMiddlewareLog('white-label', 'update', () => ({ type: 'business' })),
  asyncHandler(async (req, res) => {
    res.json({ whiteLabel: await whiteLabel.set(req.params.businessId, req.body) });
  }),
);

module.exports = router;
