-- Migration 027 — Retail tier 2 (Sprint 10)

-- Warehouses for multi-location stock
CREATE TABLE IF NOT EXISTS warehouses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            VARCHAR(20) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  address         TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_warehouse UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS warehouse_stock (
  warehouse_id    UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  retail_item_id  UUID NOT NULL REFERENCES retail_items(id) ON DELETE CASCADE,
  qty             NUMERIC(10,3) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (warehouse_id, retail_item_id)
);

CREATE TABLE IF NOT EXISTS warehouse_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  to_warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  retail_item_id  UUID NOT NULL REFERENCES retail_items(id) ON DELETE CASCADE,
  qty             NUMERIC(10,3) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- TDS / TCS configuration
CREATE TABLE IF NOT EXISTS tds_tcs_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind            VARCHAR(10) NOT NULL,   -- tds | tcs
  code            VARCHAR(20) NOT NULL,   -- e.g. 194Q, 206C(1H)
  rate_pct        NUMERIC(5,2) NOT NULL,
  threshold_paise INTEGER,
  description     VARCHAR(255),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Recurring invoices
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_payload JSONB NOT NULL,
  frequency       VARCHAR(20) NOT NULL,    -- weekly | monthly | quarterly | yearly
  next_run_at     TIMESTAMPTZ NOT NULL,
  end_at          TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inventory valuation method per item
ALTER TABLE retail_items
  ADD COLUMN IF NOT EXISTS valuation_method VARCHAR(10) NOT NULL DEFAULT 'fifo'
    CHECK (valuation_method IN ('fifo','weighted','lifo'));

-- Marketplace integrations (Amazon, Flipkart)
CREATE TABLE IF NOT EXISTS marketplace_credentials (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  marketplace     VARCHAR(20) NOT NULL,   -- amazon | flipkart
  seller_id       VARCHAR(80),
  api_key         TEXT,
  api_secret      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (business_id, marketplace)
);

-- Currency support
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'INR';

-- Bank reconciliation
CREATE TABLE IF NOT EXISTS bank_statements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_name       VARCHAR(120) NOT NULL,
  account_no      VARCHAR(40) NOT NULL,
  statement_date  DATE NOT NULL,
  reference       VARCHAR(80),
  description     TEXT,
  debit_paise     INTEGER NOT NULL DEFAULT 0,
  credit_paise    INTEGER NOT NULL DEFAULT 0,
  matched_to_kind VARCHAR(20),    -- order | invoice | manual
  matched_to_id   UUID,
  is_reconciled   BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_unmatched
  ON bank_statements (business_id, statement_date DESC) WHERE is_reconciled = FALSE;
