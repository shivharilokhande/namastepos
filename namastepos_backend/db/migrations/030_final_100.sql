-- Migration 030 — Final 100% pass
-- Adds: chart of accounts, journal entries (double-entry), bill split, food
-- coupons, co-purchases cache, forecast cache, FX rates, B2B invoice templates.

-- ── Bill split (FF-304) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_splits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  parent_session_id UUID REFERENCES table_sessions(id) ON DELETE CASCADE,
  parent_order_id   UUID REFERENCES orders(id) ON DELETE CASCADE,
  split_mode      VARCHAR(20) NOT NULL,    -- 'equal' | 'by_item' | 'custom'
  payload         JSONB NOT NULL,          -- snapshot of how it was split
  total_paise     INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bill_split_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_split_id   UUID NOT NULL REFERENCES bill_splits(id) ON DELETE CASCADE,
  guest_label     VARCHAR(80),
  customer_phone  VARCHAR(20),
  amount_paise    INTEGER NOT NULL,
  payment_method  payment_method NOT NULL DEFAULT 'cash',
  paid_at         TIMESTAMPTZ
);

-- ── Food coupons (FF-1701) ───────────────────────────────────────────────
-- Extend the existing coupons table with applies_to so we can scope coupons
-- to either subscription billing or food orders.
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS applies_to VARCHAR(20) NOT NULL DEFAULT 'subscription'
    CHECK (applies_to IN ('subscription','food_order','both'));

-- ── Chart of accounts + journal entries (R19) ────────────────────────────
DO $$ BEGIN
  CREATE TYPE account_kind AS ENUM ('asset','liability','equity','income','expense');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            VARCHAR(20) NOT NULL,    -- e.g. '4000', '1100'
  name            VARCHAR(120) NOT NULL,
  kind            account_kind NOT NULL,
  parent_code     VARCHAR(20),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_account UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,
  ref_kind        VARCHAR(20),   -- 'order' | 'expense' | 'payment' | 'manual'
  ref_id          UUID,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_je_business_date
  ON journal_entries (business_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS journal_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code    VARCHAR(20) NOT NULL,
  debit_paise     INTEGER NOT NULL DEFAULT 0,
  credit_paise    INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  CONSTRAINT chk_debit_xor_credit
    CHECK ((debit_paise > 0 AND credit_paise = 0) OR (credit_paise > 0 AND debit_paise = 0))
);
CREATE INDEX IF NOT EXISTS idx_jl_account
  ON journal_lines (journal_entry_id, account_code);

-- ── Co-purchase rules (F42) ──────────────────────────────────────────────
-- Nightly refresh: which items get ordered together. Used for upsell.
CREATE TABLE IF NOT EXISTS co_purchase_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  anchor_item_id  UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  suggested_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  confidence      NUMERIC(5,2) NOT NULL,    -- 0..100
  co_count        INTEGER NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_copurchase UNIQUE (business_id, anchor_item_id, suggested_item_id)
);

-- ── Inventory forecast cache (F45) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_forecasts (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id   UUID REFERENCES ingredients(id) ON DELETE CASCADE,
  forecast_date   DATE NOT NULL,
  expected_qty    NUMERIC(10,3) NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, ingredient_id, forecast_date)
);

-- ── FX rates (R14 — multi-currency) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS fx_rates (
  base_ccy        VARCHAR(3) NOT NULL,
  quote_ccy       VARCHAR(3) NOT NULL,
  rate            NUMERIC(14,6) NOT NULL,
  as_of_date      DATE NOT NULL,
  PRIMARY KEY (base_ccy, quote_ccy, as_of_date)
);

-- Seed reasonable defaults so the rest of the code has something to read.
INSERT INTO fx_rates (base_ccy, quote_ccy, rate, as_of_date) VALUES
  ('INR','USD', 0.012, CURRENT_DATE),
  ('USD','INR', 83.000, CURRENT_DATE),
  ('INR','EUR', 0.011, CURRENT_DATE),
  ('EUR','INR', 91.000, CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- ── B2B invoice templates (R20) ──────────────────────────────────────────
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

-- ── Dynamic delivery surge (F46) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surge_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(80) NOT NULL,
  day_of_week     INTEGER,        -- 0..6 or NULL for any day
  start_minute    INTEGER NOT NULL,  -- minutes since midnight
  end_minute      INTEGER NOT NULL,
  multiplier      NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  flat_extra_paise INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── KDS subscriber heartbeats (for connection tracking) ─────────────────
CREATE TABLE IF NOT EXISTS kds_clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  station_id      UUID REFERENCES kot_stations(id) ON DELETE SET NULL,
  client_label    VARCHAR(80),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── i18n translation overrides (per-tenant menu item names in Hindi) ─────
CREATE TABLE IF NOT EXISTS menu_item_translations (
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  locale          VARCHAR(8) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  PRIMARY KEY (menu_item_id, locale)
);
