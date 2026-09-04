// NamastePOS backend - feature-gating middleware for add-ons.
//
//   router.get('/aggregator-orders',
//     requireAuth,
//     requireBusinessOwnership,
//     requireAddon('online-orders'),     // ← here
//     handler);
//
// Returns 402 Payment Required with { code: 'ADDON_REQUIRED', addonSlug }
// so the client can present a "Buy this addon" CTA.

const addons = require('../services/addonService');
const { HttpError } = require('../utils/errors');

/**
 * requireAddon(slug, { orFeature }) — passes when the addon is active OR,
 * when `orFeature` is given, the tenant's merged feature set (plan +
 * addon grants + overrides) contains that feature key. 2026-09-03
 * (plans/addons audit #2): without the orFeature escape a plan that GRANTS
 * e.g. 'loyalty' still 402'd on the addon-gated /customers routes.
 */
function requireAddon(slug, { orFeature = null } = {}) {
  return async (req, _res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const businessId = req.params.businessId || req.user?.businessId;
    if (!businessId) return next();
    try {
      const ok = await addons.hasAddon(businessId, slug);
      if (ok) return next();
      if (orFeature) {
        const features = require('../services/featureService');
        if (await features.hasFeature(businessId, orFeature)) return next();
      }
      const err = new HttpError(
        402,
        `This feature requires the ${slug} add-on`,
        'ADDON_REQUIRED',
        { addonSlug: slug },
      );
      return next(err);
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = requireAddon;
