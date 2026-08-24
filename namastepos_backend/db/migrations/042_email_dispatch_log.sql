-- NamastePOS · Migration 042 — Email dispatch log (FF-223).
--
-- Records every transactional / lifecycle email we send so the
-- scheduler can idempotently pick candidates ("send D3 to owners who
-- registered 3 days ago AND haven't received the D3 template yet"),
-- and so support / DPDP can produce a complete communication history.
--
-- No PII is stored in the payload column — only template ID, delivery
-- status and provider message ID. The recipient email itself IS stored
-- because the DPDP data subject request handler needs to include a
-- copy in the exported archive; access to this table is restricted to
-- super-admins.

CREATE TABLE IF NOT EXISTS email_dispatch_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID REFERENCES businesses(id) ON DELETE CASCADE,
  user_id        UUID REFERENCES users(id)      ON DELETE CASCADE,
  template       TEXT NOT NULL,               -- 'onboarding_d0' | 'onboarding_d3' | 'onboarding_d7' | ...
  recipient      TEXT NOT NULL,               -- email address at send time
  subject        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',   -- queued | sent | failed | suppressed
  provider_id    TEXT,                         -- SES / SMTP message id
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at        TIMESTAMPTZ
);

-- Idempotency: only one row per (user, template) — the scheduler picks
-- unsent lifecycle emails via a NOT EXISTS lookup against this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_dispatch_log_user_template
  ON email_dispatch_log(user_id, template);

-- Fast lookup of "who has been contacted recently" for reports.
CREATE INDEX IF NOT EXISTS idx_email_dispatch_log_business_created
  ON email_dispatch_log(business_id, created_at DESC);
