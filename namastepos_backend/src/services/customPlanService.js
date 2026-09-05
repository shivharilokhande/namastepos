// NamastePOS — per-customer custom plans (2026-09-03).
//
// A custom plan is a normal `plans` row with:
//   tier        = 'custom-<first-8-of-businessId>'  (stable, unique per tenant)
//   is_public   = FALSE   (never appears on /v1/plans public, /v1/public/plans,
//                          the landing feed, or another tenant's plan list)
//   business_id = <the tenant>  (their own /v1/plans call includes it)
//
// Features ride the existing plan_features matrix keyed by the plan's tier
// code (Push 18b semantics), so featureService / featureGate need zero new
// logic. Razorpay plan ids are minted at create/update time via
// razorpayService.syncOnePlan (the bulk syncPlans skips non-public rows).
// Assignment reuses customerAdminService.setPlanManually so the staff-cap
// prune + cache invalidation behave exactly like the admin Set-Plan button.

const { query } = require('../config/db');
const { NotFound, Conflict } = require('../utils/errors');
const sub = require('./subscriptionService');
const features = require('./featureService');
// Ordered tier-kind ladder + rank helpers. Single source of truth — read the
// header of that file before touching anything tier-related.
const planTiers = require('./planTiers');
const logger = require('../config/logger');

/**
 * Tier code for a business's private plan.
 *
 * Was the first 8 hex chars of the UUID — 32 bits, so ~1% chance of a
 * collision by 10k tenants, and the upsert is `ON CONFLICT (tier) DO UPDATE`,
 * which on a collision would silently hand one tenant another's bespoke
 * pricing and feature set. Use the full UUID (hyphens stripped) instead: the
 * `tier` column is VARCHAR(40) since migration 039 and 'custom-' + 32 chars =
 * 39, so it fits exactly and can never collide.
 */
function customTierFor(businessId) {
  return `custom-${String(businessId).replace(/-/g, '')}`;
}

/**
 * The legacy 8-char form, kept ONLY so plans created before 2026-09-03 are
 * still found. New plans always use the full-UUID form above.
 */
function legacyCustomTierFor(businessId) {
  return `custom-${String(businessId).replace(/-/g, '').slice(0, 8)}`;
}

