// Feature-gating service (Push 2 of the tier-system rollout).
//
// Each tier (starter / pro / enterprise) maps to a set of feature keys in
// the plan_features table. A business's active subscription resolves to
// exactly one tier_kind. To gate an endpoint:
//
//   const requireFeature = require('../middleware/requireFeature');
//   router.post('/kds-poll', requireFeature('kds'), handler);
//
// On a failed check the middleware returns 402 Payment Required with a
// JSON body { error: 'FEATURE_LOCKED', feature, requiredTier, upgradeUrl }
// — clients catch that and render an "Upgrade to Pro" CTA.
//
// Performance: an in-process Map cache keyed by businessId. Invalidate on
// plan change by calling clearCache(businessId) from subscriptionService.

const { query, withTransaction } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

const TTL_MS = 60_000;                       // 1-minute soft cache
const cache = new Map();                     // bid → { expires, tierKind, features:Set }

// ── Cross-instance cache invalidation (Review 2026-08-28) ────────────────
// The in-process Map is fast but per-node: a super-admin plan/feature change
// on one instance is invisible to others for up to TTL. When REDIS_URL is set
// we publish invalidations over Redis pub/sub so every node drops the stale
// entry immediately; the local Map stays the hot path. Fully OPTIONAL — with
// no REDIS_URL this is a no-op and behaviour is exactly as before (fine for
// single-instance). ioredis is lazy-required so it isn't needed until used.
const CACHE_CHANNEL = 'namastepos:feature-cache:invalidate';
let _redisPub = null;
let _redisReady = false;
(function initRedis() {
  if (!env.REDIS_URL) return;
  try {
    const Redis = require('ioredis');
    _redisPub = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    _redisPub.on('error', (e) => logger.warn(`[featureCache] redis pub error: ${e.message}`));
    const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
    sub.on('error', (e) => logger.warn(`[featureCache] redis sub error: ${e.message}`));
    sub.subscribe(CACHE_CHANNEL).then(() => { _redisReady = true; }).catch(() => {});
    sub.on('message', (_ch, msg) => {
      if (msg === '*') cache.clear();
      else if (msg) cache.delete(msg);
    });
  } catch (e) {
    logger.warn(`[featureCache] redis disabled (ioredis missing or bad REDIS_URL): ${e.message}`);
  }
}());
function _publishInvalidate(payload) {
  if (_redisPub && _redisReady) {
    _redisPub.publish(CACHE_CHANNEL, payload).catch(() => {});
  }
}

/**
 * Resolve the active plan tier + tier_kind for a business. Push 18b
 * also returns `tier` (the plan's unique code, e.g. 'free' / 'basic' /
 * 'advanced') because features are now keyed at the per-plan level,
 * not just per tier_kind concept.
 */
async function resolveTierKind(businessId) {
  const r = await query(
    // §4.6 hard block (2026-08-23): an expired trial used to keep granting its
    // Pro/Enterprise features forever because we only checked status='trialing'
    // and ignored trial_ends_at. Now a trial only counts while it hasn't
    // expired; once it lapses (and no paid 'active' sub exists) the business
    // falls through to the free/starter tier server-side. This is enforced in
    // the DB resolution, not just the UI.
    `SELECT p.tier, p.tier_kind
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1
        AND (
          s.status = 'active'
          OR (s.status = 'trialing'
              AND (s.trial_ends_at IS NULL OR s.trial_ends_at > NOW()))
        )
      ORDER BY s.updated_at DESC NULLS LAST
      LIMIT 1`,
    [businessId]
  );
  if (r.rowCount === 0) return { tier: 'free', tier_kind: 'starter' };
  return { tier: r.rows[0].tier, tier_kind: r.rows[0].tier_kind };
}

/**
 * The feature keys for a given plan tier code. Push 18b — looks up by
 * plan.tier first (per-plan features); falls back to tier_kind defaults
 * if no plan-specific rows exist (legacy compat / brand-new plans).
 */
async function featuresFor(planTier, fallbackTierKind) {
  // Per-plan rows take precedence.
  let r = await query(
    `SELECT feature_key FROM plan_features WHERE tier_kind = $1`,
    [planTier]
  );
  if (r.rowCount === 0 && fallbackTierKind && fallbackTierKind !== planTier) {
    // Fall back to tier_kind defaults
    r = await query(
      `SELECT feature_key FROM plan_features WHERE tier_kind = $1`,
      [fallbackTierKind]
    );
  }
  return new Set(r.rows.map((row) => row.feature_key));
}

