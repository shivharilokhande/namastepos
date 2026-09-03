-- 2026-09-03 — custom plans become "base plan + extras".
-- Founder semantics: a customer wants Growth (a real public plan) PLUS a few
-- features that aren't sold as addons. The custom plan therefore INHERITS a
-- base plan's features/limits and layers extras on top, so a later change to
-- the base plan still flows through.
--
-- `base_plan_tier` = the public plan this custom plan extends (NULL = standalone).
-- The extra keys themselves live in the existing (previously unused) legacy
-- `plans.features` JSONB as { "extraFeatureKeys": [...] } so no new table is
-- needed; `plan_features` still holds the EFFECTIVE (base ∪ extras) set that
-- featureService reads, so gating logic is untouched.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS base_plan_tier VARCHAR(40);

COMMENT ON COLUMN plans.base_plan_tier IS
  'For custom (is_public=false, business_id set) plans: the public plan tier this one extends. Effective features = base plan features UNION plans.features->extraFeatureKeys.';
