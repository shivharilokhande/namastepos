-- 066_support_tickets.sql (2026-08-28) — X7 support / ticketing.
-- A lightweight helpdesk: tenants (or admins on their behalf) raise tickets;
-- support replies from the admin console. Additive + idempotent.

DO $$ BEGIN
  CREATE TYPE support_ticket_status AS ENUM ('open','pending','resolved','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE support_ticket_priority AS ENUM ('low','normal','high','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subject       VARCHAR(200) NOT NULL,
  status        support_ticket_status NOT NULL DEFAULT 'open',
  priority      support_ticket_priority NOT NULL DEFAULT 'normal',
  created_by_user_id UUID,          -- tenant user, null when admin-raised
  created_by_admin   BOOLEAN NOT NULL DEFAULT FALSE,
  last_reply_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_business ON support_tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type VARCHAR(10) NOT NULL,   -- 'tenant' | 'admin'
  author_id   UUID,
  author_email VARCHAR(255),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON support_ticket_messages(ticket_id);
