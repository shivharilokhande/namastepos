-- 087 — trial-on-the-chosen-plan + past_due grace window
--
-- ADDITIVE ONLY. No drops, no type changes, no data loss.
--
-- Three problems this supports:
--
-- 1. The 7-day trial used to be provisioned against the Starter (`tier='free'`)
--    plan, so a prospect who clicked "Start free trial" on the Pro card got
--    Starter's caps (10 menu items, 200 orders) and never saw the product they
--    would pay for. The trial now provisions the plan the signup actually
--    chose. `trial_plan_id` records WHICH plan was trialled so the expiry
--    downgrade can name it ("your Pro trial ended") and so the upgrade CTA can
--    offer exactly the plan they already used.
--
-- 2. Trial expiry used to be a SILENT fallback: featureService just resolved to
--    starter once `trial_ends_at` passed, while the subscription row still
--    pointed at the trialled plan. `trial_downgraded_at` makes the downgrade an
--    explicit, recorded event (written by the nightly sweep in cronWorker).
--
-- 3. `past_due` stripped feature access the instant a charge failed, while the
--    dunning emails were still in flight. `past_due_at` anchors a grace window
--    (PAST_DUE_GRACE_DAYS, default 7) to the FIRST failure — deliberately not
--    to `last_dunning_at`, which every retry bumps forward and would therefore
--    extend the grace indefinitely.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_plan_id        UUID REFERENCES plans(id),
  ADD COLUMN IF NOT EXISTS trial_downgraded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS past_due_at          TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.trial_plan_id IS
  'Plan the 7-day trial was provisioned on. Set at signup; kept after the '
  'expiry downgrade so we can say what lapsed and re-offer it.';
COMMENT ON COLUMN subscriptions.trial_downgraded_at IS
  'When the explicit trial-expiry downgrade ran (cronWorker nightly sweep). '
  'NULL = never downgraded.';
COMMENT ON COLUMN subscriptions.past_due_at IS
  'First transition into past_due. Anchors the feature grace window; NOT '
  'bumped by dunning retries.';

-- Backfill the grace anchor for anything ALREADY past_due so the rollout does
-- not hand a fresh 7 days to an account that has been failing for weeks.
-- last_dunning_at is when we last told them; updated_at is the fallback.
UPDATE subscriptions
   SET past_due_at = COALESCE(last_dunning_at, updated_at, created_at)
 WHERE status = 'past_due'
   AND past_due_at IS NULL;

-- Grace + trial-expiry sweeps both scan by (status, timestamp).
CREATE INDEX IF NOT EXISTS idx_subscriptions_past_due_at
  ON subscriptions (past_due_at)
  WHERE status = 'past_due';

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_expiry
  ON subscriptions (trial_ends_at)
  WHERE status = 'trialing';
