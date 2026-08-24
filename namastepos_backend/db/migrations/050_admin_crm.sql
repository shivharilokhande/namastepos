-- NamastePOS · Migration 050 — Admin CRM primitives (FF-402).
--
-- Four lightweight tables + two columns on businesses. This is *not* a
-- Salesforce-style CRM — it's the minimum kit our support team needs
-- to run a growing tenant book without follow-ups slipping:
--
--   1. admin_activities  — one scrollable timeline per tenant. Every
--      plan change, refund, ticket, WA send, or manual note lands
--      here so support has one place to read history from.
--   2. admin_tasks       — "call Rohit Tuesday about Zomato sync".
--      Owner + due date + snooze. Zero of the CRM value works
--      without a follow-up log.
--   3. businesses.lifecycle_stage — cached enum recomputed nightly:
--      trial / active / at_risk / churned. Drives a chip on the
--      customers list so ops sees who to call this week.
--   4. businesses.health_score  — 0-100 cached score:
--        last_order_days · last_login_days · unpaid_invoices ·
--        open_tickets · aggregator_sync_health
--
-- Kept intentionally boring: no per-customer custom fields, no
-- pipeline stages, no email sequences inside admin. Add those when
-- we hit ~100 tenants and actually feel the pain.

CREATE TABLE IF NOT EXISTS admin_activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,       -- 'note' | 'plan_change' | 'refund' | 'ticket' |
                                   -- 'wa_sent' | 'call' | 'email' | 'anomaly' |
                                   -- 'onboarded' | 'churn_risk' | 'renewal_upcoming'
  title       TEXT NOT NULL,       -- one-line summary
  body        TEXT,                -- optional longer note
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"fromTier":"free","toTier":"pro"}
  actor_type  TEXT NOT NULL DEFAULT 'system',       -- 'system' | 'admin' | 'tenant'
  actor_email TEXT,                                 -- filled for 'admin'/'tenant'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_activities_biz
  ON admin_activities(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_activities_kind
  ON admin_activities(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID REFERENCES businesses(id) ON DELETE CASCADE,
  -- Tasks CAN be tenant-agnostic (e.g. "prep launch checklist") — hence
  -- the nullable business_id. Most will be tenant-scoped though.
  title         TEXT NOT NULL,
  notes         TEXT,
  owner_email   TEXT,               -- assignee (from admin_users)
  due_at        TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,        -- null = open
  created_by    TEXT,               -- admin who filed it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_open
  ON admin_tasks(owner_email, due_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_tasks_biz
  ON admin_tasks(business_id, done_at NULLS FIRST, due_at);

-- ── Lifecycle + health cache on businesses ────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT
    CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN ('trial','active','at_risk','churned')),
  ADD COLUMN IF NOT EXISTS health_score INT,           -- 0..100, null = not yet computed
  ADD COLUMN IF NOT EXISTS health_computed_at TIMESTAMPTZ;

-- Best-effort backfill: businesses with orders in the last 7 days are
-- 'active'; anything else falls to 'at_risk' and lets the nightly job
-- refine. New signups keep NULL until they place their first order or
-- the cron ticks in — either way they'll get a proper stage within 24h.
UPDATE businesses b SET lifecycle_stage = 'active'
 WHERE lifecycle_stage IS NULL
   AND EXISTS (
     SELECT 1 FROM orders o
      WHERE o.business_id = b.id AND o.created_at > NOW() - INTERVAL '7 days'
   );
