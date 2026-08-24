-- Migration 037 — Tax Invoices (Push 15c)
--
-- Customer-facing GST tax invoices per Rule 46 of CGST Rules 2017.
-- One invoice per order (1:1). Stored as a separate row so we can:
--   1. Maintain a FY-sequential invoice_no (mandatory under GST law,
--      independent of order_no which can have gaps from cancellations).
--   2. Freeze the invoice at the moment of issue — line item names,
--      GSTIN of supplier/recipient, addresses, HSN codes — so a later
--      edit to the menu or business profile doesn't retroactively
--      change an issued invoice.
--   3. Support B2B recipients (customer_gstin) with their full name +
--      address as required for ITC claim by the buyer.
--   4. Carry a QR-code payload for invoices ≥ ₹500 (mandatory B2B per
--      Notification 14/2020-CT) and the e-invoice IRN when available.
--
-- The existing `invoices` table is for SaaS subscription billing — kept
-- separate so we don't conflate the two flows.

CREATE TABLE IF NOT EXISTS tax_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id            UUID UNIQUE REFERENCES orders(id) ON DELETE SET NULL,

  -- Identity (Rule 46(b))
  invoice_no          VARCHAR(16) NOT NULL,         -- ≤ 16 chars, alphanumeric + - /
  fy                  VARCHAR(7)  NOT NULL,         -- e.g. '2026-27'
  fy_seq              INTEGER     NOT NULL,         -- 1, 2, 3, ... within the FY
  invoice_date        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Supplier (Rule 46(a)/(c)) — frozen from businesses at issue time
  supplier_name       VARCHAR(255) NOT NULL,
  supplier_gstin      VARCHAR(15),
  supplier_address    TEXT,
  supplier_state_code VARCHAR(2),

  -- Recipient (Rule 46(e)/(f))
  recipient_name      VARCHAR(255),
  recipient_gstin     VARCHAR(15),
  recipient_address   TEXT,
  recipient_state_code VARCHAR(2),
  recipient_phone     VARCHAR(20),

  -- Place of supply (Rule 46(n)) — state code where the supply happens.
  -- Same state as supplier → CGST + SGST; different → IGST.
  place_of_supply     VARCHAR(2) NOT NULL,
  is_interstate       BOOLEAN    NOT NULL DEFAULT FALSE,
  reverse_charge      BOOLEAN    NOT NULL DEFAULT FALSE,

  -- Money (Rule 46(j-m)) — paise to avoid float drift
  subtotal_paise      INTEGER NOT NULL,             -- taxable value
  discount_paise      INTEGER NOT NULL DEFAULT 0,
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  cess_paise          INTEGER NOT NULL DEFAULT 0,
  service_charge_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise     INTEGER NOT NULL DEFAULT 0,
  total_paise         INTEGER NOT NULL,
  amount_in_words     TEXT,

  -- Line items frozen as JSONB so the printout matches what we billed
  -- even after the menu changes. Each row carries: name, hsn, qty,
  -- unit_price_paise, line_taxable_paise, gst_pct, gst_amount_paise.
  items               JSONB NOT NULL,

  -- HSN summary for the bottom of the invoice (Rule 46(g))
  hsn_summary         JSONB,                        -- [{ hsn, taxable, cgst, sgst, igst, total }]

  -- Settlement
  payment_method      VARCHAR(20),
  payment_status      VARCHAR(20) DEFAULT 'paid',   -- paid | unpaid | partial
  paid_at             TIMESTAMPTZ,

  -- E-invoice / QR
  irn                 VARCHAR(80),                  -- when IRN is generated via einvoice_irns
  qr_code_payload     TEXT,                         -- compact payload for QR

  -- Bookkeeping
  status              VARCHAR(20) NOT NULL DEFAULT 'issued',  -- issued | cancelled
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  notes               TEXT,
  issued_by_user_id   UUID REFERENCES users(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One issued (non-cancelled) invoice per order
  CONSTRAINT uq_tax_invoice_business_no UNIQUE (business_id, fy, invoice_no)
);

CREATE INDEX IF NOT EXISTS idx_tax_invoices_business_date
  ON tax_invoices (business_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_order
  ON tax_invoices (order_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_fy_seq
  ON tax_invoices (business_id, fy, fy_seq);

-- updated_at trigger
DO $$ BEGIN
  CREATE TRIGGER trg_tax_invoices_updated
    BEFORE UPDATE ON tax_invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
