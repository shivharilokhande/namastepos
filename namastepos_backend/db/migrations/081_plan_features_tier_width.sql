-- 2026-09-03 — widen plan_features.tier_kind to match plans.tier.
--
-- Migration 040 repurposed this column to hold a PLAN TIER CODE (the name was
-- kept to avoid a rename), but it stayed VARCHAR(20) from its tier_kind days
-- while `plans.tier` became VARCHAR(40) in 039. That was invisible until the
-- custom-plan tier code grew from `custom-<8 hex>` to `custom-<32 hex>` (to
-- remove a ~1% collision risk at 10k tenants): the plan row inserts fine at
-- 39 chars, then writing its feature rows fails with
--   value too long for type character varying(20)
-- i.e. a custom plan could be created but never granted any features.
--
-- Widening is additive and lossless (no data can violate a larger limit).
ALTER TABLE plan_features
  ALTER COLUMN tier_kind TYPE VARCHAR(40);

COMMENT ON COLUMN plan_features.tier_kind IS
  'Plan TIER CODE (plans.tier) since migration 040 — not a tier_kind. Must stay as wide as plans.tier (VARCHAR(40)).';
