// requireFeature(key) — Express middleware that 402s if the business's
// active plan tier doesn't include the requested feature key.
//
// Usage on a route file:
//   const requireFeature = require('../middleware/requireFeature');
//   router.get('/kds/tickets', requireFeature('kds'), asyncHandler(...));
//
// Response body on lock:
//   { error: 'FEATURE_LOCKED', feature, requiredTier, upgradeUrl, currentTier }

const features = require('../services/featureService');

module.exports = function requireFeature(featureKey) {
  return async function (req, res, next) {
    try {
      const businessId = req.params.businessId || req.user?.businessId || req.user?.bid;
      if (!businessId) {
        // Public endpoint or pre-auth — let it through; auth middleware
        // will reject if needed.
        return next();
      }
      const ok = await features.hasFeature(businessId, featureKey);
      if (ok) return next();

      // resolveTierKind returns { tier, tier_kind }; nextTierUp expects the
      // tier_kind STRING.
      const resolved = await features.resolveTierKind(businessId);
      const currentTier = resolved.tier_kind;
      const requiredTier = features.nextTierUp(currentTier);
      return res.status(402).json({
        error: 'FEATURE_LOCKED',
        feature: featureKey,
        currentTier,
        requiredTier,
        // Raw kinds stay in currentTier/requiredTier for API compatibility;
        // the labels are what clients should show ('pro_plan' -> 'Pro').
        currentTierLabel: features.tierLabel(currentTier),
        requiredTierLabel: features.tierLabel(requiredTier),
        upgradeUrl: '/billing',
      });
    } catch (err) {
      next(err);
    }
  };
};
