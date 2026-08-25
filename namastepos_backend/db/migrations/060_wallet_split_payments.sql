-- NamastePOS · Migration 060 — Split payments + wallet-as-tender +
-- membership sale/cancel accounting (founder requirements, 2026-08-25).
--
-- NOTE: numbered 060 but applied AFTER 061 on environments that already
-- ran 061 — scripts/migrate.js applies by "not yet in _migrations", so
-- ordering is safe. Everything here is idempotent.

-- 1. 'wallet' becomes a first-class tender so orders paid entirely from
--    the customer wallet can carry payment_method='wallet' (reports
--    bucket it like any other method). Same pattern as migration 055:
--    the new enum value is only USED at runtime, never inside this
--    migration — Postgres forbids using a value in the transaction
--    that adds it.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'wallet';

-- 2. Split-payment breakdown ("CASH+UPI", "CASH+CARD", "UPI+CARD",
--    any of those + WALLET). NULL = single-tender order (the common
--    case — no backfill needed). Shape:
--      [{ "method": "cash", "amountInr": 200 }, { "method": "upi", "amountInr": 340 }]
--    orders.payment_method stays = the LARGEST leg's method so every
--    existing report / donut / export keeps working unchanged; the
--    receipt + order detail render the full breakdown from here.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_breakdown JSONB;

-- 3. Membership sale + cancel accounting. Sales must land in revenue
--    reporting ('Membership sales' other-income line) and cancels must
--    reverse it ('Membership refunds') — incomeStatementService reads
--    these columns directly, so no parallel sales table is needed.
ALTER TABLE membership_subscriptions
  -- how the membership was paid (cash|upi|card|online|wallet). TEXT, not
  -- the payment_method enum, so this migration can't trip over the fresh
  -- 'wallet' enum value (see note on §1).
  ADD COLUMN IF NOT EXISTS payment_method        TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at          TIMESTAMPTZ,
  -- refund actually paid out on cancel (post cancellation-charge), and how
  ADD COLUMN IF NOT EXISTS refund_paise          BIGINT,
  ADD COLUMN IF NOT EXISTS refund_mode           TEXT,   -- 'wallet' | 'cash' | 'upi'
  ADD COLUMN IF NOT EXISTS cancellation_fee_paise BIGINT;

-- Cancelled-in-period lookups for the income statement.
CREATE INDEX IF NOT EXISTS idx_membership_subs_cancelled
  ON membership_subscriptions (business_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;
