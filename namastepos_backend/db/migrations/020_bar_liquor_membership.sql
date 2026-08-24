-- Migration 020 — Bar/liquor inventory + memberships + gift cards + tip
-- Sprint 4 / FF-902, FF-1006, FF-1005, FF-903

-- Bar / liquor batch tracking (license + duty stamps + expiry)
CREATE TABLE IF NOT EXISTS liquor_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  batch_no        VARCHAR(80) NOT NULL,
  duty_stamp_no   VARCHAR(80),
  qty_received   NUMERIC(10,3) NOT NULL,
  qty_remaining  NUMERIC(10,3) NOT NULL,
  unit            VARCHAR(20) NOT NULL DEFAULT 'ml',
  cost_paise_per_unit INTEGER,
  expiry_date     DATE,
  received_at     DATE NOT NULL DEFAULT CURRENT_DATE,
  vendor_name     VARCHAR(255),
  invoice_no      VARCHAR(80),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_liquor_batch UNIQUE (business_id, menu_item_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_liquor_remaining
  ON liquor_batches (menu_item_id) WHERE qty_remaining > 0;

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_liquor BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pour_ml NUMERIC(6,2);  -- standard pour for liquor items

-- Memberships / packages
CREATE TABLE IF NOT EXISTS memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  price_paise     INTEGER NOT NULL,
  validity_days   INTEGER NOT NULL DEFAULT 30,
  benefits        JSONB,            -- { discount_pct: 10, free_items: [...] }
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS membership_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  membership_id   UUID NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  amount_paid_paise INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_membership_sub_active
  ON membership_subscriptions (business_id, customer_id) WHERE status = 'active';

-- Gift cards + pre-paid wallet
CREATE TABLE IF NOT EXISTS gift_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            VARCHAR(40) NOT NULL,
  initial_paise   INTEGER NOT NULL,
  remaining_paise INTEGER NOT NULL,
  purchaser_phone VARCHAR(20),
  recipient_phone VARCHAR(20),
  expires_at      TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gift_code UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  gift_card_id    UUID REFERENCES gift_cards(id) ON DELETE SET NULL,
  kind            VARCHAR(20) NOT NULL,    -- topup | redeem | refund | expire
  amount_paise    INTEGER NOT NULL,
  balance_after   INTEGER NOT NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS wallet_balance_paise INTEGER NOT NULL DEFAULT 0;

-- Tips per server
CREATE TABLE IF NOT EXISTS tips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  server_user_id  UUID REFERENCES users(id),
  amount_paise    INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tips_business_server_date
  ON tips (business_id, server_user_id, created_at DESC);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tip_paise   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS server_user_id UUID REFERENCES users(id);
