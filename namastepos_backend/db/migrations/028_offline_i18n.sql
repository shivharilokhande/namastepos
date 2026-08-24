-- Migration 028 — Offline-sync outbox (Flutter) + i18n preference per user
-- Sprint 4 / FF-601, FF-604

-- Outbox the Flutter app drains when network returns. We accept the
-- same idempotent client_id pattern that order create already uses.
CREATE TABLE IF NOT EXISTS mobile_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id       VARCHAR(64) NOT NULL,
  endpoint        VARCHAR(80) NOT NULL,
  status_code     INTEGER NOT NULL,
  response_summary TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mobile_sync UNIQUE (business_id, client_id, endpoint)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale VARCHAR(8) NOT NULL DEFAULT 'en-IN';
