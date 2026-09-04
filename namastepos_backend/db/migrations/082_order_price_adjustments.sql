-- NamastePOS migration 082 — order price adjustments audit (NP-201)
-- 2026-09-04
--
-- Order pricing became SERVER-AUTHORITATIVE in orderService.create(): the
-- selling price of every line that names a menu item is now derived from
-- menu_items.price (or the validated menu_item_variants.price) plus the sum of
-- the validated modifiers' price_delta_inr. The client's `items[].price` is no
-- longer trusted.
--
-- That fixes the forgery hole (a patched app could bill ₹1 for a ₹300 pizza)
-- but it introduces an HONEST divergence we must not swallow silently: an
-- OFFLINE order replayed from a device whose cached menu is stale was quoted to
-- the diner at yesterday's price and will now be billed at today's. Overriding
-- without a trace would leave the owner unable to explain the receipt.
--
-- So every re-priced line is recorded here as
--   [{ "menuItemId": uuid, "name": text, "clientPrice": num,
--      "serverPrice": num, "qty": num }, ...]
-- NULL (the overwhelming majority of orders) = client and menu agreed, or the
-- caller was a trusted channel whose platform price is authoritative.
--
-- Additive and nullable — no backfill, no default, no rewrite of existing rows.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS price_adjustments JSONB;

COMMENT ON COLUMN orders.price_adjustments IS
  'NP-201 audit trail: lines whose client-proposed price disagreed with the '
  'menu and were re-priced server-side. Array of '
  '{menuItemId, name, clientPrice, serverPrice, qty}; NULL when no line diverged.';

-- Partial index so "which bills did we re-price?" (owner-facing report /
-- support triage) never scans the whole orders table. Tiny: only the
-- divergent minority of orders is indexed.
CREATE INDEX IF NOT EXISTS idx_orders_price_adjustments
  ON orders (business_id, created_at DESC)
  WHERE price_adjustments IS NOT NULL;
