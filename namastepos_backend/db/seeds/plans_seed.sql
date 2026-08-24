-- Live Razorpay plan-ID seed (referenced by DEPLOY_READY.md §4).
--
-- Plans themselves are created by migrations 031/034/047 — this file only
-- attaches the LIVE Razorpay plan IDs after you've completed KYC and
-- created the plans at https://dashboard.razorpay.com > Subscriptions >
-- Plans.
--
-- Hardcode-audit fix (2026-08-24): the ids are now psql variables with a
-- guard, so running the file as-is FAILS instead of silently writing
-- bogus 'plan_REPLACE_ME_*' ids into production.
--
-- Usage:
--   psql "$DATABASE_URL" \
--     -v pro_monthly="'plan_XXXXXXXXXXXX'" \
--     -v pro_yearly="'plan_XXXXXXXXXXXX'" \
--     -v ent_monthly="'plan_XXXXXXXXXXXX'" \
--     -v ent_yearly="'plan_XXXXXXXXXXXX'" \
--     -f db/seeds/plans_seed.sql
--
-- Starter is trial-only (₹0) — it has NO Razorpay plan and NO yearly
-- variant. Do not add one.

-- Guard: refuse placeholder / empty ids.
DO $$
BEGIN
  IF :'pro_monthly' LIKE '%REPLACE%' OR :'pro_monthly' = '' THEN
    RAISE EXCEPTION 'Pass real Razorpay plan ids via -v (see header comment)';
  END IF;
END $$;

UPDATE plans
   SET razorpay_plan_id        = :'pro_monthly',
       razorpay_plan_id_yearly = :'pro_yearly'
 WHERE tier_kind = 'pro';

UPDATE plans
   SET razorpay_plan_id        = :'ent_monthly',
       razorpay_plan_id_yearly = :'ent_yearly'
 WHERE tier_kind = 'enterprise';

-- Sanity check — every paid plan should now have a live id:
SELECT name, tier_kind, razorpay_plan_id, razorpay_plan_id_yearly
  FROM plans
 WHERE tier_kind <> 'starter';
