-- NamastePOS backend - initial schema
-- PostgreSQL 14+
-- Auth model: Google Sign-In (Twilio OTP path is held in reserve)

-- ── Extensions ──────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";    -- case-insensitive email

-- ── ENUMs ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE order_status   AS ENUM ('pending','ready','collected','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_source   AS ENUM ('dineIn','takeaway','zomato','swiggy','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','upi','card','online','unpaid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE expense_category AS ENUM
    ('ingredients','fuel','labor','rent','utilities','packaging',
     'marketing','maintenance','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inventory_reason AS ENUM
    ('purchase','sale','waste','adjustment','returned','transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. businesses ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      VARCHAR(255) UNIQUE NOT NULL,
  email           CITEXT UNIQUE NOT NULL,
  display_name    VARCHAR(255),
  photo_url       TEXT,
  name            VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  city            VARCHAR(100),
  category        VARCHAR(50),
  gstin           VARCHAR(15),
  address         TEXT,
  upi_id          VARCHAR(100),
  bank_account    VARCHAR(50),
  bank_ifsc       VARCHAR(11),
  logo_url        TEXT,
  onboarded       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. refresh_tokens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  token_hash      VARCHAR(64) UNIQUE NOT NULL,
  user_agent      VARCHAR(500),
  ip_address      VARCHAR(45),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_business ON refresh_tokens(business_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expires  ON refresh_tokens(expires_at);

-- ── 3. menu_items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  category        VARCHAR(50) NOT NULL DEFAULT 'Food',
  price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  cost_price      NUMERIC(10,2) CHECK (cost_price IS NULL OR cost_price >= 0),
  sku             VARCHAR(50),
  unit            VARCHAR(20) NOT NULL DEFAULT 'piece',
  stock           NUMERIC(10,2) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(10,2) NOT NULL DEFAULT 10,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_veg          BOOLEAN NOT NULL DEFAULT TRUE,
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_menu_sku UNIQUE (business_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_menu_business  ON menu_items(business_id);
CREATE INDEX IF NOT EXISTS idx_menu_category  ON menu_items(business_id, category);
CREATE INDEX IF NOT EXISTS idx_menu_active    ON menu_items(business_id) WHERE is_active = TRUE;

-- ── 4. orders ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_no        INTEGER NOT NULL,
  source          order_source NOT NULL DEFAULT 'dineIn',
  table_no        VARCHAR(20),
  customer_phone  VARCHAR(20),
  customer_name   VARCHAR(255),
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax             NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method  payment_method NOT NULL DEFAULT 'cash',
  status          order_status NOT NULL DEFAULT 'pending',
  cancel_reason   TEXT,
  printed         BOOLEAN NOT NULL DEFAULT FALSE,
  client_id       UUID,                              -- idempotency key from mobile
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at        TIMESTAMPTZ,
  collected_at    TIMESTAMPTZ,
  CONSTRAINT uq_orders_no UNIQUE (business_id, order_no),
  CONSTRAINT uq_orders_client UNIQUE (business_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_business_date
  ON orders(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_business_status
  ON orders(business_id, status, created_at DESC);

-- ── 5. order_items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL,
  name            VARCHAR(255) NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  qty             NUMERIC(10,2) NOT NULL CHECK (qty > 0),
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ── 6. expenses ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category        expense_category NOT NULL DEFAULT 'other',
  amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description     TEXT,
  date            DATE NOT NULL,
  receipt_url     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_expenses_business_date
  ON expenses(business_id, date) WHERE deleted_at IS NULL;

-- ── 7. inventory_transactions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL,
  qty_change      NUMERIC(10,2) NOT NULL,
  balance_after   NUMERIC(10,2) NOT NULL,
  reason          inventory_reason NOT NULL DEFAULT 'adjustment',
  order_id        UUID,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_item ON inventory_transactions(menu_item_id, created_at DESC);

-- ── 8. customers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone           VARCHAR(20) NOT NULL,
  name            VARCHAR(255),
  total_orders    INTEGER NOT NULL DEFAULT 0,
  total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_order_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_customers UNIQUE (business_id, phone)
);

-- ── 9. report_cache ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type            VARCHAR(20) NOT NULL,            -- 'daily' | 'monthly'
  key_date        VARCHAR(10) NOT NULL,            -- 'YYYY-MM-DD' or 'YYYY-MM'
  payload         JSONB NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_report UNIQUE (business_id, type, key_date)
);
CREATE INDEX IF NOT EXISTS idx_report_expires ON report_cache(expires_at);

-- ── 10. audit_log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES businesses(id),
  actor_id        UUID,
  action          VARCHAR(50) NOT NULL,
  entity_type     VARCHAR(50),
  entity_id       VARCHAR(100),
  payload         JSONB,
  ip_address      VARCHAR(45),
  user_agent      VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_business_date
  ON audit_log(business_id, created_at DESC);

-- ── updated_at trigger helper ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_businesses_updated   ON businesses;
DROP TRIGGER IF EXISTS trg_menu_updated         ON menu_items;
DROP TRIGGER IF EXISTS trg_orders_updated       ON orders;

CREATE TRIGGER trg_businesses_updated BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_menu_updated       BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_updated     BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
