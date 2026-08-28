-- 065_dunning.sql (2026-08-27) — failed-payment recovery (dunning).
-- Track how many times a subscription's charge has failed and when we last
-- nudged the owner, so the admin subscription ledger can surface a past-due
-- queue and we don't email the same tenant repeatedly on webhook retries.
-- Additive + idempotent.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS dunning_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_dunning_at TIMESTAMPTZ;

-- Lightweight audit trail of dunning events (one row per failed charge /
-- recovery), handy for support and for measuring recovery rate later.
CREATE TABLE IF NOT EXISTS dunning_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  event         VARCHAR(32) NOT NULL,            -- 'payment_failed' | 'halted' | 'recovered'
  attempt_no    INT,
  reason        TEXT,
  emailed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dunning_business ON dunning_events(business_id);
CREATE INDEX IF NOT EXISTS idx_dunning_created ON dunning_events(created_at);
