// Feature-gating service (Push 2 of the tier-system rollout).
//
// Each plan maps to a set of feature keys in the plan_features table (whose
// `tier_kind` column has held a plan tier CODE since migration 040 — see
// services/planTiers.js for the code-vs-kind distinction and the live
// mapping; the string 'pro' means different plans in the two namespaces).
// A business's active subscription resolves to exactly one plan, hence one
// tier code and one tier_kind. To gate an endpoint:
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

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const cacheBus = require('../utils/cacheBus');
const entitlement = require('./planEntitlement');
// THE catalog of feature keys. This module used to carry its own
// WELL_KNOWN_FEATURE_KEYS array; three separate "restore the orphans"
// commits later, that array moved to config/featureRegistry.js, which the
// drift audit compares against the gates and the plan data. Do not re-add a
// local list here — read that file's header first.
const registry = require('../config/featureRegistry');
// Ordered tier-kind ladder + rank helpers. Single source of truth — read the
// header of that file before touching anything tier-related.
const planTiers = require('./planTiers');

const TTL_MS = 60_000; // 1-minute soft cache
const cache = new Map(); // bid → { expires, tierKind, features:Set }

// ── Cross-instance cache invalidation (Review 2026-08-28) ────────────────
// The in-process Map is fast but per-node: a super-admin plan/feature change
// on one instance is invisible to others for up to TTL. When REDIS_URL is set
// we publish invalidations over Redis pub/sub so every node drops the stale
// entry immediately; the local Map stays the hot path. Fully OPTIONAL — with
// no REDIS_URL this is local-only and behaviour is exactly as before (fine for
// single-instance).
//
// 2026-09-04: this used to own a private ioredis pub/sub pair. Three more
// process-local caches needed the same treatment (auth membership, admin
// is_active, admin RBAC role), so the mechanism moved to utils/cacheBus —
// one publisher + one subscriber for the whole process, addressed by topic.
// Behaviour here is unchanged; only the transport is shared. NOTE the channel
// name changed with it, so during a rolling deploy old and new instances do
// not hear each other's feature invalidations (they fall back to the 60s TTL);
// harmless on today's single-instance prod.
cacheBus.subscribe(cacheBus.TOPIC.FEATURE, (bid) => {
  if (bid === '*' || !bid) cache.clear();
  else cache.delete(bid);
});
function _publishInvalidate(payload) {
  cacheBus.publish(cacheBus.TOPIC.FEATURE, payload);
}

/**
 * Resolve the active plan tier + tier_kind for a business. Push 18b
 * also returns `tier` (the plan's unique code, e.g. 'free' / 'basic' /
 * 'advanced') because features are now keyed at the per-plan level,
 * not just per tier_kind concept.
 */
