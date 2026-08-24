-- NamastePOS migration 012 — Combos + menu polish
--
-- A "combo" is a menu_items row with is_combo = TRUE. The components it
-- bundles live in combo_items JSONB: [{ menuItemId, qty }, ...]. When the
-- cashier taps the combo it lands on the order as ONE line at the combo
-- price; stock + recipe deduction walks the components.
--
-- We also add an `image_url` accessor that's already on the schema (since
-- migration 001) and a `prep_minutes` hint for the KOT screen.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_combo       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS combo_items    JSONB,
  ADD COLUMN IF NOT EXISTS prep_minutes   INTEGER,
  ADD COLUMN IF NOT EXISTS display_order  INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS tags           TEXT[];

CREATE INDEX IF NOT EXISTS idx_menu_items_combo
  ON menu_items (business_id) WHERE is_combo = TRUE;

CREATE INDEX IF NOT EXISTS idx_menu_items_display
  ON menu_items (business_id, category, display_order, name)
  WHERE is_active = TRUE;

-- Suggested seed categories (skipped if any rows already exist for the biz).
-- Keep this purely additive — never wipes existing data.
