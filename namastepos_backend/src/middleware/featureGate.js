// Global feature-gate middleware (Push 3 of the tier rollout).
//
// Rather than wiring requireFeature() into every Pro/Enterprise route file
// (100+ touchpoints), we centralize the path→feature mapping here and let
// one middleware do the dispatch. Anything not listed defaults to allow,
// which keeps the Starter tier functional out of the box.
//
// To gate a new endpoint, just add a row to FEATURE_RULES below. Patterns
// are simple substring tests against `req.path` because every business
// API route lives under /v1/businesses/:id/<resource>.

const features = require('../services/featureService');

const FEATURE_RULES = [
  // Pro features
  { match: '/kds/',             key: 'kds' },
  { match: '/ops/kot/stations', key: 'kds' },
  // 2026-09-03 (plans/addons audit #3b): the whole KOT surface (tickets,
  // status flips, printed marks) is a KDS-tier feature, not just stations.
  // Same key as the stations rule above, so rule order is irrelevant here.
  { match: '/ops/kot/',         key: 'kds' },
  { match: '/captain/',         key: 'captain_mode' },
  { match: '/drivers',          key: 'driver_mode' },
  { match: '/delivery-assignments', key: 'driver_mode' },
  { match: '/loyalty',          key: 'loyalty' },
  { match: '/aggregator',       key: 'aggregators' },
  { match: '/memberships',      key: 'memberships' },
  { match: '/reservations',     key: 'reservations' },
  { match: '/wait-list',        key: 'reservations' },
  { match: '/wastage',          key: 'wastage' },
  { match: '/daily-closing',    key: 'daily_closing' },
  { match: '/qr-codes',         key: 'qr_ordering' },
  { match: '/reviews',          key: 'reviews' },
  { match: '/whatsapp',         key: 'whatsapp_marketing' },
  { match: '/ingredients',      key: 'recipe_costing' },
  { match: '/recipes',          key: 'recipe_costing' },
  { match: '/bill-split',       key: 'bill_split' },
  // Push 13.7: table sessions ungated. Captain moved to Starter in
  // migration 034, so the running-bill / settle / split APIs need to be
  // reachable on Starter too. Without this, mobile's "tap occupied
  // table → load running bill" 402s with FEATURE_LOCKED.
  // { match: '/sessions/',     key: 'tables_multi_floor' },  // removed
  { match: '/variants',         key: 'menu_variants_modifiers' },
  { match: '/modifier-groups',  key: 'menu_variants_modifiers' },
  // Enterprise features
  { match: '/accounting/',      key: 'accounting_pnl_bs' },
  { match: '/einvoice',         key: 'einvoice_gst' },
  { match: '/recurring-invoice',key: 'recurring_invoices' },
  { match: '/bank/',            key: 'bank_reconcile' },
  { match: '/surge/',           key: 'surge_pricing' },
  { match: '/outlets',          key: 'multi_outlet' },
  { match: '/multi-outlet',     key: 'multi_outlet' },
  { match: '/heat-map',         key: 'heat_map' },
  { match: '/forecast',         key: 'forecast' },
  { match: '/upsell',           key: 'forecast' },
  { match: '/dead-stock',       key: 'dead_stock' },
  { match: '/orders-by-hour',   key: 'heat_map' },
  { match: '/bulk-import',      key: 'bulk_import' },
  // 2026-09-03 (plans/addons audit #3b): retail (SKUs, vendors, POs, party
  // ledger, cheques, warehouses) is an enterprise surface. MUST stay BELOW
  // the '/bulk-import' rule: requiredFeature() returns the FIRST substring
  // match, so '/retail/bulk-import' keeps its existing 'bulk_import' key
  // while every other /retail/* route needs 'multi_outlet'.
  { match: '/retail/',          key: 'multi_outlet' },
  { match: '/marketplace',      key: 'marketplace_addons' },
  { match: '/tds-tcs',          key: 'tds_tcs' },
  { match: '/fx-rates',         key: 'multi_currency_fx' },
];

/** Returns the feature key required for `req.path`, or null if open. */
function requiredFeature(path) {
  // 2026-09-03 (plans/addons audit): the addon-marketplace endpoints
  // (/addons, /addons/subscribe, /addons/:slug/confirm-payment|cancel|resume)
  // must NEVER be plan-gated — '/addons/whatsapp-marketing/...' was substring-
  // matching the '/whatsapp' rule, which 402'd the very checkout that would
  // have granted the feature. Buying/cancelling an addon is a billing action,
  // not a gated feature.
  if (path.startsWith('/addons')) return null;
  for (const r of FEATURE_RULES) {
    if (path.includes(r.match)) return r.key;
  }
  return null;
}

/** Express middleware. Mounted after auth so req.user is populated. */
module.exports = function featureGate() {
  return async function (req, res, next) {
    // Only gate authenticated business routes.
    if (!req.user?.businessId && !req.params?.businessId) return next();

    // Review fix (2026-08-23): this gate is mounted BEFORE the per-router
    // requireAuth, so unauthenticated requests used to get 402 here —
    // wrong status, and it let anonymous callers probe a business's plan
    // (402 vs 404 reveals which features a tenant lacks) while costing a
    // DB lookup per probe. If there's no Bearer token at all, fall through
    // and let the router's requireAuth answer 401.
    if (!req.user && !(req.headers.authorization || '').startsWith('Bearer ')
        && !req.headers['x-staff-token']) {
      return next();
    }
    const businessId = req.params?.businessId || req.user.businessId;

    const key = requiredFeature(req.path);
    if (!key) return next();

    try {
      const ok = await features.hasFeature(businessId, key);
      if (ok) return next();
      // resolveTierKind returns { tier, tier_kind }; nextTierUp expects the
      // tier_kind STRING (passing the object made requiredTier always 'pro'
      // and serialised currentTier as an object).
      const resolved = await features.resolveTierKind(businessId);
      const currentTier = resolved.tier_kind;
      const requiredTier = features.nextTierUp(currentTier);
      return res.status(402).json({
        error: 'FEATURE_LOCKED',
        feature: key,
        currentTier,
        requiredTier,
        message: `Upgrade to ${requiredTier} to unlock this feature.`,
        upgradeUrl: '/billing',
      });
    } catch (err) {
      next(err);
    }
  };
};

module.exports.requiredFeature = requiredFeature;
