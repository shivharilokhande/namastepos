-- 088 — plan tier code/kind ambiguity: document it in the schema, and stop
-- the addons CHECK constraint from rejecting two of the five live tier kinds.
--
-- ADDITIVE ONLY. No table, column, index or data is dropped. The one
-- constraint replaced below is swapped for a STRICTLY MORE PERMISSIVE version
-- of itself, so no existing row can fail it and nothing is lost.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM THIS DOCUMENTS
-- ══════════════════════════════════════════════════════════════════════════
-- There are TWO tier namespaces and they collide on the word "pro":
--
--   name        | plans.tier (CODE) | plans.tier_kind (KIND) | price
--   ------------|-------------------|------------------------|-----------
--   Starter     | free              | starter                | Rs 0
--   Growth      | basic             | pro                    | Rs 299
--   Pro         | pro_plan          | pro_plan               | Rs 799
--   Advanced    | advanced          | advanced               | Rs 999
--   Enterprise  | pro               | enterprise             | Rs 1,999
--
-- So `tier = 'pro'` is ENTERPRISE and `tier_kind = 'pro'` is GROWTH, while
-- the plan actually named "Pro" is 'pro_plan' in both columns. Codes are
-- historical and are NOT being renamed (see the migration note at the bottom
-- for why). The application-side source of truth for kinds and their rank is
-- src/services/planTiers.js — validators, addon eligibility and the upsell
-- ladder all derive from it.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. Widen chk_addons_required_tier_kind to the full ladder.
-- ══════════════════════════════════════════════════════════════════════════
-- Migration 078 added CHECK (... IN ('starter','pro','enterprise')) — the
-- three-kind ladder of the day. The live ladder has five, so an addon could
-- never be gated at Pro or Advanced level: the INSERT/UPDATE would fail with
-- a check violation. Same stale-list bug as the Joi schemas fixed alongside
-- this migration. Widening is lossless; the constraint stays NOT VALID so
-- pre-existing rows are not re-scanned.
DO $$ BEGIN
  ALTER TABLE addons DROP CONSTRAINT IF EXISTS chk_addons_required_tier_kind;
  ALTER TABLE addons
    ADD CONSTRAINT chk_addons_required_tier_kind
    CHECK (required_tier_kind IS NULL
           OR required_tier_kind IN ('starter', 'pro', 'pro_plan',
                                     'advanced', 'enterprise'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN addons.required_tier_kind IS
  'Minimum plans.tier_kind (a KIND, never a plans.tier code) required to buy '
  'this addon. Ranked by src/services/planTiers.js TIER_KIND_LADDER: '
  'starter < pro < pro_plan < advanced < enterprise. Keep this CHECK in step '
  'with that array.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. State the code-vs-kind mapping on the columns themselves, so the next
--    person reading psql \d+ plans cannot misread 'pro'.
-- ══════════════════════════════════════════════════════════════════════════
COMMENT ON COLUMN plans.tier IS
  'Plan tier CODE. Unique, opaque identifier - it does NOT match the plan '
  'name. Live mapping (code -> name): free -> Starter, basic -> Growth, '
  'pro_plan -> Pro, advanced -> Advanced, pro -> Enterprise. NOTE that '
  'tier = ''pro'' is ENTERPRISE. Custom per-customer plans use '
  '''custom-<32 hex>''. Codes are load-bearing strings referenced by '
  'plan_features.tier_kind, plans.base_plan_tier, addons.required_plan_tier '
  'and Razorpay plan metadata - do not rename them in place.';

COMMENT ON COLUMN plans.tier_kind IS
  'Plan tier KIND - position on the upgrade ladder, and the ONLY axis that '
  'entitlement/eligibility compares. Live values in rank order: starter < '
  'pro < pro_plan < advanced < enterprise. NOTE that tier_kind = ''pro'' is '
  'the GROWTH plan (Rs 299), not the plan named Pro (that is ''pro_plan''). '
  'Source of truth for the ladder and its rank: '
  'src/services/planTiers.js TIER_KIND_LADDER.';

-- plan_features.tier_kind already carries a COMMENT from migration 081
-- saying it holds a plan tier CODE. Restated here with the collision spelled
-- out, since this is the column that surprises people most.
COMMENT ON COLUMN plan_features.tier_kind IS
  'MISNAMED: holds a plan tier CODE (plans.tier), not a tier_kind, since '
  'migration 040 moved features from per-kind to per-plan. So the row set '
  'keyed ''pro'' here belongs to the ENTERPRISE plan. The legacy per-kind '
  'rows (starter/pro/enterprise, written by migration 031) are still present '
  'as a fallback for a plan with no per-plan rows - see '
  'featureService.listTierFeatures. Must stay as wide as plans.tier '
  '(VARCHAR(40)).';

-- ══════════════════════════════════════════════════════════════════════════
-- WHY THE CODES ARE NOT BEING RENAMED (asked 2026-09-04)
-- ══════════════════════════════════════════════════════════════════════════
-- Renaming pro -> enterprise_plan and basic -> growth so codes match names
-- was considered and rejected. plans.tier is a STRING KEY, not a label:
--   * plan_features.tier_kind stores it (every feature row for every plan)
--   * plans.base_plan_tier stores it (custom plans' base)
--   * addons.required_plan_tier stores it (legacy column, still read)
--   * Razorpay plan/subscription notes carry it, and Razorpay plans are
--     immutable - a rename cannot be replayed at the gateway
--   * admin/dashboard/mobile clients round-trip it in change-plan calls, and
--     mobile clients are versions we do not control
-- The rename buys readability only, and the code-vs-kind distinction it is
-- meant to clarify would still exist (kinds would still need their own
-- ladder). subscriptions.plan_id is a UUID FK, so a rename would not corrupt
-- a live subscription directly - but a half-updated client or an unreplayed
-- Razorpay note would. Documented instead of renamed.
