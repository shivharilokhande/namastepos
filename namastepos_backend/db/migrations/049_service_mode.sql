-- NamastePOS · Migration 049 — Service-mode categorization (FF-252).
--
-- Why: current "ready" flow always WhatsApps the guest "please collect".
-- That's correct for street stalls / cafés with self-service counters,
-- but WRONG for restaurants where a waiter delivers to the table. We
-- add an explicit `service_mode` at three tiers (order → table → business)
-- with the most-specific-wins rule, so:
--
--   • self_pickup  → keep the "ready to collect" customer WA (current)
--   • dine_in      → status becomes `ready_to_serve` for the runner;
--                    NO customer WA on ready (they're sitting at the table).
--   • hybrid       → business-level default; each table's own value wins.
--
-- Backfill picks the safe default for existing data:
--   • businesses.default_service_mode = 'hybrid' — owner decides in wizard
--   • tables.service_mode             = 'dine_in' — table QRs imply
--     table service; if the owner actually runs self-service, they flip
--     the flag in Tables → Edit.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS default_service_mode TEXT
    NOT NULL DEFAULT 'hybrid'
    CHECK (default_service_mode IN ('dine_in','self_pickup','hybrid'));

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS service_mode TEXT
    CHECK (service_mode IS NULL OR service_mode IN ('dine_in','self_pickup'));
-- Backfill: any existing table gets dine_in (safe default — you don't
-- WhatsApp a customer who's sitting five feet from the kitchen). Owners
-- of self-service venues change this per-table or via the wizard.
UPDATE tables SET service_mode = 'dine_in' WHERE service_mode IS NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS service_mode TEXT
    CHECK (service_mode IS NULL OR service_mode IN ('dine_in','self_pickup','takeaway','delivery'));
-- Aggregator / delivery orders already have channel context, so they
-- resolve to 'delivery' at runtime — we leave existing orders NULL and
-- let resolveServiceMode() fill in from table/business at ready time.
