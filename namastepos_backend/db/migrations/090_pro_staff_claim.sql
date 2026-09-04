-- 090 — the Pro plan advertised UNLIMITED STAFF while enforcing a cap of 10.
-- Remove the false FEATURE KEY. Do NOT raise the limit.
--
-- ADDITIVE-SAFE. No table, column, index, constraint or plan row is dropped
-- or altered. Exactly one row of `plan_features` is deleted, and it is a
-- marketing CLAIM row that gates nothing (see "WHAT THE KEY ACTUALLY DID"
-- below). Nobody loses a capability they had yesterday.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE CONTRADICTION (verified live 2026-09-05 against
--   GET https://api.namastepos.in/v1/public/plans)
-- ══════════════════════════════════════════════════════════════════════════
--   plan        tier CODE   limits.staff        featureKeys has staff_unlimited
--   ----------  ----------  ------------------  -------------------------------
--   Starter     free         1                  no
--   Growth      basic        5                  no
--   Pro         pro_plan    10                  YES   <-- the lie
--   Advanced    advanced    -1 (unlimited)      yes   (consistent)
--   Enterprise  pro         -1 (unlimited)      yes   (consistent)
--
-- `subscriptionService.enforceLimit('staff')` reads `plans.limits->>'staff'`
-- and nothing else. So on Pro the 11th staff login is REFUSED with a 403
-- PLAN_LIMIT while the pricing page and the plan's own feature list promise
-- unlimited staff. Advanced and Enterprise are internally consistent; only
-- Pro contradicted itself. Same bug class as the GST over-claim fixed on
-- 2026-09-04: the product promised a capability the plan does not carry.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY THE KEY WAS REMOVED AND NOT THE CAP RAISED  (decision 2026-09-05)
-- ══════════════════════════════════════════════════════════════════════════
-- DO NOT "restore" this row. Three reasons, in order of weight:
--
-- 1. The KEY grants nothing; the LIMIT is the enforcement. Nothing in the
--    backend reads `staff_unlimited` — grep it: the only other occurrence is
--    WELL_KNOWN_FEATURE_KEYS in src/services/featureService.js, which is the
--    admin picker's catalog, not a gate. No middleware, no route, no service
--    branches on it. It is a pure claim, and `limits.staff` is the truth. So
--    of the two contradictory statements, the removable one is the claim.
--
-- 2. The staff ladder is deliberate: 1 / 5 / 10 / unlimited / unlimited.
--    Raising Pro (Rs 799) to unlimited would hand Advanced's staff story to
--    the plan below it. Advanced still differs from Pro on accounting,
--    e-invoice, forecasting and 3 outlets, so it would survive — but staff
--    headcount is the differentiator an owner feels first, and giving it away
--    for Rs 200 less makes the whole ladder read as arbitrary.
--
-- 3. It is the honest direction. Removing a claim we do not honour cannot
--    hurt an existing customer; raising a cap we never sold sets a price
--    expectation we would have to defend for every plan below it too.
--
-- If the DECISION is ever genuinely reversed and Pro should carry unlimited
-- staff, the change is `plans.limits->>'staff' = -1` for tier 'pro_plan'
-- FIRST; re-adding this feature key alone only recreates the lie.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHICH ROW, AND WHY THE WRONG ONE IS SO EASY TO HIT
-- ══════════════════════════════════════════════════════════════════════════
-- `plan_features.tier_kind` is MISNAMED: since migration 040 it holds a plan
-- tier CODE (`plans.tier`), not a tier_kind. See the COMMENT migration 088
-- puts on that column. The codes collide with the kinds on the word "pro":
--
--   plan_features.tier_kind = 'pro_plan'  -> the Rs 799 plan named "Pro"  <-- TARGET
--   plan_features.tier_kind = 'pro'       -> the Rs 1,999 ENTERPRISE plan  DO NOT TOUCH
--   plan_features.tier_kind = 'advanced'  -> the Rs 999 Advanced plan      DO NOT TOUCH
--
-- Deleting the 'pro' row would strip unlimited staff from Enterprise, the
-- most expensive plan on the ladder, while leaving the actual lie in place.
-- For the Pro plan `tier` and `tier_kind` are BOTH 'pro_plan', so
-- featureService.listTierFeatures never takes its fallback branch for it and
-- the row set keyed 'pro_plan' is the ONLY source of Pro's feature keys.
-- Reproduced locally against all 90 migrations plus the live plan rows: the
-- feed's five featureKeys arrays are byte-identical to
-- listTierFeatures(tier, tier_kind), and Pro's `staff_unlimited` comes from
-- ('pro_plan', 'staff_unlimited') and nowhere else.
--
-- Custom per-customer plans (`custom-<32 hex>` codes, migration 074) are
-- deliberately NOT touched: their limits are hand-set per customer, so
-- `staff_unlimited` may be perfectly true on one. The read-only audit at the
-- bottom of this file NAMES any such plan that is self-contradictory instead
-- of guessing on its behalf.
--
-- ══════════════════════════════════════════════════════════════════════════
-- RE-RUNNABLE
-- ══════════════════════════════════════════════════════════════════════════
-- A `DELETE ... WHERE` is naturally idempotent: the second pass matches zero
-- rows and changes nothing. On a database where the Pro plan does not exist
-- yet (a fresh test/CI schema — no migration creates 'pro_plan'; the founder
-- created it through the admin plans editor) it is a no-op on both passes.

DO $$
DECLARE
  ent_before  BOOLEAN;  -- Enterprise (tier code 'pro')  keeps its grant
  adv_before  BOOLEAN;  -- Advanced   (tier code 'advanced') keeps its grant
  ent_after   BOOLEAN;
  adv_after   BOOLEAN;
  removed     INTEGER;
  offender    RECORD;
BEGIN
  SELECT EXISTS (SELECT 1 FROM plan_features
                  WHERE tier_kind = 'pro' AND feature_key = 'staff_unlimited')
    INTO ent_before;
  SELECT EXISTS (SELECT 1 FROM plan_features
                  WHERE tier_kind = 'advanced' AND feature_key = 'staff_unlimited')
    INTO adv_before;

  -- ── THE FIX ────────────────────────────────────────────────────────────
  -- One row. Equality on the tier CODE, so the two neighbours that legitimately
  -- carry the key are unreachable by construction; the two redundant
  -- inequalities below are belt-and-braces for whoever edits this line next.
  DELETE FROM plan_features
   WHERE tier_kind = 'pro_plan'
     AND tier_kind <> 'pro'            -- never Enterprise (Rs 1,999)
     AND tier_kind <> 'advanced'       -- never Advanced   (Rs 999)
     AND feature_key = 'staff_unlimited';
  GET DIAGNOSTICS removed = ROW_COUNT;

  -- ── THE GUARD ──────────────────────────────────────────────────────────
  -- Prove the two unlimited-staff plans are untouched. The migration runner
  -- wraps each file in one transaction (scripts/migrate.js), so raising here
  -- rolls the DELETE back rather than shipping a half-applied claim change.
  SELECT EXISTS (SELECT 1 FROM plan_features
                  WHERE tier_kind = 'pro' AND feature_key = 'staff_unlimited')
    INTO ent_after;
  SELECT EXISTS (SELECT 1 FROM plan_features
                  WHERE tier_kind = 'advanced' AND feature_key = 'staff_unlimited')
    INTO adv_after;

  IF ent_before IS DISTINCT FROM ent_after THEN
    RAISE EXCEPTION 'migration 090 changed the staff_unlimited grant on tier '
                    'code ''pro'' (ENTERPRISE, Rs 1,999). Refusing to apply.';
  END IF;
  IF adv_before IS DISTINCT FROM adv_after THEN
    RAISE EXCEPTION 'migration 090 changed the staff_unlimited grant on tier '
                    'code ''advanced'' (Rs 999). Refusing to apply.';
  END IF;
  IF EXISTS (SELECT 1 FROM plan_features
              WHERE tier_kind = 'pro_plan' AND feature_key = 'staff_unlimited') THEN
    RAISE EXCEPTION 'migration 090 did not remove the staff_unlimited grant '
                    'from tier code ''pro_plan''.';
  END IF;

  RAISE NOTICE '090: removed % staff_unlimited grant(s) from tier code '
               '''pro_plan'' (the Rs 799 Pro plan, limits.staff = 10)', removed;

  -- ── READ-ONLY AUDIT: the same contradiction anywhere else ──────────────
  -- Reports, never writes. A plan that caps staff at a finite positive number
  -- while granting `staff_unlimited` is making the claim Pro just stopped
  -- making. Custom per-customer plans land here rather than being edited
  -- blind, because their caps are set by hand for one customer.
  FOR offender IN
    SELECT p.tier, p.name, (p.limits->>'staff') AS staff_limit
      FROM plans p
      JOIN plan_features pf ON pf.tier_kind = p.tier
     WHERE pf.feature_key = 'staff_unlimited'
       AND p.limits->>'staff' ~ '^[0-9]+$'      -- finite and non-negative
       AND (p.limits->>'staff')::int >= 0       -- i.e. NOT -1 (unlimited)
     ORDER BY p.tier
  LOOP
    RAISE NOTICE '090 AUDIT: plan % (%) still grants staff_unlimited but caps '
                 'staff at % - review it (not changed by this migration)',
                 offender.tier, offender.name, offender.staff_limit;
  END LOOP;
END $$;
