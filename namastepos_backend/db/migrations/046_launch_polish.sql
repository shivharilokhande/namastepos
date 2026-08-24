-- NamastePOS · Migration 046 — Launch polish bundle.
--
-- Adds tables + columns for the last-mile features called out in
-- FULL_LAUNCH_AUDIT.md:
--   • FF-312 split-tender payments
--   • FF-903 server assignment + tip
--   • FF-1002 post-meal NPS
--   • FF-1005 gift cards + customer wallets
--   • FF-315 feature-flag overrides per business
--   • FF-1103 e-way bill
--
-- Every ALTER is idempotent (IF NOT EXISTS / DO $$…$$ guards) so
-- re-running is safe on partially-applied environments.

-- ── FF-312 split-tender ────────────────────────────────────────────────
-- We already have a `payments` table for Razorpay captures. It supports
-- multiple rows per order — this just adds a helper column so the POS
-- can persist "cash 200 + upi 340" as two rows and the receipt renders
-- both lines. `orders.payment_method` becomes the *primary* method (max
-- amount); the full breakdown lives in payments.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_split_tender BOOLEAN NOT NULL DEFAULT FALSE;

-- ── FF-903 server assignment + tip ─────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS server_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS tip_paise      BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_server_created
  ON orders(server_user_id, created_at DESC);

-- ── FF-1002 NPS responses ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nps_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id     UUID           REFERENCES orders(id)     ON DELETE SET NULL,
  customer_phone TEXT,
  score        SMALLINT       NOT NULL CHECK (score BETWEEN 0 AND 10),
  comment      TEXT,
  responded_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  channel      TEXT           NOT NULL DEFAULT 'whatsapp'
);
CREATE INDEX IF NOT EXISTS idx_nps_business_date
  ON nps_responses(business_id, responded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nps_one_per_order
  ON nps_responses(order_id) WHERE order_id IS NOT NULL;

-- Track which orders we've already asked so the scheduler doesn't
-- spam a customer with multiple ping attempts.
CREATE TABLE IF NOT EXISTS nps_pings (
  order_id     UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── FF-1005 gift cards + wallets ───────────────────────────────────────
-- Migration 020 already created a `gift_cards` table with different
-- column names (`initial_paise`, `remaining_paise`, `purchaser_phone`,
-- `recipient_phone`). We reconcile by ADDING synonyms + backfilling
-- so both the old bar-liquor code and the new FF-1005 flow work.
-- Later, once the bar module is retired, we can drop the old columns.
ALTER TABLE gift_cards
  ADD COLUMN IF NOT EXISTS face_value_paise    BIGINT,
  ADD COLUMN IF NOT EXISTS balance_paise       BIGINT,
  ADD COLUMN IF NOT EXISTS issued_to_phone     TEXT,
  ADD COLUMN IF NOT EXISTS issued_by_user_id   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS issued_at           TIMESTAMPTZ DEFAULT NOW();

-- Backfill from the migration-020 columns so existing rows keep working.
UPDATE gift_cards
   SET face_value_paise = COALESCE(face_value_paise, initial_paise),
       balance_paise    = COALESCE(balance_paise,    remaining_paise),
       issued_to_phone  = COALESCE(issued_to_phone,  recipient_phone),
       issued_at        = COALESCE(issued_at,        created_at)
 WHERE face_value_paise IS NULL OR balance_paise IS NULL;

-- Now that every row has values, enforce NOT NULL going forward.
ALTER TABLE gift_cards
  ALTER COLUMN face_value_paise SET NOT NULL,
  ALTER COLUMN balance_paise    SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gift_cards_biz_balance
  ON gift_cards(business_id, balance_paise DESC)
  WHERE balance_paise > 0;

CREATE TABLE IF NOT EXISTS customer_wallets (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  balance_paise   BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, customer_id)
);

-- Ledger for both gift-card and wallet movements — never touch balance
-- without an accompanying row here so DPDP data-export includes the
-- full audit trail.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  gift_card_id    UUID REFERENCES gift_cards(id) ON DELETE SET NULL,
  order_id        UUID REFERENCES orders(id)    ON DELETE SET NULL,
  kind            TEXT NOT NULL,        -- 'credit_issued' | 'credit_top_up' | 'redeem' | 'refund'
  amount_paise    BIGINT NOT NULL,      -- positive = credit, negative = debit
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_biz_time
  ON wallet_ledger(business_id, created_at DESC);

-- ── FF-315 feature-flag overrides ──────────────────────────────────────
-- Plan-features drive the base per-tier feature set. This table lets us
-- flip specific features ON/OFF for individual businesses without
-- migrating them to a different plan — useful for dark-launching a
-- risky feature to 5 friendly cafes first.
CREATE TABLE IF NOT EXISTS business_feature_overrides (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL,
  reason       TEXT,
  set_by_admin UUID  REFERENCES admin_users(id),
  set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, feature_key)
);

-- ── FF-1103 e-way bills ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eway_bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tax_invoice_id  UUID REFERENCES tax_invoices(id) ON DELETE SET NULL,
  ewb_no          TEXT UNIQUE,                       -- issued by NIC IRP
  ewb_date        TIMESTAMPTZ,
  from_pincode    TEXT NOT NULL,
  to_pincode      TEXT NOT NULL,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  distance_km     INT,
  vehicle_no      TEXT,
  transporter_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',     -- draft | generated | cancelled
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eway_bills_biz_time
  ON eway_bills(business_id, created_at DESC);
