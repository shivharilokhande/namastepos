-- NamastePOS migration 084 — per-variant stock + EXPLICIT stock tracking
-- 2026-09-04  (NP-205)
--
-- Two problems, one migration.
--
-- (1) VARIANTS HAD STOCK NOBODY DEDUCTED.
--     `menu_item_variants.stock` has existed since 013 and the menu editor
--     could write it, but `orderService.create()` only ever decremented
--     `menu_items.stock`. Selling a Large therefore never moved Large's
--     stock — the number on screen was decorative. Founder decision
--     (2026-09-04): every variant owns its own stock, settable from the menu
--     editor AND from inventory. From this migration on, a line that names a
--     variant deducts THAT variant's row and nothing else; a line with no
--     variant deducts the parent `menu_items` row exactly as before.
--
-- (2) `stock = 0` WAS AMBIGUOUS.
--     Zero meant EITHER "sold out" OR "I don't track stock for this" —
--     indistinguishable, and the two demand opposite behaviour. Every
--     consumer invented its own heuristic for it and they disagreed:
--       · orderService  → `before > 0` ("only enforce if it looks tracked")
--       · guestController → `stock >= 0 && stock < qty` (so 0 BLOCKED the sale)
--       · variants schema → "NULL = share parent stock"
--     A guest ordering an untracked item was told "only 0 in stock" while a
--     cashier could oversell a genuinely empty one. That is one bug class, not
--     three bugs.
--
--     `track_stock` makes the owner's intent explicit and is now the ONLY
--     input to that decision:
--
--       track_stock = FALSE → UNLIMITED. The `stock` number is ignored
--                             entirely: never decremented, never restored,
--                             never blocks a sale, no ledger row.
--       track_stock = TRUE  → FINITE. Sales decrement it, cancels restore it,
--                             and `stock <= 0` (or a line that would drive it
--                             below zero) is SOLD OUT → the sale is rejected
--                             with a 400 naming the item/variant.
--
--     The `trustedChannel` exemption is unchanged: an aggregator order was
--     already accepted on the platform, so it is never blocked by our stock —
--     it still deducts (going negative if need be) so the owner sees the truth.
--     Item-level 86 (`menu_items.sold_out_until`) is orthogonal and still
--     applies to variant lines: 86'ing a dish takes every size off sale.
--
-- BACKFILL RULE
--   track_stock = TRUE wherever a non-null, non-zero stock is ALREADY
--   recorded — those owners were demonstrably tracking (including a negative
--   balance, which means they tracked and oversold). Everything else stays
--   FALSE, which is exactly the "0 meant not-tracked" reading that the old
--   `before > 0` heuristic in orderService already used, so no tenant's
--   behaviour changes on deploy. NULL variant stock ("share parent stock",
--   013) also stays FALSE: unlimited, which is what those rows behaved like.
--
-- Additive only: two boolean columns with a FALSE default, one nullable
-- column on the ledger, two indexes. No drops, no rewrites of data-bearing
-- columns.

-- ── 1. The explicit flags ───────────────────────────────────────────────
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE menu_item_variants
  ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN menu_items.track_stock IS
  'NP-205: FALSE = stock is not tracked for this item (unlimited; the `stock` '
  'number is ignored, never deducted, never blocks a sale). TRUE = finite: '
  'sales deduct, cancels restore, and stock <= 0 is SOLD OUT. Replaces the '
  'old ambiguous "stock = 0 might mean either" heuristic.';

COMMENT ON COLUMN menu_item_variants.track_stock IS
  'NP-205: same contract as menu_items.track_stock, for this variant''s OWN '
  'stock. A line that names this variant deducts THIS row and never the '
  'parent item''s stock.';

-- ── 2. Ledger: which variant did this movement belong to? ───────────────
-- `inventory_transactions.menu_item_id` stays NOT NULL and keeps holding the
-- PARENT item id, so every existing report / stock-history screen keeps
-- working unchanged and still totals correctly per dish. `variant_id` is the
-- new, nullable refinement: NULL = a parent-level movement (exactly what
-- every historical row is), non-NULL = this movement came out of / went back
-- into that variant's own stock. No FK, matching `menu_item_id`, which has
-- never carried one on this table (movements must survive the deletion of
-- the thing they moved — that is the point of a ledger).
ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS variant_id UUID;

COMMENT ON COLUMN inventory_transactions.variant_id IS
  'NP-205: the menu_item_variants row this movement debited/credited. NULL = '
  'parent-item movement (all pre-084 rows). menu_item_id always holds the '
  'PARENT id so per-dish totals stay correct either way.';

CREATE INDEX IF NOT EXISTS idx_inv_variant
  ON inventory_transactions (variant_id, created_at DESC)
  WHERE variant_id IS NOT NULL;

-- ── 3. Backfill: whoever already recorded a number meant to track it ────
UPDATE menu_items
   SET track_stock = TRUE
 WHERE track_stock = FALSE
   AND stock IS NOT NULL
   AND stock <> 0;

UPDATE menu_item_variants
   SET track_stock = TRUE
 WHERE track_stock = FALSE
   AND stock IS NOT NULL
   AND stock <> 0;

-- ── 4. Partial indexes for the "what's running out?" screens ────────────
-- Inventory / low-stock views only ever look at TRACKED rows now, so index
-- only those. Tiny compared with a full index on every menu row.
CREATE INDEX IF NOT EXISTS idx_menu_items_tracked_stock
  ON menu_items (business_id, stock)
  WHERE track_stock = TRUE;

CREATE INDEX IF NOT EXISTS idx_variants_tracked_stock
  ON menu_item_variants (business_id, stock)
  WHERE track_stock = TRUE;
