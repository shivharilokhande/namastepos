// NamastePOS — Per-business feature flag overrides (FF-315).
//
// Base features come from the plan_features matrix + the addons system
// (including addons.grants_features). This service layers **overrides**
// on top so we can flip a single feature on/off for a single business
// without changing their plan. Used to dark-launch risky features to 5
// friendly cafes before opening to the full base, or to comp/kill one
// feature for one tenant.
//
// 2026-09-03 (plans/addons audit #1): the overrides are now actually
// ENFORCED — featureService._load merges business_feature_overrides after
// the plan+addon merge (enabled=TRUE adds the key, FALSE removes it), so
// requireFeature / featureGate / /auth/me all respect them. The old
// `resolve()` helper here was dead code AND buggy (it indexed the
// planSummary features ARRAY as a map, so it always returned false for
// plan features) — deleted; use featureService.hasFeature instead.
//
// Every write invalidates the per-business feature cache so the change is
// live on the next request instead of after the 60s TTL.

const { query, withTransaction } = require('../config/db');
const featureService = require('./featureService');

// 2026-09-05 (entitlements review F1): both write paths reject keys the
// product does not know about, through the SAME helper the plan matrix editor
// uses. An override on an unknown key is a comp that delivers nothing (or a
// kill that kills nothing), shown in the console as if it worked. 400 with the
// offending keys listed in details.unknownFeatureKeys.
async function override(businessId, featureKey, enabled, { reason, adminId } = {}) {
  await featureService.assertKnownFeatureKeys([featureKey], { what: 'feature override key(s)' });
  await query(
    `INSERT INTO business_feature_overrides
       (business_id, feature_key, enabled, reason, set_by_admin)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, feature_key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           reason  = EXCLUDED.reason,
           set_by_admin = EXCLUDED.set_by_admin,
           set_at = NOW()`,
    [businessId, featureKey, enabled, reason || null, adminId || null],
  );
  featureService.clearCache(businessId);
}

/**
 * Replace the tenant's whole override set in one transaction.
 * `overrides` is [{ featureKey, mode: 'enable'|'disable', reason? }].
 */
async function replaceAll(businessId, overrides, { adminId } = {}) {
  const rows = (overrides || []).filter((o) => o && o.featureKey);
  await featureService.assertKnownFeatureKeys(
    rows.map((o) => o.featureKey),
    { what: 'feature override key(s)' },
  );
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM business_feature_overrides WHERE business_id = $1',
      [businessId],
    );
    for (const o of rows) {
      await client.query(
        `INSERT INTO business_feature_overrides
           (business_id, feature_key, enabled, reason, set_by_admin)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id, feature_key) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               reason  = EXCLUDED.reason,
               set_by_admin = EXCLUDED.set_by_admin,
               set_at = NOW()`,
        [businessId, o.featureKey, o.mode === 'enable',
          o.reason || null, adminId || null],
      );
    }
  });
  featureService.clearCache(businessId);
  return list(businessId);
}

async function list(businessId) {
  const r = await query(
    `SELECT feature_key, enabled, reason, set_at
       FROM business_feature_overrides
      WHERE business_id = $1
      ORDER BY set_at DESC`,
    [businessId],
  );
  return r.rows.map((row) => ({
    featureKey: row.feature_key,
    feature_key: row.feature_key, // back-compat: pre-2026-09-03 raw-row shape
    mode: row.enabled ? 'enable' : 'disable',
    enabled: row.enabled,
    reason: row.reason,
    setAt: row.set_at,
    set_at: row.set_at,
  }));
}

async function remove(businessId, featureKey) {
  await query(
    `DELETE FROM business_feature_overrides
      WHERE business_id = $1 AND feature_key = $2`,
    [businessId, featureKey],
  );
  featureService.clearCache(businessId);
}

module.exports = { override, replaceAll, list, remove };
