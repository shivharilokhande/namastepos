-- Migration 096 — Recurring invoices become a REAL feature (2026-09-06,
-- round-2 review / CONTRACTS §2).
--
-- `recurring_invoices` (migration 027) had a table and a cron job that logged
-- "fired" and bumped next_run_at — no invoice was ever generated, and the
-- feature was sold on Advanced/Enterprise. This adds the bookkeeping the real
-- generator (services/recurringInvoiceService.js) needs:
--
--   * schedule columns: a human name, last_run_at / last_invoice_id /
--     run_count for the dashboard list, updated_at for PATCH.
--   * `recurring_invoice_runs`: one row per (schedule, period). The UNIQUE
--     constraint is the idempotency key — two cron leaders, a retried tick, or
--     a run-now racing the cron can only ever produce ONE tax invoice for a
--     given period. `period_key` is the schedule's next_run_at (as a date) at
--     the moment the period was claimed.
--
-- Additive only. Frequency check kept as the 027 comment documents it.

ALTER TABLE recurring_invoices
  ADD COLUMN IF NOT EXISTS name            VARCHAR(120),
  ADD COLUMN IF NOT EXISTS last_run_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_invoice_id UUID REFERENCES tax_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The cron scans for due schedules every tick; keep that scan an index hit.
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_due
  ON recurring_invoices (next_run_at)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_recurring_invoices_business
  ON recurring_invoices (business_id, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_recurring_invoices_updated
    BEFORE UPDATE ON recurring_invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recurring_invoice_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  schedule_id   UUID NOT NULL REFERENCES recurring_invoices(id) ON DELETE CASCADE,
  period_key    DATE NOT NULL,
  invoice_id    UUID REFERENCES tax_invoices(id) ON DELETE SET NULL,
  triggered_by  VARCHAR(10) NOT NULL DEFAULT 'cron',   -- cron | manual
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_recurring_invoice_runs_period UNIQUE (schedule_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_runs_business
  ON recurring_invoice_runs (business_id, created_at DESC);
