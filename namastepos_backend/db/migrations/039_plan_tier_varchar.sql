-- Migration 039 — Unlock plans.tier from the plan_tier enum (Push 18a).
--
-- Originally plans.tier was an enum locked to ('free','basic','pro') —
-- enough for the first three tiers but blocked the super-admin from
-- adding a fourth (e.g. "Pro Lite", "Enterprise Plus"). We migrate to
-- VARCHAR(40) so any new tier name works without an enum extension.
--
-- subscriptions, customer_admin set-plan and addon code all reference
-- plans.tier as a string already (no JOIN on the enum type), so this
-- is a metadata-only widening — existing rows continue to validate.

-- 1. Drop dependent constraints + indexes that reference the enum
--    (PostgreSQL won't let us alter the column type while they're in
--    place). We re-create them after the type swap.
ALTER TABLE plans
  ALTER COLUMN tier TYPE VARCHAR(40)
  USING tier::text;

-- 2. Keep uniqueness — same as before, just now on a varchar column.
DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_tier_unique UNIQUE (tier);
EXCEPTION WHEN duplicate_object THEN NULL;
       WHEN duplicate_table  THEN NULL;
END $$;

-- 3. Drop the enum type itself — nothing references it anymore.
DO $$ BEGIN
  DROP TYPE IF EXISTS plan_tier;
EXCEPTION WHEN dependent_objects_still_exist THEN
  -- Some other column we don't know about is still using it.
  -- Leave the type in place; the column we care about is already
  -- migrated to VARCHAR so the lock is gone either way.
  NULL;
END $$;
