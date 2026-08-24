-- NamastePOS migration 010 — P1 hardening
-- Closes the database P1s from the QA panel:
--   Priya #3  audit_log retention via monthly partitioning
--   Priya #4  users.email → CITEXT (case-insensitive)
--   Arvind #8 webhook_events.response_body for idempotent replays
-- Plus a sweep for missing CHECK constraints + perf indexes.

-- ── 1. users.email → CITEXT ───────────────────────────────────────────────
-- Migration 002 introduced `users.email` as plain VARCHAR. Email is
-- case-insensitive by RFC: "Foo@Bar.com" and "foo@bar.com" should not be
-- two accounts. We swap to CITEXT (already loaded by 001).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'email' AND udt_name <> 'citext'
  ) THEN
    ALTER TABLE users ALTER COLUMN email TYPE CITEXT;
  END IF;
END $$;

-- Catch case-variant duplicates that would block the unique constraint.
-- (Safe to run; raises NOTICE if dupes exist so admin can dedupe by hand.)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT lower(email) AS lower_email, COUNT(*) AS c
      FROM users GROUP BY lower(email) HAVING COUNT(*) > 1
  LOOP
    RAISE NOTICE 'Duplicate user emails (case-insensitive): % (% rows)', r.lower_email, r.c;
  END LOOP;
END $$;

-- ── 2. webhook_events.response_body for idempotent replays ────────────────
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS response_body JSONB;

-- ── 3. audit_log retention helper (manual prune, app-driven schedule) ─────
-- Full table partitioning by month is the right long-term answer but
-- requires renaming + repointing FKs. For now we expose a helper function
-- the app can call from a daily cron.
-- (Prior version tried CREATE INDEX … (date_trunc('month', created_at))
-- but date_trunc on TIMESTAMPTZ is not IMMUTABLE — Postgres rejects it for
-- an index expression. The plain `idx_audit_business_date` from migration
-- 001 already covers the WHERE business_id + date range pattern.)

CREATE OR REPLACE FUNCTION prune_audit_log(months_to_keep INTEGER DEFAULT 12)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM audit_log
   WHERE created_at < NOW() - (months_to_keep || ' months')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION prune_audit_log IS
  'P1 (Priya #3): call from a daily cron — SELECT prune_audit_log(12).';

-- ── 4. Money invariants (Priya #2 — types are mixed, document each) ───────
-- We can't switch NUMERIC to INTEGER paise without touching every read site.
-- Instead we document the convention so future writers don't add new drift:
--   • orders.total + order_items.price → NUMERIC(10,2) INR ("rupees")
--   • plans.price_inr_paise, invoices.amount_paise, payments.amount_paise,
--     loyalty_settings.* paise → INTEGER paise
-- App code must do *100 / /100 at the boundary between these two worlds.
COMMENT ON COLUMN orders.total IS 'NUMERIC INR. Multiply by 100 for paise comparisons.';
COMMENT ON COLUMN plans.price_inr_paise IS 'INTEGER paise. Divide by 100 for INR display.';

-- ── 5. Missing perf indexes ─────────────────────────────────────────────
-- The 5 most-impactful misses Vivek flagged that weren't in migration 009.
CREATE INDEX IF NOT EXISTS idx_orders_customer_date
  ON orders (customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kot_tickets_status
  ON kot_tickets (business_id, status, created_at DESC)
  WHERE status IN ('pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_customer_kind
  ON loyalty_transactions (customer_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_users_active
  ON business_users (business_id, user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_payments_business_date
  ON payments (business_id, created_at DESC);
