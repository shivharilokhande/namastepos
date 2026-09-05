-- Migration 095 — B2B invoice template store (2026-09-06, round-2 review D-04 /
-- CONTRACTS §1).
--
-- The dashboard's "B2B invoice template" page used to write the RECEIPT
-- template and 402 on save below Enterprise. It now has its own row per
-- business, gated on the `b2b_invoice` feature key (Pro+) for view and save.
--
-- Migration 030 already created `b2b_invoice_templates` (R20) with
-- letterhead_url / terms_text / footer_text columns that no code ever wrote.
-- The API contract names the fields `letterhead` and `terms` (free text, not a
-- URL), so those two columns are ADDED here; the service reads
-- COALESCE(letterhead, letterhead_url) / COALESCE(terms, terms_text) so any
-- row hand-inserted against the 030 shape still renders. Nothing is dropped
-- (forward-only, no DB drops — house rule).

CREATE TABLE IF NOT EXISTS b2b_invoice_templates (
  business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  letterhead_url  TEXT,
  signature_url   TEXT,
  terms_text      TEXT,
  bank_details    TEXT,
  footer_text     TEXT,
  show_hsn        BOOLEAN NOT NULL DEFAULT TRUE,
  show_eway       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE b2b_invoice_templates
  ADD COLUMN IF NOT EXISTS letterhead TEXT,
  ADD COLUMN IF NOT EXISTS terms      TEXT;

-- Keep updated_at honest on every PUT (set_updated_at() exists since 001).
DO $$ BEGIN
  CREATE TRIGGER trg_b2b_invoice_templates_updated
    BEFORE UPDATE ON b2b_invoice_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
