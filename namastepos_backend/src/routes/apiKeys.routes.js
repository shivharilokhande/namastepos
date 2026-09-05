// NamastePOS backend — tenant API keys (round-2 fix batch 2026-09-06, CONTRACTS §3)
//
// Mounted in app.js under the business prefix:
//   app.use(`${env.API_PREFIX}/businesses/:businessId/api-keys`, require('./routes/apiKeys.routes'));
//
//   GET    /            → { keys: [{ id, label, prefix, createdAt, lastUsedAt, revokedAt }] }
//   POST   /  { label } → 201 { key: { id, label, prefix, createdAt }, secret }   (secret shown once)
//   DELETE /:keyId      → 204                                                     (sets revoked_at)
//
// Owner only, and every route is behind requireFeature('api_access') — the
// plan that does not include API access cannot issue keys (402 FEATURE_LOCKED),
// and middleware/auth.js re-checks the same key on every request MADE with an
// API key, so a downgrade turns existing keys off too.
//
// An API-key principal must never manage keys with a key (that would let a
// leaked read-only key mint itself a fresh one): requireRole resolves the live
// business_users membership, which an api_key principal does not have, so it
// 403s here by construction — asserted in tests/integration/apiKeysRound2B.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const audit = require('../services/auditService');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const apiKeys = require('../services/apiKeyService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership, requireFeature('api_access'), requireRole('business_owner'));

const issueBody = Joi.object({
  label: Joi.string().trim().min(1).max(80)
    .required(),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json({ keys: await apiKeys.list(req.params.businessId) });
}));

router.post(
  '/',
  validate({ body: issueBody }),
  audit.tenantMiddlewareLog('api-keys', 'issue', () => ({ type: 'api_key' })),
  asyncHandler(async (req, res) => {
    const out = await apiKeys.issue(req.params.businessId, {
      label: req.body.label,
      createdBy: req.user?.id || null,
    });
    res.status(201).json(out);
  }),
);

router.delete(
  '/:keyId',
  validate({ params: Joi.object({ businessId: Joi.string().required(), keyId: Joi.string().uuid().required() }) }),
  audit.tenantMiddlewareLog('api-keys', 'revoke', (req) => ({ type: 'api_key', id: req.params.keyId })),
  asyncHandler(async (req, res) => {
    await apiKeys.revoke(req.params.businessId, req.params.keyId);
    // res.json (not .end) so the tenant audit hook above sees the response;
    // Express drops the body on a 204 anyway.
    res.status(204).json({});
  }),
);

module.exports = router;
