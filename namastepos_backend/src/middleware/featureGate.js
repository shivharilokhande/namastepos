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
//
// EVERY RULE MUST MATCH A REAL ROUTE (2026-09-05, entitlements review B10).
// Ten rules in this table used to match nothing — '/captain/', '/qr-codes',
// '/whatsapp', '/recurring-invoice', '/marketplace', '/fx-rates', '/recipes',
// '/heat-map', '/outlets', '/multi-outlet' — so seven paid features were
// declared "route-enforced" while every plan could reach them. The drift
// audit could not see it because it counted a `{ match, key }` row as proof.
// tests/integration/featureRuleCoverage2026.test.js now walks the mounted
// Express router and fails when a rule hits zero routes or a registry key
// declared enforcement:'route' is not returned by requiredFeature() for any
// registered path. Check the real path in src/routes before adding a row.

const features = require('../services/featureService');
// Every key used below must exist in THE registry — asserted at module load,
// see the check under FEATURE_RULES. A gate on a key the admin console cannot
// grant is the exact failure this codebase has repaired three times.
const registry = require('../config/featureRegistry');

const FEATURE_RULES = [
  // Pro features
  { match: '/kds/', key: 'kds' },
  { match: '/ops/kot/stations', key: 'kds' },
  // 2026-09-03 (plans/addons audit #3b): the whole KOT surface (tickets,
  // status flips, printed marks) is a KDS-tier feature, not just stations.
  // Same key as the stations rule above, so rule order is irrelevant here.
  { match: '/ops/kot/', key: 'kds' },
  // captain_mode: no route has ever contained '/captain/' — the captain
  // screens use /ops/tables + /sessions, which Starter needs. Reclassified as a
  // client-enforced key in the registry (2026-09-05, review B6); dead rule gone.
  { match: '/drivers', key: 'driver_mode' },
  { match: '/delivery-assignments', key: 'driver_mode' },
  // 2026-09-05 (review B9): POST /orders/:orderId/assign-driver is the one
  // driver route that lived outside the two rules above, so a downgraded tenant
  // could still assign drivers while every other driver call 402'd.
  { match: '/assign-driver', key: 'driver_mode' },
  { match: '/loyalty', key: 'loyalty' },
  // 2026-09-05 (dashboard review D-14): food coupons are a loyalty-tier
  // capability (Growth+), gated as such in the dashboard nav and the mobile
  // drawer, but the /food-coupons routes (finalSprint.routes.js) had no server
  // rule, so a Starter tenant could create/apply coupons by URL.
  { match: '/food-coupons', key: 'loyalty' },
  { match: '/aggregator', key: 'aggregators' },
  { match: '/memberships', key: 'memberships' },
  { match: '/reservations', key: 'reservations' },
  { match: '/wait-list', key: 'reservations' },
  { match: '/wastage', key: 'wastage' },
  { match: '/daily-closing', key: 'daily_closing' },
  // 2026-09-05 (review B5): the rule was '/qr-codes', a path that never
  // existed. The QR self-ordering surface is ops.routes.js: GET/PUT
  // /ops/qr/settings, GET /ops/tables/:tableId/qr, POST
  // /ops/tables/:tableId/qr/rotate. False-positive check: every route string
  // in src/routes containing 'qr' was grepped and only those four exist; the
  // public guest side (/v1/guest/*) is outside the gate's mount prefix and is
  // deliberately open (a diner's phone has no plan).
  { match: '/qr', key: 'qr_ordering' },
  { match: '/reviews', key: 'reviews' },
  // 2026-09-05 (review B2): the rule was '/whatsapp'; the campaign routes are
  // /wa/campaigns and /wa/campaigns/:id/run (growth.routes.js), so Starter
  // could create AND RUN campaigns. The trailing slash matters: '/wa/' must not
  // catch /wastage, /wait-list or /wallet. The WhatsApp webhooks are mounted at
  // /v1/wa-webhooks and /v1/meta-wa-webhooks — outside the /businesses/:id
  // prefix this gate is mounted on, so they are unaffected.
  { match: '/wa/', key: 'whatsapp_marketing' },
  { match: '/ingredients', key: 'recipe_costing' },
  // ('/recipes' rule removed 2026-09-05: recipes live at
  // /ingredients/_recipes/:menuItemId, which the '/ingredients' rule covers;
  // the string '/recipes' never appeared in any route.)
  // 2026-09-05 (review B3): '/bill-split' only matched PUT
  // /bill-split-invoices/:id/pay — the split was CREATED ungated via POST
  // /sessions/:sessionId/split and listed via GET /sessions/:sessionId/splits
  // (finalSprint.routes.js), so Starter could split a bill and then 402 when
  // paying it. '/split' covers the two session paths; '/bill-split' stays for
  // the invoice path (it is '-split', not '/split', so one rule cannot cover
  // both). False-positive check: every route string in src/routes containing
  // 'split' was grepped — the only hits are those three paths (the settle
  // tender path has no 'split' in it), so the broader match is safe. The
  // /sessions/ surface itself must stay open on Starter (Push 13.7 below).
  { match: '/bill-split', key: 'bill_split' },
  { match: '/split', key: 'bill_split' },
  // Push 13.7: table sessions ungated. Captain moved to Starter in
  // migration 034, so the running-bill / settle / split APIs need to be
  // reachable on Starter too. Without this, mobile's "tap occupied
  // table → load running bill" 402s with FEATURE_LOCKED.
  // { match: '/sessions/',     key: 'tables_multi_floor' },  // removed
  { match: '/variants', key: 'menu_variants_modifiers' },
  { match: '/modifier-groups', key: 'menu_variants_modifiers' },
  // Enterprise features
  { match: '/accounting/', key: 'accounting_pnl_bs' },
  { match: '/einvoice', key: 'einvoice_gst' },
  // 2026-09-06 (round-2, CONTRACTS §2): the feature is BUILT now —
  // routes/recurringInvoices.routes.js mounted at /recurring-invoices. (The
  // old '/recurring-invoice' rule was removed on 2026-09-05 because nothing
  // answered on it; this one has a router behind it.)
  { match: '/recurring-invoices', key: 'recurring_invoices' },
  { match: '/bank/', key: 'bank_reconcile' },
  { match: '/surge/', key: 'surge_pricing' },
  // ('/outlets' + '/multi-outlet' rules removed 2026-09-05: the outlet surface
  // is mounted at /v1/outlet-groups, OUTSIDE this gate's prefix, and
  // multiOutlet.routes.js gates itself with hasFeature('multi_outlet'). The
  // '/retail/' rule below is the in-prefix multi_outlet gate.)
  // ('/heat-map' rule removed 2026-09-05: the report route is
  // /orders-by-hour, gated below.)
  { match: '/forecast', key: 'forecast' },
  { match: '/upsell', key: 'forecast' },
  { match: '/dead-stock', key: 'dead_stock' },
  { match: '/orders-by-hour', key: 'heat_map' },
  { match: '/bulk-import', key: 'bulk_import' },
  // 2026-09-03 (plans/addons audit #3b): retail (SKUs, vendors, POs, party
  // ledger, cheques, warehouses) is an enterprise surface. MUST stay BELOW
  // the '/bulk-import' rule: requiredFeature() returns the FIRST substring
  // match, so '/retail/bulk-import' keeps its existing 'bulk_import' key
  // while every other /retail/* route needs 'multi_outlet'.
  { match: '/retail/', key: 'multi_outlet' },
  // ('/marketplace' rule removed 2026-09-05: no route; the marketplace is
  // /addons, exempted below on purpose. marketplace_addons is now declared
  // ungated in the registry.)
  { match: '/tds-tcs', key: 'tds_tcs' },
  // 2026-09-05 (review B7): the rule was '/fx-rates'; the route is
  // GET/PUT /fx/:base/:quote (finalSprint.routes.js). '/fx/' with the trailing
  // slash so it cannot catch an unrelated '/fx-…' resource later.
  { match: '/fx/', key: 'multi_currency_fx' },
];

