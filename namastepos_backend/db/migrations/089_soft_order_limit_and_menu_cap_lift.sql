-- 089 — stop gating on menu size, and make `monthly_orders` a SOFT limit.
--
-- ADDITIVE ONLY. Nothing is dropped, no column type changes, no data is lost.
-- Every plan change below either RAISES a limit or leaves it exactly as it is,
-- so no existing customer can lose anything by applying this. Prices and
-- feature keys are NOT touched.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY EACH LIMIT WRITE IS BOTH RE-RUNNABLE AND NON-LOWERING
-- ══════════════════════════════════════════════════════════════════════════
-- Every key is written through the same four-branch CASE:
--
--   WHEN the key is absent or JSON null  -> NULL  (jsonb_strip_nulls then drops
--        it from the patch, so an absent key STAYS absent. Absent means
--        "uncapped" to subscriptionService.enforceLimit, which is already more
--        permissive than any number we could write, so writing one would be a
--        DOWNGRADE, not an upgrade.)
--   WHEN the stored value is not an integer literal -> NULL (leave it alone
--        rather than crash the migration on data we did not expect)
--   WHEN the stored value is -1 (unlimited) -> -1 (unchanged)
--   ELSE GREATEST(stored, target)
--
-- GREATEST(stored, target) is a FIXED POINT: once applied, `stored` is already
-- >= target, so a second apply computes the identical value. That, plus
-- ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS below, is what makes
-- the whole file safe to apply twice — the second pass changes nothing.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. MENU SIZE IS THE WRONG THING TO GATE ON  (decision 3, 2026-09-04)
-- ══════════════════════════════════════════════════════════════════════════
-- The published ICP is cafes, QSRs and small restaurants carrying roughly
-- 40-80 dishes. The advertised Rs 299 entry plan capped the menu at 25 items,
-- so the plan physically could not hold the menu of the customer it was sold
-- to — and the wall landed DURING menu entry, i.e. before the owner had ever
-- printed a bill. That is the worst possible moment to meet a paywall (the
-- 2026-09-04 activation audit puts menu entry as the single largest drop).
--
-- Menu size measures SETUP EFFORT, not value received: a 60-dish stall and a
-- 60-dish restaurant get wildly different value from the product. Value gets
-- gated on orders, outlets, staff and features instead.
--
-- 200 orders/month on the free plan was the same mistake pointed the other
-- way: 6.6 bills a day is a sandbox, not a free plan.
--
--   plan (tier CODE)   metric           before -> after
--   -----------------  ---------------  -------------------
--   Starter  'free'     menu_items          10 -> 60
--                       monthly_orders     200 -> 500
--                       tables               2 -> 8
--   Growth   'basic'    menu_items          25 -> -1 (unlimited)
--                       monthly_orders    2000 -> 3000
--                       tables               6 -> 12
--                       staff                3 -> 5
--   Pro / Advanced / Enterprise            unchanged (already unlimited)
--
-- Rows are selected by tier CODE (`plans.tier`), which is UNIQUE, so each
-- statement touches exactly one row. NOTE the code/kind trap documented in
-- migration 088 and src/services/planTiers.js: `tier = 'pro'` is ENTERPRISE
-- and the plan actually named "Pro" is `tier = 'pro_plan'`. None of the three
-- unlimited plans is written here, so the trap cannot bite. Custom
-- per-customer plans (`custom-<hex>` codes, migration 074) are untouched.

-- Starter.
UPDATE plans p
   SET limits = p.limits || jsonb_strip_nulls(jsonb_build_object(
         'menu_items', CASE
             WHEN p.limits->>'menu_items' IS NULL              THEN NULL::int
             WHEN p.limits->>'menu_items' !~ '^-?[0-9]+$'      THEN NULL::int
             WHEN (p.limits->>'menu_items')::int = -1          THEN -1
             ELSE GREATEST((p.limits->>'menu_items')::int, 60) END,
         'monthly_orders', CASE
             WHEN p.limits->>'monthly_orders' IS NULL          THEN NULL::int
             WHEN p.limits->>'monthly_orders' !~ '^-?[0-9]+$'  THEN NULL::int
             WHEN (p.limits->>'monthly_orders')::int = -1      THEN -1
             ELSE GREATEST((p.limits->>'monthly_orders')::int, 500) END,
         'tables', CASE
             WHEN p.limits->>'tables' IS NULL                  THEN NULL::int
             WHEN p.limits->>'tables' !~ '^-?[0-9]+$'          THEN NULL::int
             WHEN (p.limits->>'tables')::int = -1              THEN -1
             ELSE GREATEST((p.limits->>'tables')::int, 8) END
       ))
 WHERE p.tier = 'free';

