-- 092 — the GST scheme the restaurant is actually registered under.
--
-- WHY THIS COLUMN HAS TO EXIST.
-- Until today a menu item's GST slab defaulted to 5 in three separate places
-- (menuService.create's `COALESCE($19, 5)`, the CSV importer's `?? 5`, and
-- every starter template's `defaultGstPct: 5`) and NOTHING anywhere asked the
-- owner whether 5 was right for them. For most restaurants it is — 5% without
-- input tax credit is the ordinary restaurant-service rate. For two groups it
-- is wrong in a way that shows up on every single bill they print:
--
--   • COMPOSITION SCHEME. They do not charge GST to the diner at all and must
--     issue a BILL OF SUPPLY, not a tax invoice. Defaulting them to 5% makes
--     every bill they hand a customer non-compliant, and — worse — the moment
--     ORDER_TAX_ENFORCE flips from 'log' to 'enforce', the server would start
--     ADDING 5% to their bills from the menu's own config. This column is what
--     stops that.
--   • SPECIFIED PREMISES (restaurants in higher-tariff hotel premises, and
--     those who have opted in). 18% WITH input tax credit.
--
-- WE DELIBERATELY DO NOT ENCODE A THRESHOLD OR A NOTIFICATION NUMBER HERE.
-- The turnover limits and the definition of "specified premises" move, they
-- have per-state variations, and getting one wrong in code would be worse than
-- not having it. The owner tells us which scheme they are on — a fact they
-- already know from their registration — and the UI points them at their CA
-- for the edge cases. Nothing here infers the scheme from anything.
--
-- ADDITIVE ONLY, and idempotent, so the file can be applied twice.
-- 'regular' is the default for every existing row, which is exactly the
-- behaviour those businesses have today (5% menu default). Nobody's bills
-- change until they answer the question.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS gst_scheme TEXT NOT NULL DEFAULT 'regular';

-- Constraint added separately (and guarded) so re-running the file is safe;
-- ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_gst_scheme_chk'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_gst_scheme_chk
      CHECK (gst_scheme IN ('regular', 'composition', 'specified_premises'));
  END IF;
END $$;

COMMENT ON COLUMN businesses.gst_scheme IS
  'GST scheme the owner declared at setup. regular = 5% no ITC (the common '
  'case); composition = no GST on the bill, issues a bill of supply; '
  'specified_premises = 18% with ITC. Drives the default gst_pct on new menu '
  'items and zeroes GST on orders for composition dealers. Owner-declared, '
  'never inferred.';
