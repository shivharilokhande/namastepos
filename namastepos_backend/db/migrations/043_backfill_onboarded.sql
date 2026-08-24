-- NamastePOS · Migration 043 — Backfill business.onboarded (FF-217c).
--
-- The `onboarded` column was added early but new customer accounts had
-- been landing with it null / false. Sprint 12 wired a first-run wizard
-- that gates on `onboarded=false` — the side-effect is that every
-- pre-existing account (including Shivhari's own "Cafe Sugar & Spice"
-- which already has 4 tables and 8 menu items) gets shoved into the
-- wizard on sign-in, and the wizard then fails to POST duplicates.
--
-- This migration marks any business that has ALREADY got any real
-- data (menu items, tables, orders, or floors) as onboarded, so the
-- wizard only appears for truly-new signups.

UPDATE businesses b
   SET onboarded = TRUE
 WHERE COALESCE(onboarded, FALSE) = FALSE
   AND (
        EXISTS (SELECT 1 FROM menu_items       mi WHERE mi.business_id = b.id)
     OR EXISTS (SELECT 1 FROM orders            o WHERE o.business_id  = b.id)
     OR EXISTS (SELECT 1 FROM tables            t WHERE t.business_id  = b.id)
     OR EXISTS (SELECT 1 FROM floors            f WHERE f.business_id  = b.id)
   );

-- Belt-and-braces: default the column to TRUE going forward so a
-- forgotten INSERT doesn't drop new rows into wizard mode. Actual
-- fresh signups are handled by createBusinessForUser which explicitly
-- sets onboarded=false on the new row.
ALTER TABLE businesses ALTER COLUMN onboarded SET DEFAULT TRUE;