-- Growth. `menu_items` goes to -1 (unlimited) — the most permissive value
-- there is, so it can be set flat without ever lowering anything.
UPDATE plans p
   SET limits = p.limits || jsonb_strip_nulls(jsonb_build_object(
         'menu_items', CASE
             WHEN p.limits->>'menu_items' IS NULL              THEN NULL::int
             ELSE -1 END,
         'monthly_orders', CASE
             WHEN p.limits->>'monthly_orders' IS NULL          THEN NULL::int
             WHEN p.limits->>'monthly_orders' !~ '^-?[0-9]+$'  THEN NULL::int
             WHEN (p.limits->>'monthly_orders')::int = -1      THEN -1
             ELSE GREATEST((p.limits->>'monthly_orders')::int, 3000) END,
         'tables', CASE
             WHEN p.limits->>'tables' IS NULL                  THEN NULL::int
             WHEN p.limits->>'tables' !~ '^-?[0-9]+$'          THEN NULL::int
             WHEN (p.limits->>'tables')::int = -1              THEN -1
             ELSE GREATEST((p.limits->>'tables')::int, 12) END,
         'staff', CASE
             WHEN p.limits->>'staff' IS NULL                   THEN NULL::int
             WHEN p.limits->>'staff' !~ '^-?[0-9]+$'           THEN NULL::int
             WHEN (p.limits->>'staff')::int = -1               THEN -1
             ELSE GREATEST((p.limits->>'staff')::int, 5) END
       ))
 WHERE p.tier = 'basic';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. A POS MUST NEVER REFUSE A BILL  (decision 5, 2026-09-04)
-- ══════════════════════════════════════════════════════════════════════════
-- `POST /orders` used to 403 at `monthly_orders`. A restaurant that cannot
-- bill during dinner service uninstalls that evening: the revenue lost by
-- blocking dwarfs the revenue protected by blocking. So `monthly_orders`
-- becomes a SOFT limit — the bill is always accepted, the overage is recorded
-- in the columns below, and the owner is told (the existing 80% / 100%
-- warnings plus the existing deduped upsell task).
--
-- Every OTHER capped metric stays a HARD limit. Adding a dish, a staff login,
-- a table, a floor or an outlet is a CONFIGURATION action with no queue in
-- front of it, so refusing it is legitimate. The soft/hard classification is
-- DATA in exactly one place in the application — `METRIC_ENFORCEMENT` in
-- src/services/subscriptionService.js — and defaults to 'hard', so a metric
-- added later is refused rather than silently over-served.
--
-- The overage columns hang off `usage_counters`, which already holds exactly
-- one row per (business, metric, period). That makes recording an overage the
-- SAME write that increments the counter: one atomic upsert, no second table,
-- no read-modify-write race.

ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS soft_limit        INTEGER,
  ADD COLUMN IF NOT EXISTS overage_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_overage_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_overage_at   TIMESTAMPTZ;

COMMENT ON COLUMN usage_counters.soft_limit IS
  'The plan limit in force the last time this counter was incremented. Kept so '
  'an overage reads back exactly ("500 included, 618 billed") without having '
  'to guess which plan the tenant was on at the time. NULL = uncapped then.';
COMMENT ON COLUMN usage_counters.overage_count IS
  'Units accepted BEYOND soft_limit in this period. Only ever written for a '
  'metric classified soft (METRIC_ENFORCEMENT in subscriptionService.js) - a '
  'hard metric is refused instead of over-served, so it stays 0.';
COMMENT ON COLUMN usage_counters.first_overage_at IS
  'When this period first went past the included volume. Anchors the upsell '
  'conversation; NULL = never over.';
COMMENT ON COLUMN usage_counters.last_overage_at IS
  'Most recent over-limit unit in this period.';

-- The sales/support question is "who is over their included volume right
-- now", so index only the rows that are.
CREATE INDEX IF NOT EXISTS idx_usage_counters_overage
  ON usage_counters (period, metric)
  WHERE overage_count > 0;
