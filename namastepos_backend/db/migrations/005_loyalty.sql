-- NamastePOS migration 005 — Loyalty implementation
-- Extends the existing customers table with points balance + lifetime totals.
-- Adds loyalty_settings (per business) and loyalty_transactions (full audit trail).
-- All gated by the 'loyalty' add-on at the app layer.

-- ── 1. customers: add loyalty columns ────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email              CITEXT,
  ADD COLUMN IF NOT EXISTS birthday           DATE,
  ADD COLUMN IF NOT EXISTS gender             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tags               TEXT[],
  ADD COLUMN IF NOT EXISTS notes              TEXT,
  ADD COLUMN IF NOT EXISTS points_balance     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_points    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_redeemed  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier               VARCHAR(20) DEFAULT 'bronze',
  ADD COLUMN IF NOT EXISTS first_order_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS visit_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketing_optin    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_customers_phone     ON customers(business_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_last      ON customers(business_id, last_order_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_birthday  ON customers(business_id, birthday);

-- ── 2. loyalty_settings (per business) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_settings (
  business_id          UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  is_active            BOOLEAN NOT NULL DEFAULT FALSE,
  earn_rate_paise      INTEGER NOT NULL DEFAULT 1000,    -- ₹10 spent = 1 point (paise per point)
  redemption_value_paise INTEGER NOT NULL DEFAULT 100,    -- 1 point = ₹1 discount (paise per point)
  min_redemption_points INTEGER NOT NULL DEFAULT 50,
  max_redemption_pct    INTEGER NOT NULL DEFAULT 30,      -- can't redeem more than 30% of bill
  points_expire_months  INTEGER,                          -- NULL = never expire
  welcome_bonus         INTEGER NOT NULL DEFAULT 0,       -- points granted to first-time customers
  birthday_bonus        INTEGER NOT NULL DEFAULT 0,       -- auto-credit on birthday
  tier_silver_threshold INTEGER NOT NULL DEFAULT 1000,    -- lifetime points to reach silver
  tier_gold_threshold   INTEGER NOT NULL DEFAULT 5000,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_loyalty_settings_updated ON loyalty_settings;
CREATE TRIGGER trg_loyalty_settings_updated BEFORE UPDATE ON loyalty_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 3. loyalty_transactions (audit trail) ───────────────────────────────
DO $$ BEGIN
  CREATE TYPE loyalty_txn_kind AS ENUM
    ('earn','redeem','welcome','birthday','manual_credit','manual_debit','expire','reverse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind            loyalty_txn_kind NOT NULL,
  points          INTEGER NOT NULL,                       -- positive earn, negative redeem
  balance_after   INTEGER NOT NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_customer ON loyalty_transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_business ON loyalty_transactions(business_id, created_at DESC);

-- ── 4. orders: link to customer + capture loyalty applied ───────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS points_earned        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_redeemed      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_discount_paise INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- ── 5. Seed default loyalty settings for any existing business ──────────
INSERT INTO loyalty_settings (business_id)
SELECT id FROM businesses ON CONFLICT (business_id) DO NOTHING;
