-- 093 — mark fabricated (DEMO) e-invoice IRNs and e-way bill numbers
--
-- WHY
-- ---------------------------------------------------------------------------
-- accountingExportService.generateIrn() computed a correct NIC IRN hash and
-- ewayBillService.generate() hashed a row id into NIC's 12-digit EWB shape,
-- and NEITHER ever called the IRP. IRP_BASE_URL / IRP_USERNAME / IRP_PASSWORD
-- have never been set in production, so every IRN and every EWB number stored
-- to date came from the stub path: plausible-looking, government-invisible.
--
-- Nothing stored is deleted or rewritten. The numbers stay exactly as they
-- are — an owner who wrote one down still finds the same row. What changes is
-- that the row now SAYS what it is, and every read path (API, dashboard,
-- printed document) carries the flag forward.
--
-- HOW MANY ROWS THIS TOUCHES (read-only, run before/after on prod)
-- ---------------------------------------------------------------------------
--   SELECT COUNT(*)                                          AS irns_total,
--          COUNT(*) FILTER (WHERE irn ~ '^[0-9a-f]{64}$')    AS legacy_hash_irns,
--          COUNT(DISTINCT business_id)                       AS businesses
--     FROM einvoice_irns;
--   SELECT COUNT(*) FROM eway_bills;
--   -- after this migration:
--   SELECT COUNT(*) FROM einvoice_irns WHERE is_stub;   -- == irns_total
--
-- Every pre-093 row is a stub by construction: generateIrn() was the only
-- writer of einvoice_irns and it never called the IRP, so `legacy_hash_irns`
-- should equal `irns_total`.
--
-- HOW THE BACKFILL IS EXACTLY-ONCE
-- ---------------------------------------------------------------------------
-- ADD COLUMN ... DEFAULT TRUE backfills every existing row to TRUE in the
-- same statement; the following ALTER ... SET DEFAULT FALSE then makes FALSE
-- the default for everything inserted afterwards, so a real IRP-filed row
-- written tomorrow is not mis-marked. IF NOT EXISTS makes a re-run a no-op,
-- so running the migration set twice on a scratch DB is safe and the flag is
-- never applied to rows created after this migration ran.
--
-- The stub path also brands the value itself ('DEMO-NOT-A-VALID-IRN-…'), so
-- rows written from now on are identifiable even without this column.

-- ── e-invoice IRNs ─────────────────────────────────────────────────────────
ALTER TABLE einvoice_irns
  ADD COLUMN IF NOT EXISTS is_stub BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE einvoice_irns
  ALTER COLUMN is_stub SET DEFAULT FALSE;

COMMENT ON COLUMN einvoice_irns.is_stub IS
  'TRUE = this IRN was generated locally and was never filed with the NIC IRP. '
  'Backfilled TRUE by migration 093 because no IRP credentials have ever been '
  'configured. New rows default FALSE and are set TRUE only by the DEMO stub path.';

-- ── e-way bills ────────────────────────────────────────────────────────────
-- First, realise the columns migration 046 THOUGHT it was creating. 024 had
-- already created eway_bills, so 046's CREATE TABLE IF NOT EXISTS was a silent
-- no-op and ewayBillService.generate() has been writing to columns that do not
-- exist (tax_invoice_id, from_pincode, …) — i.e. POST /eway-bills has been a
-- 500 on every environment. Additive only; all nullable, so nothing existing
-- is invalidated. 046 declared some of these NOT NULL, but a NOT NULL backfill
-- on rows written under the 024 shape would be a rewrite, and the rule here is
-- additive-only.
ALTER TABLE eway_bills
  ADD COLUMN IF NOT EXISTS tax_invoice_id UUID REFERENCES tax_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ewb_no         TEXT,
  ADD COLUMN IF NOT EXISTS ewb_date       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS from_pincode   TEXT,
  ADD COLUMN IF NOT EXISTS to_pincode     TEXT,
  ADD COLUMN IF NOT EXISTS from_state     TEXT,
  ADD COLUMN IF NOT EXISTS to_state       TEXT,
  ADD COLUMN IF NOT EXISTS transporter_id TEXT,
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS raw_payload    JSONB;

ALTER TABLE eway_bills
  ADD COLUMN IF NOT EXISTS is_stub BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE eway_bills
  ALTER COLUMN is_stub SET DEFAULT FALSE;

COMMENT ON COLUMN eway_bills.is_stub IS
  'TRUE = this e-way bill number was generated locally and was never filed with '
  'NIC. Backfilled TRUE by migration 093; new rows default FALSE.';

-- Owner-facing surfaces filter on this, and there are few enough rows that a
-- partial index is the cheap shape.
CREATE INDEX IF NOT EXISTS idx_einvoice_irns_stub
  ON einvoice_irns(business_id) WHERE is_stub;