async function _planRowFor(businessId) {
  const r = await query(
    'SELECT * FROM plans WHERE business_id = $1 LIMIT 1',
    [businessId],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

/**
 * 2026-09-03 — custom plans are "base plan + extras".
 * The EFFECTIVE feature set (what plan_features holds and gating reads) is
 * base-plan features ∪ extras. We also return the two halves separately so
 * the admin editor can show inherited keys as locked and extras as editable.
 */
async function _basePlanRow(baseTier) {
  if (!baseTier) return null;
  const r = await query(
    'SELECT * FROM plans WHERE tier = $1 AND is_public = TRUE LIMIT 1',
    [baseTier],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

/** Features a base plan grants (empty when standalone). */
async function _baseFeatureKeys(baseTier) {
  const base = await _basePlanRow(baseTier);
  if (!base) return [];
  return features.listTierFeatures(base.tier, base.tier_kind);
}

function _extrasOf(row) {
  const raw = row.features;
  const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  return Array.isArray(obj.extraFeatureKeys) ? obj.extraFeatureKeys : [];
}

async function _serializeWithFeatures(row) {
  const plan = sub.serializePlan(row);
  plan.basePlanTier = row.base_plan_tier || null;
  plan.extraFeatureKeys = _extrasOf(row);
  plan.inheritedFeatureKeys = await _baseFeatureKeys(row.base_plan_tier);
  // Effective = what gating actually enforces (persisted in plan_features).
  plan.featureKeys = await features.listTierFeatures(row.tier, row.tier_kind);
  return plan;
}

/** The tenant's custom plan (+featureKeys +assigned flag), or null. */
async function getForBusiness(businessId) {
  const row = await _planRowFor(businessId);
  if (!row) return null;
  const assignedQ = await query(
    'SELECT 1 FROM subscriptions WHERE business_id = $1 AND plan_id = $2 LIMIT 1',
    [businessId, row.id],
  );
  const plan = await _serializeWithFeatures(row);
  plan.assigned = assignedQ.rowCount > 0;
  return plan;
}

/**
 * Create or update the tenant's custom plan.
 * body: { name, priceInrPaise, priceYearlyPaise|null, limits, featureKeys,
 *         tierKind, assign }
 */
async function upsertForBusiness(businessId, body) {
  const biz = await query(
    'SELECT id FROM businesses WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [businessId],
  );
  if (biz.rowCount === 0) throw new NotFound('Customer not found');

  // Keep an EXISTING plan's tier code (a pre-2026-09-03 row uses the short
  // form). The upsert conflicts on `tier`, so minting the new full-UUID code
  // for a business that already has a short-coded plan would create a SECOND
  // plan row for the same tenant and _planRowFor could then pick either.
  const existing = await _planRowFor(businessId);
  const tier = existing?.tier || customTierFor(businessId);

  // ── Base plan (e.g. "growth") + extras ────────────────────────────────
  // basePlanTier must be a PUBLIC plan; extras are the keys the customer
  // asked for that no addon sells. Legacy callers may still send a flat
  // featureKeys[] — treat those as extras with no base.
  const baseTier = body.basePlanTier || null;
  const base = await _basePlanRow(baseTier);
  if (baseTier && !base) throw new NotFound(`Base plan '${baseTier}' not found or not public`);
  // 2026-09-05 (entitlements review F1): reject unknown keys BEFORE any row is
  // written. Until now a typo'd extra went straight into plan_features (via
  // setTierFeatures below, which this service calls directly, bypassing the
  // admin controller's check) and surfaced in the console as an
  // `unregistered` grant. Same helper, same 400, as the plan matrix editor.
  const extras = await features.assertKnownFeatureKeys(
    (body.extraFeatureKeys || body.featureKeys || []).filter(Boolean),
    { what: 'custom plan feature key(s)' },
  );
  const inherited = base ? await features.listTierFeatures(base.tier, base.tier_kind) : [];
  const effective = Array.from(new Set([...inherited, ...extras]));

  // Price/limits/tierKind default to the base plan's when not overridden, so
  // "Growth + 2 features" needs only the extras typed in.
  const priceInr = body.priceInrPaise !== undefined && body.priceInrPaise !== null
    ? body.priceInrPaise
    : (base ? base.price_inr_paise : 0);
  const yearly = body.priceYearlyPaise !== undefined
    ? body.priceYearlyPaise
    : (base ? base.price_yearly_paise : null);
  // Standalone (no base plan) MUST state a tierKind — putCustomPlanBody's
  // .custom() rule enforces that, so this last fallback is only reachable
  // from an internal caller that skipped validation. It was a literal 'pro',
  // which silently granted Growth-level addon eligibility to a bespoke plan;
  // fail closed at the bottom of the ladder instead.
  const tierKind = body.tierKind
    || (base ? base.tier_kind : planTiers.FALLBACK_TIER_KIND);
  const baseLimits = base
    ? (typeof base.limits === 'string' ? JSON.parse(base.limits || '{}') : (base.limits || {}))
    : {};
  // Explicit custom limits win; anything omitted inherits the base plan's.
  const limits = { ...baseLimits, ...(body.limits || {}) };

  const r = await query(
    `INSERT INTO plans
       (tier, tier_kind, name, price_inr_paise, price_yearly_paise,
        billing_period, is_active, limits, features, is_public, business_id,
        base_plan_tier)
     VALUES ($1, $2, $3, $4, $5, 'monthly', TRUE, $6, $7, FALSE, $8, $9)
     ON CONFLICT (tier) DO UPDATE
       SET tier_kind = EXCLUDED.tier_kind,
           name = EXCLUDED.name,
           price_inr_paise = EXCLUDED.price_inr_paise,
           price_yearly_paise = EXCLUDED.price_yearly_paise,
           is_active = TRUE,
           limits = EXCLUDED.limits,
           features = EXCLUDED.features,
           is_public = FALSE,
           business_id = EXCLUDED.business_id,
           base_plan_tier = EXCLUDED.base_plan_tier
     RETURNING *`,
    [tier, tierKind, body.name, priceInr, yearly,
      JSON.stringify(limits), JSON.stringify({ extraFeatureKeys: extras }),
      businessId, baseTier],
  );
  const row = r.rows[0];

  // Persist the EFFECTIVE set (base ∪ extras) — gating reads plan_features,
  // so inheritance is resolved once here rather than on every request.
  // setTierFeatures also clears all feature caches.
  await features.setTierFeatures(tier, effective);

  // Mint/refresh Razorpay plan ids when priced (best-effort — a gateway
  // hiccup must not lose the admin's save; retry happens on next update).
  if (row.price_inr_paise > 0) {
    try {
      await require('./razorpayService').syncOnePlan(row.id);
    } catch (e) {
      logger.warn(`[custom-plan] Razorpay sync failed for ${tier}: ${e.message}`);
    }
  }

  let subscription = null;
  if (body.assign === true) {
    // Reuse the admin set-plan path: rolls the period forward, prunes
    // over-limit staff, clears the tenant's feature cache.
    subscription = await require('./customerAdminService')
      .setPlanManually(businessId, tier, { billingPeriod: 'monthly' });
  } else {
    try { features.clearCache(businessId); } catch (_) { /* non-fatal */ }
  }

  // Re-read so razorpay ids minted above are reflected.
  const fresh = await query('SELECT * FROM plans WHERE id = $1', [row.id]);
  const plan = await _serializeWithFeatures(fresh.rows[0]);
  plan.assigned = !!subscription
    || (await query(
      'SELECT 1 FROM subscriptions WHERE business_id = $1 AND plan_id = $2 LIMIT 1',
      [businessId, row.id],
    )).rowCount > 0;
  return { plan, subscription };
}

/**
 * Delete the tenant's custom plan.
 * 409 while assigned — unless { force: true }, which first moves the customer
 * back to the plan the custom one extended (base plan) or 'free', so the admin
 * can remove a custom plan in one click without stranding the tenant.
 */
async function removeForBusiness(businessId, { force = false } = {}) {
  const row = await _planRowFor(businessId);
  if (!row) throw new NotFound('No custom plan for this customer');
  let movedTo = null;
  if (force) {
    const fallback = row.base_plan_tier || planTiers.FALLBACK_PLAN_CODE;
    movedTo = fallback;
    await require('./customerAdminService')
      .setPlanManually(businessId, fallback, { billingPeriod: 'monthly' });
  }
  const used = await query(
    'SELECT COUNT(*)::int AS c FROM subscriptions WHERE plan_id = $1',
    [row.id],
  );
  if (used.rows[0].c > 0) {
    const err = new Conflict(
      'Custom plan is assigned to the customer\'s subscription. Move them to another plan first.',
    );
    err.code = 'CUSTOM_PLAN_ASSIGNED';
    throw err;
  }
  // NOT a typo: plan_features.tier_kind holds a plan tier CODE since
  // migration 040 (see services/planTiers.js). row.tier is the right value.
  await query('DELETE FROM plan_features WHERE tier_kind = $1', [row.tier]);
  await query('DELETE FROM plans WHERE id = $1', [row.id]);
  try { features.clearAllCaches(); } catch (_) { /* non-fatal */ }
  return { deleted: true, tier: row.tier, movedTo };
}

module.exports = {
  customTierFor,
  legacyCustomTierFor,
  getForBusiness,
  upsertForBusiness,
  removeForBusiness,
};
