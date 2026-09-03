-- NamastePOS · Migration 075 — "Switch to NamastePOS" migration wizard
-- (customers + opening balances + aggregate sales-history imports).
-- Additive only.

-- 1. Loyalty opening balances imported from a previous POS book a ledger
--    entry (never a raw column poke) so the audit trail stays complete.
--    New kind for exactly that entry. Same pattern as migration 060's
--    payment_method 'wallet': the value is only USED at runtime, never
--    inside this migration (PG forbids using an enum value added in the
--    same transaction).
ALTER TYPE loyalty_txn_kind ADD VALUE IF NOT EXISTS 'import_opening';

-- 2. Idempotency guard for the sales-history import. Each imported day is
--    ONE aggregate order with channel='import' and collected_at pinned to
--    noon IST of that day, so (business_id, collected_at) is unique within
--    the import channel. A partial UNIQUE index makes re-runs skip instead
--    of double-booking revenue — and it's tiny (only import orders).
--    (collected_at is a plain column, so the index expression is immutable;
--    an IST-date expression index would not be.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_import_day
  ON orders (business_id, collected_at)
  WHERE channel = 'import';

-- 3. Wallet/loyalty opening-balance guards do a per-customer "was an
--    import_opening entry already booked?" lookup. wallet_ledger only had
--    a (business_id, created_at) index — add a customer+kind one so the
--    guard stays index-only as ledgers grow.
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_customer_kind
  ON wallet_ledger (business_id, customer_id, kind);

-- customers already has phone-unique (uq_customers), email, tags TEXT[],
-- notes and marketing_optin (migrations 001 + 005) — nothing to add there.