async function _load(businessId) {
  const resolved = await resolveTierKind(businessId);
  const features = await featuresFor(resolved.tier, resolved.tier_kind);
  // Merge currently-active addon slugs so a business that bought e.g. the
  // "loyalty" addon picks up the `loyalty` feature flag in /auth/me even
  // if their plan doesn't grant it. Status filter mirrors the active states
  // used elsewhere in the codebase (active / trialing).
  try {
    const addons = await query(
      `SELECT a.slug, a.grants_features
         FROM business_addons ba
         JOIN addons a ON a.id = ba.addon_id
        WHERE ba.business_id = $1
          AND ba.status IN ('active', 'trialing')
          AND a.is_active = TRUE`,
      [businessId]
    );
    for (const row of addons.rows) {
      if (row.slug) features.add(row.slug); // back-compat: slug doubles as a key
      // 2026-09-03 (plans/addons audit #2): an addon now declares the real
      // feature keys it unlocks (addons.grants_features, migration 074) so
      // e.g. buying 'whatsapp-marketing' opens the featureGate'd
      // 'whatsapp_marketing' routes, not just the slug pseudo-key.
      for (const key of row.grants_features || []) {
        if (key) features.add(key);
      }
    }
  } catch (_) { /* fail open — plan features still apply */ }
  // 2026-09-03 (plans/addons audit #1): per-business feature overrides
  // (business_feature_overrides, FF-315) are applied LAST so they win over
  // both the plan matrix and addon grants: enabled=TRUE force-adds the key,
  // enabled=FALSE force-removes it. Written only by super-admin.
  try {
    const overrides = await query(
      `SELECT feature_key, enabled FROM business_feature_overrides
        WHERE business_id = $1`,
      [businessId]
    );
    for (const row of overrides.rows) {
      if (!row.feature_key) continue;
      if (row.enabled) features.add(row.feature_key);
      else features.delete(row.feature_key);
    }
  } catch (_) { /* fail open — plan+addon features still apply */ }
  const entry = {
    expires: Date.now() + TTL_MS,
    tier: resolved.tier,
    tierKind: resolved.tier_kind,
    features,
  };
  cache.set(businessId, entry);
  return entry;
}

/** True if the business's active plan includes `featureKey`. */
async function hasFeature(businessId, featureKey) {
  let entry = cache.get(businessId);
  if (!entry || entry.expires < Date.now()) {
    entry = await _load(businessId);
  }
  return entry.features.has(featureKey);
}

/** Compact summary used by /v1/auth/me to bootstrap the dashboard. */
async function planSummary(businessId) {
  const entry = await _load(businessId);
  return {
    tier: entry.tier,            // Push 18b — plan code (free/basic/...)
    tierKind: entry.tierKind,    // legacy: tier category (starter/pro/...)
    features: [...entry.features],
  };
}

function clearCache(businessId) {
  cache.delete(businessId);
  _publishInvalidate(businessId); // tell other instances (no-op without REDIS_URL)
}

// Push 14d — when super-admin tweaks a plan's feature matrix we need
// every business's cached plan summary to refresh. Cheaper than tracking
// which businesses are on which tier — the cache rebuilds on the next
// /auth/me call (≤30s polling interval on dashboard, ≤60s on mobile).
function clearAllCaches() {
  cache.clear();
  _publishInvalidate('*'); // tell other instances to clear too
}

function nextTierUp(tierKind) {
  // 2026-09-03 (custom plans): a custom per-customer plan has no meaningful
  // "next tier up" — return null so clients hide the upgrade CTA instead of
  // pitching a generic 'pro' upsell to a bespoke-priced tenant. Applies both
  // to the tier CODE form ('custom-xxxxxxxx') and any unknown input.
  if (!tierKind || String(tierKind).startsWith('custom-')) return null;
  const ladder = { starter: 'pro', pro: 'enterprise', enterprise: null };
  // `in` check: enterprise legitimately maps to null (top tier) — the old
  // `[tierKind] || 'pro'` coerced that null into a bogus 'pro' upsell.
  return tierKind in ladder ? ladder[tierKind] : 'pro';
}

