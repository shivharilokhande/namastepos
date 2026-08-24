-- Migration 026 — Retail tier 1 (Sprint 9)
-- Barcodes, batches+expiry, vendors, POs+GRN, price lists, ledgers, cheques

-- Universal "items" (separate from menu_items for retail SKUs)
CREATE TABLE IF NOT EXISTS retail_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  category        VARCHAR(80),
  unit            VARCHAR(20) NOT NULL DEFAULT 'piece',
  hsn_code        VARCHAR(10),
  gst_pct         NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  mrp_paise       INTEGER,
  default_price_paise INTEGER NOT NULL,
  cost_paise      INTEGER,
  stock           NUMERIC(10,3) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(10,3) NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retail_barcodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  retail_item_id  UUID NOT NULL REFERENCES retail_items(id) ON DELETE CASCADE,
  barcode         VARCHAR(40) NOT NULL,
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_barcode UNIQUE (business_id, barcode)
);

CREATE TABLE IF NOT EXISTS retail_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  retail_item_id  UUID NOT NULL REFERENCES retail_items(id) ON DELETE CASCADE,
  batch_no        VARCHAR(80) NOT NULL,
  qty             NUMERIC(10,3) NOT NULL,
  qty_remaining   NUMERIC(10,3) NOT NULL,
  cost_paise      INTEGER,
  manufactured_on DATE,
  expires_on      DATE,
  received_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  CONSTRAINT uq_retail_batch UNIQUE (retail_item_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_retail_batches_expiry
  ON retail_batches (expires_on) WHERE qty_remaining > 0 AND expires_on IS NOT NULL;

-- Vendors / suppliers
CREATE TABLE IF NOT EXISTS vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  contact_person  VARCHAR(120),
  phone           VARCHAR(20),
  email           CITEXT,
  address         TEXT,
  gstin           VARCHAR(15),
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  credit_limit_paise INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchase orders + GRN
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  po_no           VARCHAR(40) NOT NULL,
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',   -- draft | sent | partial | received | cancelled
  total_paise     INTEGER NOT NULL DEFAULT 0,
  expected_on     DATE,
  notes           TEXT,
  created_by_user_id UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_po_no UNIQUE (business_id, po_no)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  retail_item_id  UUID REFERENCES retail_items(id) ON DELETE SET NULL,
  ingredient_id   UUID REFERENCES ingredients(id) ON DELETE SET NULL,
  description     VARCHAR(255),
  qty_ordered     NUMERIC(10,3) NOT NULL,
  qty_received    NUMERIC(10,3) NOT NULL DEFAULT 0,
  unit_price_paise INTEGER NOT NULL,
  gst_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  grn_no          VARCHAR(40) NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by_user_id UUID REFERENCES users(id),
  notes           TEXT,
  CONSTRAINT uq_grn UNIQUE (business_id, grn_no)
);

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  grn_id          UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_line_id      UUID NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  qty             NUMERIC(10,3) NOT NULL,
  batch_no        VARCHAR(80),
  expires_on      DATE,
  PRIMARY KEY (grn_id, po_line_id)
);

-- Price lists (retail / wholesale / distributor)
CREATE TABLE IF NOT EXISTS price_lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(80) NOT NULL,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_price_list UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS price_list_lines (
  price_list_id   UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  retail_item_id  UUID NOT NULL REFERENCES retail_items(id) ON DELETE CASCADE,
  price_paise     INTEGER NOT NULL,
  PRIMARY KEY (price_list_id, retail_item_id)
);

-- Customer / vendor ledger
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_kind      VARCHAR(20) NOT NULL,    -- customer | vendor
  party_id        UUID NOT NULL,
  entry_date      DATE NOT NULL,
  kind            VARCHAR(20) NOT NULL,    -- invoice | payment | refund | opening_balance | adjustment
  ref_no          VARCHAR(40),
  debit_paise     INTEGER NOT NULL DEFAULT 0,
  credit_paise    INTEGER NOT NULL DEFAULT 0,
  balance_after_paise INTEGER NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_party
  ON ledger_entries (business_id, party_kind, party_id, entry_date DESC);

-- Cheques
CREATE TABLE IF NOT EXISTS cheques (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  direction       VARCHAR(8) NOT NULL,     -- in | out
  party_kind      VARCHAR(20),
  party_id        UUID,
  cheque_no       VARCHAR(20) NOT NULL,
  bank_name       VARCHAR(120),
  amount_paise    INTEGER NOT NULL,
  cheque_date     DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | cleared | bounced | cancelled
  cleared_on      DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quotation → Sales Order workflow
CREATE TABLE IF NOT EXISTS quotations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  quote_no        VARCHAR(40) NOT NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',   -- draft | sent | accepted | rejected | expired
  total_paise     INTEGER NOT NULL DEFAULT 0,
  expires_on      DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_quote_no UNIQUE (business_id, quote_no)
);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id    UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  retail_item_id  UUID REFERENCES retail_items(id) ON DELETE SET NULL,
  description     VARCHAR(255),
  qty             NUMERIC(10,3) NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  gst_pct         NUMERIC(5,2),
  line_total_paise INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS credit_limit_paise INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_list_id UUID REFERENCES price_lists(id) ON DELETE SET NULL;