async function resolveTierKind(businessId) {
  // §4.6 hard block (2026-08-23): an expired trial used to keep granting its
  // Pro/Enterprise features forever because we only checked status='trialing'
  // and ignored trial_ends_at. Now a trial only counts while it hasn't
  // expired; once it lapses (and no paid 'active' sub exists) the business
  // falls through to the free/starter tier server-side. This is enforced in
  // the DB resolution, not just the UI.
  //
  // 2026-09-04 (retention audit F-02): the entitlement condition moved OUT of
  // this query into planEntitlement.entitledSql() and now also covers a
  // `past_due` grace window — a failed card no longer strips a working
  // restaurant the instant the webhook lands. One predicate, two callers
  // (this feature gate and subscriptionService's limit gate), so the two can
  // never disagree about who is entitled.
  const r = await query(
    `SELECT p.tier, p.tier_kind, s.status,
            s.trial_ends_at, s.past_due_at, s.last_dunning_at
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1
        AND ${entitlement.entitledSql('s')}
      ORDER BY s.updated_at DESC NULLS LAST
      LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) {
    return {
      tier: planTiers.FALLBACK_PLAN_CODE,
      tier_kind: planTiers.FALLBACK_TIER_KIND,
      entitled: false,
      expiresAtMs: null,
    };
  }
  const row = r.rows[0];
  const c = entitlement.classify(row);
  return {
    tier: row.tier,
    tier_kind: row.tier_kind,
    // Additive: existing callers (requireFeature, featureGate,
    // multiOutlet.routes) read only `tier` / `tier_kind`.
    entitled: true,
    reason: c.reason,
    expiresAtMs: c.expiresAt ? c.expiresAt.getTime() : null,
  };
}

/**
 * The feature keys for a given plan tier code. Push 18b — looks up by
 * plan.tier first (per-plan features); falls back to tier_kind defaults
 * if no plan-specific rows exist (legacy compat / brand-new plans).
 */
async function featuresFor(planTier, fallbackTierKind) {
  // Per-plan rows take precedence.
  let r = await query(
    'SELECT feature_key FROM plan_features WHERE tier_kind = $1',
    [planTier],
  );
  if (r.rowCount === 0 && fallbackTierKind && fallbackTierKind !== planTier) {
    // Fall back to tier_kind defaults
    r = await query(
      'SELECT feature_key FROM plan_features WHERE tier_kind = $1',
      [fallbackTierKind],
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
      [businessId],
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
      [businessId],
    );
    for (const row of overrides.rows) {
      if (!row.feature_key) continue;
      if (row.enabled) features.add(row.feature_key);
      else features.delete(row.feature_key);
    }
  } catch (_) { /* fail open — plan+addon features still apply */ }
  // Cache lifetime (2026-09-04, retention audit F-02). The soft TTL is the
  // normal case, but an entitlement that is only true UNTIL a known instant
  // (a trial's end, a past_due grace deadline) must not outlive that instant:
  // otherwise a tenant whose grace expired at 20:00 keeps loyalty, reports and
  // aggregator ingestion until 20:01, and — worse — a peer node that never
  // receives a Redis invalidation (no REDIS_URL, or a rolling deploy where the
  // channel name differs) would serve the stale "still in grace" answer for a
  // full TTL. Capping the entry at the deadline closes both: every node
  // derives the same deadline from the same row, with no cross-node message
  // needed. Nothing extends past the soft TTL — this only ever shortens it.
  const now = Date.now();
  let expires = now + TTL_MS;
  if (typeof resolved.expiresAtMs === 'number' && resolved.expiresAtMs > now) {
    expires = Math.min(expires, resolved.expiresAtMs);
  }
  const entry = {
    expires,
    tier: resolved.tier,
    tierKind: resolved.tier_kind,
    features,
    // A short fingerprint of the ENTITLEMENT this tenant currently has. See
    // planVersion() below for why it exists.
    version: _fingerprint(resolved.tier, resolved.tier_kind, features),
  };
  cache.set(businessId, entry);
  return entry;
}

/**
 * Fingerprint of a tenant's effective entitlement: plan code + kind + the
 * merged feature set. Stable across processes (same inputs → same digest) and
 * cheap; 12 hex chars is ample for "did this change?".
 */
function _fingerprint(tier, tierKind, featureSet) {
  const payload = `${tier || ''}|${tierKind || ''}|${[...featureSet].sort().join(',')}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

/**
 * The tenant's current plan version, from the same cache the gates read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY (2026-09-05 feature-sync audit, Task 4 — propagation)
 * ══════════════════════════════════════════════════════════════════════════
 * When the founder removes a feature from a plan in the admin console the
 * SERVER is correct immediately: setTierFeatures → clearAllCaches() → local
 * handlers run synchronously and Redis fans the invalidation out to every
 * other instance, and planSummary() re-reads the database on every /auth/me
 * regardless of the cache. There is no server-side lag to fix.
 *
 * The lag is entirely in the clients, and it is not symmetric:
 *   * dashboard — usePlan() refetches /auth/me every 60s. Bounded, fine.
 *   * mobile    — AuthProvider.refreshPlan() runs on login, on
 *                 AppLifecycleState.resumed, and after an in-app purchase.
 *                 There is NO periodic refresh. A POS tablet that stays in
 *                 the app all day — which is exactly what a POS tablet does —
 *                 never re-reads its entitlement. The delay is UNBOUNDED.
 *
 * For a route-gated feature the damage is contained: the API stops answering
 * within 60s, so the stale button 402s. For a feature the server has no
 * surface to gate (voice_pos: speech recognition runs on-device) there is
 * nothing to 402 and the customer keeps it until the app is backgrounded or
 * restarted. That is the bug behind the founder's report.
 *
 * The server side of the fix is this fingerprint, surfaced as the
 * `X-Plan-Version` response header on every authenticated business request
 * (middleware/featureGate.js) and as `planVersion` in /auth/me. A client
 * already polls SOMETHING every few seconds — orders, KDS, tables — so it can
 * notice the header changed and call /auth/me, without adding a poll and
 * without waiting for a foreground transition. Reading the header is the
 * client's half; this is ours.
 */
async function planVersion(businessId) {
  let entry = cache.get(businessId);
  if (!entry || entry.expires < Date.now()) {
    entry = await _load(businessId);
  }
  return entry.version;
}

/**
 * The cached fingerprint if one is already loaded and fresh, else null.
 * Non-blocking and side-effect free — used by the response header so that
 * stamping it never adds a database round trip to a request that did not
 * otherwise need one.
 */
function planVersionIfCached(businessId) {
  const entry = cache.get(businessId);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.version;
}

/** True if the business's active plan includes `featureKey`. */
async function hasFeature(businessId, featureKey) {
  let entry = cache.get(businessId);
  if (!entry || entry.expires < Date.now()) {
    entry = await _load(businessId);
  }
  return entry.features.has(featureKey);
}

/**
 * Compact summary used by /v1/auth/me to bootstrap the dashboard and the
 * mobile app.
 *
 * 2026-09-04 (tier-code trap, mobile half): the three label fields are
 * ADDITIVE and exist so a CLIENT NEVER COMPUTES AN UPGRADE TARGET ITSELF.
 * The Flutter app used to render `tierKind == 'starter' ? 'Pro' :
 * 'Enterprise'`, which told every Growth / Pro / Advanced tenant to jump
 * straight to Enterprise (Rs 1,999) — the kind 'pro' IS Growth, and the plan
 * named Pro is the kind 'pro_plan'. The ladder lives in services/planTiers.js
 * and only the server reads it; clients display these strings verbatim and
 * fall back to something non-specific ("a higher plan") when they are absent.
 * Same values the 402 FEATURE_LOCKED body carries as currentTierLabel /
 * requiredTierLabel.
 */
async function planSummary(businessId) {
  const entry = await _load(businessId);
  const nextKind = planTiers.nextKindUp(entry.tierKind);
  return {
    tier: entry.tier, // Push 18b — plan code (free/basic/...)
    tierKind: entry.tierKind, // legacy: tier category (starter/pro/...)
    // Owner-facing name of the CURRENT kind ('pro_plan' -> 'Pro').
    tierLabel: planTiers.labelOf(entry.tierKind),
    // The one plan up the ladder, or null when there is nowhere to upsell
    // (top of ladder, or a bespoke per-customer plan). Never guessed.
    nextTierKind: nextKind || null,
    nextTierLabel: nextKind ? planTiers.labelOf(nextKind) : null,
    features: [...entry.features],
    // Additive (2026-09-05). Same value as the X-Plan-Version response header;
    // a client that stored it can tell, from any ordinary API call, that its
    // entitlement changed and this summary is stale. See planVersion().
    planVersion: entry.version,
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

/**
 * The next tier KIND up from `tierKind`, or null when there is nothing to
 * upsell (top of ladder, a custom per-customer plan, or an unknown kind).
 *
 * 2026-09-04: this used to hold its own three-entry ladder
 * `{ starter: 'pro', pro: 'enterprise', enterprise: null }` with a
 * `: 'pro'` fallback, and both halves were wrong against the live five-kind
 * ladder: 'pro_plan' and 'advanced' were absent, so a Pro (Rs 799) or
 * Advanced (Rs 999) tenant was told to "upgrade to pro" — the KIND 'pro' is
 * Growth at Rs 299, i.e. a downgrade — and Growth itself was pitched
 * Enterprise (Rs 1,999), skipping the two plans in between. Now delegated
 * to the ordered ladder in services/planTiers.js. Do not re-add a local map.
 */
function nextTierUp(tierKind) {
  return planTiers.nextKindUp(tierKind);
}

/** Owner-facing name for a tier kind ('pro_plan' -> 'Pro'). */
function tierLabel(tierKind) {
  return planTiers.labelOf(tierKind);
}

// Push 14d — feature catalog: the master list of every feature key the
// app knows about. We derive it from two sources:
//   1. config/featureRegistry.js — THE registry, so the admin can grant a
//      feature that no plan carries yet (one shipping next week), and so the
//      drift audit has a fixed point to compare the gates against.
//   2. Anything already attached to a plan in plan_features, so a key minted
//      by an older deploy stays visible and removable instead of becoming an
//      invisible grant.
// The union of the two is what the super-admin picker shows.
//
// 2026-09-05: this list used to live here as WELL_KNOWN_FEATURE_KEYS, a hand-
// maintained array that had to be edited every time a gate was added and
// silently didn't get edited three times (FF-402's "restore-orphans" commits,
// dashboard_access, custom_branding). It now lives in config/featureRegistry.js
// with an enforcement declaration per key, and
// tests/integration/featureRegistryDrift.test.js fails the build when the
// registry, the gates and the plan data disagree. DO NOT re-introduce a second
// list in this file or in the admin console.
//
// READING THE LIST FROM OUTSIDE NODE (the Flutter entitlement test, a CI shell
// step): use docs/feature-catalog.json — the registry published as data,
// regenerated by `node scripts/feature-registry-audit.js --write` and asserted
// fresh by the drift test. Do NOT regex a JavaScript source file for it.

/**
 * Back-compat alias for the array that used to live here. Derived, so it can
 * never disagree with the registry. Kept because callers (and at least one
 * cross-repo test) refer to the old name.
 */
const WELL_KNOWN_FEATURE_KEYS = registry.keys();

async function listFeatureCatalog() {
  const r = await query('SELECT DISTINCT feature_key FROM plan_features');
  const fromDb = r.rows.map((row) => row.feature_key);
  // Deduplicate union, sorted for stable UI.
  const all = Array.from(new Set([...registry.keys(), ...fromDb])).sort();
  return all;
}

/**
 * The same catalog with the metadata the admin console needs to render it:
 * `label`, `group` (section heading) and `enforcement`. The console used to
 * keep its OWN bucket map and its OWN label map — two more lists to drift —
 * so both now come from here.
 *
 * A key that exists in plan_features but not in the registry is still
 * returned, marked `enforcement: 'unregistered'` in group "Unregistered", so
 * the founder can SEE and remove a stale grant instead of it being invisible.
 * The drift test fails on any such key, so in a healthy build there are none.
 */
async function listFeatureCatalogDetailed() {
  const r = await query('SELECT DISTINCT feature_key FROM plan_features');
  const known = new Set(registry.keys());
  const rows = registry.catalog();
  for (const row of r.rows) {
    if (row.feature_key && !known.has(row.feature_key)) {
      rows.push({
        key: row.feature_key,
        label: row.feature_key,
        group: 'Unregistered',
        enforcement: 'unregistered',
        why: 'Present in plan_features but absent from config/featureRegistry.js — '
          + 'nothing in the product reads it. Remove it from the plans that carry it, '
          + 'or register it.',
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

async function listTierFeatures(planTier, fallbackTierKind) {
  // Same precedence as featuresFor: per-plan rows first, then tier_kind
  // defaults. Without the fallback, a brand-new plan that hasn't been
  // edited yet would render with zero features.
  let r = await query(
    `SELECT feature_key FROM plan_features
      WHERE tier_kind = $1 ORDER BY feature_key`,
    [planTier],
  );
  if (r.rowCount === 0 && fallbackTierKind && fallbackTierKind !== planTier) {
    r = await query(
      `SELECT feature_key FROM plan_features
        WHERE tier_kind = $1 ORDER BY feature_key`,
      [fallbackTierKind],
    );
  }
  return r.rows.map((row) => row.feature_key);
}

// Replace the entire feature set for a tier_kind in one transaction.
// Returns the new set. Invalidates the cache so the change is visible
// on the next /auth/me poll without a process restart.
async function setTierFeatures(tierKind, featureKeys) {
  const keys = Array.from(new Set(
    (featureKeys || []).filter((k) => typeof k === 'string' && k.length > 0),
  ));
  // Bug fix: previously used `query('BEGIN')` against the pool — each call
  // grabs a different connection, so the BEGIN/COMMIT/ROLLBACK never wrapped
  // the DELETE+INSERT. A failure between them could wipe the tier's features
  // entirely. `withTransaction` pins a single client for the whole block.
  await withTransaction(async (client) => {
    await client.query('DELETE FROM plan_features WHERE tier_kind = $1', [tierKind]);
    if (keys.length > 0) {
      const placeholders = keys.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO plan_features (tier_kind, feature_key) VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        [tierKind, ...keys],
      );
    }
  });
  clearAllCaches();
  return keys;
}

// Ops visibility (2026-09-03): the admin health panel needs to say whether
// cross-instance cache invalidation is actually live, not just configured.
// Read-only, no side effects.
function cacheStatus() {
  const s = cacheBus.status();
  return { redisConfigured: s.configured, redisReady: s.ready };
}

module.exports = {
  WELL_KNOWN_FEATURE_KEYS,
  resolveTierKind,
  cacheStatus,
  hasFeature,
  planSummary,
  planVersion,
  planVersionIfCached,
  listFeatureCatalogDetailed,
  clearCache,
  clearAllCaches,
  nextTierUp,
  tierLabel,
  listFeatureCatalog,
  listTierFeatures,
  setTierFeatures,
};