// Push 14d — feature catalog: the master list of every feature key the
// app knows about. We derive it from two sources:
//   1. Anything already attached to a plan in plan_features
//   2. A hard-coded "well-known" list so the admin can add features that
//      no plan grants yet (e.g. a new feature shipping next week).
// The union of the two is what the super-admin picker shows.
const WELL_KNOWN_FEATURE_KEYS = [
  // starter-tier core
  'pos', 'orders', 'token_generation', 'tables_single_floor',
  'menu_basic', 'reports_basic', 'expenses', 'invoice_basic',
  'staff_lite', 'customers_basic',
  // pro additions
  'tables_multi_floor', 'menu_variants_modifiers', 'kds', 'captain_mode',
  'driver_mode', 'loyalty', 'customers_crm', 'aggregators',
  'reservations', 'wastage', 'daily_closing', 'b2b_invoice', 'qr_ordering',
  'whatsapp_marketing', 'auto_whatsapp_order',
  'recipe_costing', 'bill_split',
  'staff_unlimited', 'voice_pos',
  // FF-402 restore-orphans: Inventory screen was wired into the mobile
  // drawer under this feature key but the catalog forgot to expose it,
  // so the admin plans editor couldn't toggle it on. Adding here makes
  // it appear in the Features multi-select on every plan.
  'inventory_tracking',
  // Dedicated keys for the reports/invoice drawer tiles so each can be
  // toggled per-plan independently (not bundled inside reports_basic /
  // invoice_basic). Mobile drawer gates by these.
  'tax_invoices', 'pnl_statement', 'registers',
  // enterprise additions
  'multi_outlet', 'accounting_pnl_bs', 'einvoice_gst', 'recurring_invoices',
  'bank_reconcile', 'surge_pricing', 'heat_map',
  'forecast', 'dead_stock', 'bulk_import', 'api_access', 'white_label',
  'tds_tcs', 'multi_currency_fx',
  // FF-402 restore-orphans catalog sweep — these three keys are still
  // referenced by middleware/featureGate.js to gate live routes
  // (`/memberships`, `/reviews`, `/marketplace`) but were previously
  // dropped from the well-known list, so the admin's plan-features
  // picker couldn't turn them on. Restoring them here so every feature
  // the app actually enforces is grantable per-plan.
  'memberships',
  'reviews',
  'marketplace_addons',
  // 2026-09-03 (plans/addons audit): bill-template editing is now gated by
  // this key (granted by the custom-branding addon's grants_features, or
  // per-plan / per-business override). Must be in the catalog so the admin
  // plan editor + custom-plan builder can grant it.
  'custom_branding',
  // Migration 034 grants this to pro/enterprise and app code checks for
  // it, but it was missing from the well-known catalog so it never
  // appeared in the admin picker either. Restoring here.
  'dashboard_access',
];

async function listFeatureCatalog() {
  const r = await query(`SELECT DISTINCT feature_key FROM plan_features`);
  const fromDb = r.rows.map((row) => row.feature_key);
  // Deduplicate union, sorted for stable UI.
  const all = Array.from(new Set([...WELL_KNOWN_FEATURE_KEYS, ...fromDb])).sort();
  return all;
}

async function listTierFeatures(planTier, fallbackTierKind) {
  // Same precedence as featuresFor: per-plan rows first, then tier_kind
  // defaults. Without the fallback, a brand-new plan that hasn't been
  // edited yet would render with zero features.
  let r = await query(
    `SELECT feature_key FROM plan_features
      WHERE tier_kind = $1 ORDER BY feature_key`,
    [planTier]
  );
  if (r.rowCount === 0 && fallbackTierKind && fallbackTierKind !== planTier) {
    r = await query(
      `SELECT feature_key FROM plan_features
        WHERE tier_kind = $1 ORDER BY feature_key`,
      [fallbackTierKind]
    );
  }
  return r.rows.map((row) => row.feature_key);
}

// Replace the entire feature set for a tier_kind in one transaction.
// Returns the new set. Invalidates the cache so the change is visible
// on the next /auth/me poll without a process restart.
async function setTierFeatures(tierKind, featureKeys) {
  const keys = Array.from(new Set(
    (featureKeys || []).filter((k) => typeof k === 'string' && k.length > 0)
  ));
  // Bug fix: previously used `query('BEGIN')` against the pool — each call
  // grabs a different connection, so the BEGIN/COMMIT/ROLLBACK never wrapped
  // the DELETE+INSERT. A failure between them could wipe the tier's features
  // entirely. `withTransaction` pins a single client for the whole block.
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM plan_features WHERE tier_kind = $1`, [tierKind]);
    if (keys.length > 0) {
      const placeholders = keys.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO plan_features (tier_kind, feature_key) VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        [tierKind, ...keys]
      );
    }
  });
  clearAllCaches();
  return keys;
}

module.exports = {
  resolveTierKind,
  hasFeature,
  planSummary,
  clearCache,
  clearAllCaches,
  nextTierUp,
  listFeatureCatalog,
  listTierFeatures,
  setTierFeatures,
};
