-- 094 — 'suspended' subscription status + scheduled (period-end) downgrade
--       + re-checkout marker (billing review 2026-09-05, items A1/A3/A4/A6)
--
-- WHY
-- ---------------------------------------------------------------------------
-- A6: admin "suspend" wrote status='paused' — the SAME value the owner's own
--     churn pause uses — so a suspended tenant could POST /billing/resume and
--     undo the suspension themselves, and "restore" set 'active' whatever the
--     tenant was before (a trialing tenant restored onto a paid plan for free).
--     `subscriptions.status` is the `subscription_status` ENUM from migration
--     002 (trialing/active/past_due/paused/cancelled/expired), so a distinct
--     value needs an ADD VALUE here; `pre_suspend_status` remembers what to
--     restore to.
-- A3: downgrading to a ₹0 plan flipped plan_id immediately and left the
--     Razorpay mandate live; the next `subscription.charged` webhook put the
--     tenant back on the paid plan (and charged them). The fair fix is
--     cancel-at-cycle-end semantics: the tenant keeps what they paid for until
--     current_period_end, and `pending_plan_id` records where they land when
--     the gateway's cancelled/completed webhook (or the nightly sweep) says the
--     paid period is over.
-- A1/A4: "resume" of a cancelled-at-period-end or paused PAID plan has to go
--     back through Razorpay checkout because the mandate was cancelled. The
--     row stays as it is until the first charge on the NEW gateway
--     subscription lands. `_onChargeSuccess` refuses to reactivate a
--     cancelled/paused row (2026-08-30 guard, correct for stray charges on the
--     OLD mandate), so `reactivation_rzp_subscription_id` names the one new
--     gateway subscription whose first charge IS allowed to reactivate.
--
-- ADD VALUE inside the runner's transaction is fine on PG >= 12 (035 does the
-- same); the new value is deliberately NOT used anywhere in this file because
-- Postgres forbids using an enum value in the transaction that added it.

ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'suspended';

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pre_suspend_status TEXT,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reactivation_rzp_subscription_id TEXT;

COMMENT ON COLUMN subscriptions.pre_suspend_status IS
  'Status the row had when an admin suspended it; restore() returns to this. NULL unless suspended.';
COMMENT ON COLUMN subscriptions.pending_plan_id IS
  'Plan the tenant moves to when the current paid period ends (scheduled downgrade to a free plan). Applied by the gateway cancelled/completed webhook or the nightly sweep.';
COMMENT ON COLUMN subscriptions.reactivation_rzp_subscription_id IS
  'Razorpay subscription id created by an explicit re-checkout (undo-cancel / resume-from-pause). Its first charge may reactivate a cancelled/paused row; any other charge on a cancelled row is recorded but never reactivates.';

-- The nightly sweep scans only rows with something scheduled.
CREATE INDEX IF NOT EXISTS idx_subscriptions_pending_downgrade
  ON subscriptions(current_period_end) WHERE pending_plan_id IS NOT NULL;
