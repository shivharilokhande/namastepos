-- Migration 033 — Add HSN code to menu_items.
-- The dashboard's menu editor sends an `hsnCode` field used for GST e-invoice
-- generation. The column existed on `retail_items` (migration 026) but not
-- on `menu_items` — this migration plugs that gap.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(15);

-- For Indian food service, common HSN codes:
--   2106 90 99 — namkeen, savouries, mixtures
--   2202 — beverages, non-alcoholic
--   9963 — restaurant services (used on the invoice, not the item)
-- These aren't required at item level but are useful when present.

COMMENT ON COLUMN menu_items.hsn_code IS
  'HSN/SAC code for GST classification. Optional. Common values: 2106 (savouries), 2202 (beverages).';
