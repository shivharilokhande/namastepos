-- Migration 040 — Per-plan feature assignment (Push 18b).
--
-- Until now `plan_features` was keyed by `tier_kind` (starter / pro /
-- enterprise), meaning every plan that shared a tier_kind shared the
-- exact same feature set. The super-admin couldn't ship a fourth plan
-- (e.g. "Advanced") with its own distinct set — it just inherited
-- whichever tier_kind it was tagged with.
--
-- Push 18b moves feature ownership down to the plan itself. The
-- existing column name `tier_kind` is kept (no schema rename to avoid
-- breaking call sites) but it now logically holds the **plan's tier
-- code** (free / basic / pro / advanced / …) — not the tier_kind concept.
--
-- For every plan, we copy its current tier_kind's feature set into a
-- new set of rows keyed by plan.tier. This way the four existing plans
-- keep ALL their currently-enabled features; the super-admin can then
-- edit each one independently via the new per-plan picker.

-- 1. For every plan, copy features from its tier_kind defaults to be
--    keyed by the plan's own tier code. No-op for plans where
--    tier == tier_kind (e.g. tier='pro' tier_kind='pro').
INSERT INTO plan_features (tier_kind, feature_key)
SELECT p.tier, pf.feature_key
  FROM plans p
  JOIN plan_features pf ON pf.tier_kind = p.tier_kind
 WHERE p.tier <> p.tier_kind
ON CONFLICT (tier_kind, feature_key) DO NOTHING;

-- 2. The original tier_kind-keyed rows (starter/pro/enterprise) are
--    safe to leave in place — featureService now looks up by plan.tier
--    so the legacy rows are simply unused. We do NOT delete them: if
--    super-admin re-tags a plan's tier_kind, the legacy rows can serve
--    as a fallback default. (See featureService.featuresFor.)
