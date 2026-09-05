-- 091 — churn prevention: dunning ladder, cancel flow, pause, export trail
--
-- ADDITIVE ONLY. No drops, no type changes, no data loss. Every statement is
-- idempotent so the file can be applied twice against the same database.
--
-- Four things ship here, all of them from the 2026-09-04 retention audit
-- (`analytics/retention-2026-09-04.md`) and the copy written against it
-- (`content/emails/dunning-ladder.md`, `content/emails/winback.md`).
--
-- 1. DUNNING LADDER STEP (`subscriptions.dunning_step`)
--    `dunning_attempts` (migration 065) counts GATEWAY failures — it is bumped
--    by every Razorpay `payment.failed`, including retries of the same debit.
--    It cannot say which OWNER-FACING touch has already gone out, so the old
--    service simply re-sent one email on every webhook. `dunning_step` is a
--    separate, monotonic 0..4 counter over the four written touches. It is only
--    ever advanced by a conditional UPDATE (`WHERE dunning_step < n`), which is
--    what makes "fires in order and never repeats a step" true even with two
--    cron instances and a webhook racing each other.
--
-- 2. CANCELLATION SURVEYS (`cancellation_surveys`)
--    The exit reason, the free text, which save offer the reason produced, and
--    whether it was taken. Stored so the reason mix can actually be read later
--    (audit §7 "exit-reason mix reviewed monthly"), which is impossible today
--    because cancelling writes nothing but a boolean.
--
-- 3. PAUSE (`paused_*` columns)
--    A time-boxed suspension for a seasonal outlet. The plan the tenant was on
--    is parked in `pause_plan_id`/`pause_billing_period` so RESUME restores the
--    same plan rather than guessing, and `last_pause_at` enforces the audit's
--    one-pause-per-12-months rule. `status = 'paused'` already exists in the
--    `subscription_status` enum (migration 002) — no enum change needed.
--
-- 4. LIFECYCLE AUDIT TRAIL (`subscription_lifecycle_events`)
--    Anything that stops a charge or moves a subscription between states leaves
--    a row here: who did it, when, from what to what. This is live billing; a
--    state change with no trail is not acceptable.

-- ── 1. Dunning ladder state ──────────────────────────────────────────────
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS dunning_step         SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dunning_step_at      TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.dunning_step IS
  'Highest owner-facing dunning touch already sent (0 = none, 1..4). Advanced '
  'only by a conditional UPDATE so a step can never fire twice. Distinct from '
  'dunning_attempts, which counts gateway failures.';
COMMENT ON COLUMN subscriptions.dunning_step_at IS
  'When the current dunning_step was sent. NULL when the ladder is not running.';

ALTER TABLE dunning_events
  ADD COLUMN IF NOT EXISTS step    SMALLINT,
  ADD COLUMN IF NOT EXISTS channel VARCHAR(16);

COMMENT ON COLUMN dunning_events.step IS
  'Ladder touch this row reports (1..4), or 0 for the recovery message.';
COMMENT ON COLUMN dunning_events.channel IS
  'How the touch actually left the building: whatsapp | email | none. '
  '"none" means neither channel was reachable, which is a data problem worth '
  'seeing rather than a silent no-op.';

-- The ladder tick scans past_due rows whose next step is due.
CREATE INDEX IF NOT EXISTS idx_subscriptions_dunning_ladder
  ON subscriptions (past_due_at, dunning_step)
  WHERE status = 'past_due';

-- ── 2. Pause ─────────────────────────────────────────────────────────────
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS paused_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pause_ends_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pause_plan_id        UUID REFERENCES plans(id),
  ADD COLUMN IF NOT EXISTS pause_billing_period VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pause_months         SMALLINT,
  ADD COLUMN IF NOT EXISTS last_pause_at        TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.paused_at IS
  'When the current pause started. NULL unless status = ''paused''.';
COMMENT ON COLUMN subscriptions.pause_ends_at IS
  'When the nightly sweep auto-resumes this subscription onto pause_plan_id.';
COMMENT ON COLUMN subscriptions.pause_plan_id IS
  'The plan the tenant was on when they paused. Resume restores exactly this '
  'plan — never a guess, never the catalog default.';
COMMENT ON COLUMN subscriptions.last_pause_at IS
  'Start of the most recent pause, kept after resume so the one-pause-per-12-'
  'months rule survives the pause ending.';

CREATE INDEX IF NOT EXISTS idx_subscriptions_pause_ends
  ON subscriptions (pause_ends_at)
  WHERE status = 'paused';

-- ── 3. Cancellation surveys ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cancellation_surveys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  -- One of the five reasons in churnService.CANCEL_REASONS. Stored as text
  -- rather than an enum so a sixth reason is a code change, not a migration.
  reason          VARCHAR(32) NOT NULL,
  reason_note     TEXT,
  -- Which save offer the REASON produced. 'none' is a real, deliberate value:
  -- closing_down and missing_feature get no offer on purpose.
  offer_kind      VARCHAR(32) NOT NULL DEFAULT 'none',
  offer_outcome   VARCHAR(32) NOT NULL DEFAULT 'pending',
    -- pending | accepted_downgrade | accepted_pause | declined | cancelled
  plan_tier       VARCHAR(40),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cancel_survey_business
  ON cancellation_surveys (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cancel_survey_reason
  ON cancellation_surveys (reason, created_at DESC);
-- At most one UNRESOLVED survey per tenant: re-opening the cancel flow updates
-- the open row instead of littering the reason dataset with abandoned drafts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancel_survey_open
  ON cancellation_surveys (business_id)
  WHERE resolved_at IS NULL;

-- ── 4. Lifecycle audit trail ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_lifecycle_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  event           VARCHAR(40) NOT NULL,
    -- cancel_started | save_offer_shown | save_offer_accepted | cancelled
    -- | paused | resumed | auto_resumed | export_taken
  reason          VARCHAR(32),
  from_status     VARCHAR(32),
  to_status       VARCHAR(32),
  plan_tier       VARCHAR(40),
  actor_user_id   UUID REFERENCES users(id),
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sub_lifecycle_business
  ON subscription_lifecycle_events (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_lifecycle_event
  ON subscription_lifecycle_events (event, created_at DESC);
