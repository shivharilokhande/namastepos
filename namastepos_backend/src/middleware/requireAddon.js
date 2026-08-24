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

function requireAddon(slug) {
  return async (req, _res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const businessId = req.params.businessId || req.user?.businessId;
    if (!businessId) return next();
    try {
      const ok = await addons.hasAddon(businessId, slug);
      if (ok) return next();
      const err = new HttpError(402,
        `This feature requires the ${slug} add-on`,
        'ADDON_REQUIRED',
        { addonSlug: slug }
      );
      return next(err);
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = requireAddon;
