-- NamastePOS migration 014 — Bill polish + tokens + cancel reasons
-- Sprint 1 / Stories FF-301, FF-302, FF-303, FF-305, FF-501, FF-503.

-- ── 1. orders: extra money lines ─────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS service_charge_paise INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off_paise      INTEGER NOT NULL DEFAULT 0,    -- can be negative
  ADD COLUMN IF NOT EXISTS discount_is_pre_tax  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS token_no             INTEGER,
  ADD COLUMN IF NOT EXISTS cancel_reason_code   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS reprint_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reprint_at      TIMESTAMPTZ;

-- ── 2. takeaway_counters: daily-resetting token counter ──────────────────
CREATE TABLE IF NOT EXISTS takeaway_counters (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  last_token   INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, day)
);

-- ── 3. cancel_reasons: per-tenant reason picker ──────────────────────────
CREATE TABLE IF NOT EXISTS cancel_reasons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            VARCHAR(40) NOT NULL,
  label           VARCHAR(120) NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_cancel_code UNIQUE (business_id, code)
);

-- Seed sensible defaults for every existing tenant
INSERT INTO cancel_reasons (business_id, code, label, display_order)
SELECT b.id, code, label, ord
FROM businesses b,
     (VALUES
       ('wrong_order',       'Wrong order',          10),
       ('customer_left',     'Customer left',        20),
       ('out_of_stock',      'Out of stock',         30),
       ('kitchen_error',     'Kitchen error',        40),
       ('payment_failed',    'Payment failed',       50),
       ('duplicate',         'Duplicate order',      60),
       ('other',             'Other',               100)
     ) v(code, label, ord)
ON CONFLICT DO NOTHING;

-- ── 4. discount_approvals: log of manager-approved high discounts ────────
-- (Story FF-502 — Sprint 3, schema ready now to avoid a later breaking change)
CREATE TABLE IF NOT EXISTS discount_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  manager_user_id UUID REFERENCES users(id),
  amount_paise    INTEGER NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_discount_approvals_business
  ON discount_approvals(business_id, approved_at DESC);