// ── Fail at boot, not on a customer's phone ──────────────────────────────
// A rule whose key is not in config/featureRegistry.js is a route the founder
// cannot switch on or off, because the admin picker only offers registry keys.
// That is not a runtime edge case to log and continue past — it is a broken
// build, so it throws on require and every test in the suite goes red at once.
// The blocking drift gate is tests/integration/featureRegistryDrift.test.js;
// this is the cheap belt-and-braces version that also protects `node -e`
// one-offs and production boot.
(function assertRulesRegistered() {
  const unknown = [...new Set(FEATURE_RULES.map((r) => r.key))].filter((k) => !registry.isKnown(k));
  if (unknown.length) {
    throw new Error(
      `featureGate: FEATURE_RULES gate feature key(s) [${unknown.join(', ')}] that are not in `
      + 'config/featureRegistry.js. The admin console can only grant registered keys, so these '
      + 'routes would be permanently locked with no way to unlock them. Add the key(s) to the '
      + 'registry (see that file\'s "ADDING A FEATURE KEY" header).',
    );
  }
}());

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

    // ── X-Plan-Version (2026-09-05 feature-sync audit) ────────────────────
    // A running client has no way to learn that its entitlement changed
    // except by asking /auth/me, and the mobile app only asks on login, on
    // foreground-resume and after a purchase — so a tablet that never leaves
    // the app never finds out (see featureService.planVersion's header for the
    // full trace). Stamping the fingerprint on responses the client is ALREADY
    // making lets it notice within its own existing poll interval.
    //
    // Deliberately non-blocking: `planVersionIfCached` reads the same Map the
    // gate below reads and returns null rather than issuing a query, so an
    // ungated path never pays a database round trip just to carry a header.
    // Best-effort — a failure here must never affect the response.
    try {
      const v = features.planVersionIfCached(businessId);
      if (v) res.setHeader('X-Plan-Version', v);
    } catch (_) { /* never break a request over a diagnostic header */ }

    const key = requiredFeature(req.path);
    if (!key) return next();

    try {
      const ok = await features.hasFeature(businessId, key);
      // hasFeature has now loaded the entry, so the fingerprint is free.
      try {
        const v = features.planVersionIfCached(businessId);
        if (v) res.setHeader('X-Plan-Version', v);
      } catch (_) { /* as above */ }
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
        // Raw kinds stay in currentTier/requiredTier for API compatibility;
        // the labels are what clients should show ('pro_plan' -> 'Pro').
        currentTierLabel: features.tierLabel(currentTier),
        requiredTierLabel: features.tierLabel(requiredTier),
        message: requiredTier
          ? `Upgrade to ${features.tierLabel(requiredTier)} to unlock this feature.`
          : 'This feature is not included in your plan.',
        upgradeUrl: '/billing',
      });
    } catch (err) {
      next(err);
    }
  };
};

module.exports.requiredFeature = requiredFeature;
// Read-only view for tests/integration/featureRuleCoverage2026.test.js, which
// proves every row matches a mounted route. Frozen copies — nothing outside
// this file may add or remove a rule.
module.exports.FEATURE_RULES = Object.freeze(FEATURE_RULES.map((r) => Object.freeze({ ...r })));
