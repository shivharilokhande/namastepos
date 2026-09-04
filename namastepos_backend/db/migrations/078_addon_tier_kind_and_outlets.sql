-- 2026-09-03 — two fixes.
--
-- 1. ADDON ELIGIBILITY BUG (founder-reported): the multi-outlet addon requires
--    "pro", but it was being sold to Growth-plan tenants. Cause: the gate read
--    `addons.required_plan_tier` (a legacy plan_tier ENUM value: free/basic/pro)
--    and then looked it up as a PLAN TIER CODE — and in the live 5-tier config a
--    plan literally has the code 'pro'. So "requires pro" resolved to that one
--    plan row, and the comparison used ITS tier_kind + price, which a mid-tier
--    plan could satisfy. The canonical scale is tier_kind (starter<pro<
--    enterprise), so store the requirement in those terms, explicitly.
ALTER TABLE addons ADD COLUMN IF NOT EXISTS required_tier_kind VARCHAR(20);

-- Backfill. Order matters: interpret the stored value as a TIER KIND first
-- (that is what "requires pro" always meant), and only fall back to resolving
-- it as a plan tier code for genuinely custom values.
UPDATE addons a
   SET required_tier_kind = CASE
     WHEN a.required_plan_tier::text IN ('starter', 'pro', 'enterprise')
       THEN a.required_plan_tier::text
     WHEN a.required_plan_tier::text IN ('free', 'basic')
       THEN 'starter'
     ELSE (SELECT p.tier_kind FROM plans p
             WHERE p.tier = a.required_plan_tier::text
             LIMIT 1)
   END
 WHERE a.required_plan_tier IS NOT NULL
   AND a.required_tier_kind IS NULL;

-- Explicit: multi-outlet is a Pro-and-above capability.
UPDATE addons SET required_tier_kind = 'pro'
 WHERE slug = 'multi-outlet' AND required_tier_kind IS NULL;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard it: a manual replay
-- of this file must not fail on an already-present constraint.
DO $$ BEGIN
  ALTER TABLE addons
    ADD CONSTRAINT chk_addons_required_tier_kind
    CHECK (required_tier_kind IS NULL
           OR required_tier_kind IN ('starter', 'pro', 'enterprise'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. OUTLETS AS FIRST-CLASS TENANTS. Each outlet already IS its own
--    `businesses` row joined by `businesses.outlet_group_id` (migration 025),
--    which is what keeps orders/menu/staff/settings/reports physically
--    separate — nothing is shared but the group rollup. What was missing was
--    provisioning (only "attach an existing business" existed) and a label to
--    show in the switcher.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS outlet_label VARCHAR(80);

COMMENT ON COLUMN businesses.outlet_label IS
  'Short branch name shown in the tenant outlet switcher (e.g. "Andheri West"). NULL = use businesses.name.';
