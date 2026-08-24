// NamastePOS — Per-business feature flag overrides (FF-315).
//
// Base features come from `plans.features` (per-tier) + the addons
// system. This service layers **overrides** on top so we can flip a
// single feature on for a single business without changing their
// plan. Used to dark-launch risky features to 5 friendly cafes
// before opening to the full base.
//
// Precedence (highest wins):
//   business_feature_overrides.enabled  → forces the value
//   plan_features + active addons       → the default
//
// Read via `resolve(businessId, featureKey)` — returns bool. Write
// via `override()` from the super-admin panel only.

const { query } = require('../config/db');
const featureService = require('./featureService');

async function resolve(businessId, featureKey) {
  const override = await query(
    `SELECT enabled FROM business_feature_overrides
      WHERE business_id = $1 AND feature_key = $2 LIMIT 1`,
    [businessId, featureKey]
  );
  if (override.rowCount > 0) return override.rows[0].enabled;
  // Fall through to the base plan/addon check.
  const plan = await featureService.planSummary(businessId).catch(() => null);
  if (!plan) return false;
  return Boolean(plan.features?.[featureKey]);
}

async function override(businessId, featureKey, enabled, { reason, adminId } = {}) {
  await query(
    `INSERT INTO business_feature_overrides
       (business_id, feature_key, enabled, reason, set_by_admin)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, feature_key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           reason  = EXCLUDED.reason,
           set_by_admin = EXCLUDED.set_by_admin,
           set_at = NOW()`,
    [businessId, featureKey, enabled, reason || null, adminId || null]
  );
}

async function list(businessId) {
  const r = await query(
    `SELECT feature_key, enabled, reason, set_at
       FROM business_feature_overrides
      WHERE business_id = $1
      ORDER BY set_at DESC`,
    [businessId]
  );
  return r.rows;
}

async function remove(businessId, featureKey) {
  await query(
    `DELETE FROM business_feature_overrides
      WHERE business_id = $1 AND feature_key = $2`,
    [businessId, featureKey]
  );
}

module.exports = { resolve, override, list, remove };
