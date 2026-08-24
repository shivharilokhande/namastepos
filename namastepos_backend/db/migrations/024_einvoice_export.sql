-- Migration 024 — E-invoice (IRN) + E-way bill + accounting export log
-- Sprint 7 / FF-1101, FF-1102, FF-1103

CREATE TABLE IF NOT EXISTS einvoice_irns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  irn             VARCHAR(64) NOT NULL,
  ack_no          VARCHAR(40),
  ack_date        TIMESTAMPTZ,
  signed_qr       TEXT,
  signed_invoice  TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'generated',  -- generated | cancelled
  cancelled_at    TIMESTAMPTZ,
  raw_response    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_irn UNIQUE (irn)
);

CREATE TABLE IF NOT EXISTS eway_bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  eway_no         VARCHAR(40) NOT NULL,
  eway_date       DATE,
  validity        TIMESTAMPTZ,
  vehicle_no      VARCHAR(20),
  distance_km     INTEGER,
  raw_response    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_eway UNIQUE (eway_no)
);

CREATE TABLE IF NOT EXISTS accounting_exports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  format          VARCHAR(20) NOT NULL,   -- tally_xml | zoho_csv | quickbooks_csv
  date_from       DATE NOT NULL,
  date_to         DATE NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  url             TEXT,   -- where the export file is saved
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  exported_at     TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS einvoice_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS einvoice_user_id TEXT,
  ADD COLUMN IF NOT EXISTS einvoice_password_enc TEXT;
