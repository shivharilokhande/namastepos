-- Migration 017 — Item-level GST slabs (Sprint 2 / FF-901)

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2) NOT NULL DEFAULT 5.00
    CHECK (gst_pct IN (0, 5, 12, 18, 28));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gst_breakdown JSONB,    -- { "5": 12.50, "12": 30.00, ... }
  ADD COLUMN IF NOT EXISTS cgst NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS gst_pct      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS gst_amount   NUMERIC(10,2);

-- Business config: intra-state (CGST+SGST) vs inter-state (IGST)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS state_code VARCHAR(2);
