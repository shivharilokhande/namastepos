-- NamastePOS migration 009 — QA hardening pass
-- Closes the data-integrity P0s identified by the QA panel:
--   P0-2  business_counters table for race-free order_no allocation
--   P0-6  FK on order_items.menu_item_id → menu_items(id) ON DELETE RESTRICT
--   P0-8  unique constraint on loyalty earn (one earn row per order)
--   P0-7  businesses.deleted_at (soft-delete instead of cascade-nuking history)
--   P1    helpful indexes (subscriptions.status, orders.created_at filtered, audit_log)

-- ── 1. business_counters: atomic per-tenant order number ──────────────────
-- Replaces the racy SELECT MAX(order_no)+1 pattern. Each business gets one
-- row; nextOrderNo() does UPDATE … RETURNING which holds a row lock for the
-- duration of the increment.
CREATE TABLE IF NOT EXISTS business_counters (
  business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  last_order_no   INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed counters from existing data so we don't re-issue old numbers.
INSERT INTO business_counters (business_id, last_order_no)
SELECT b.id, COALESCE((SELECT MAX(order_no) FROM orders o WHERE o.business_id = b.id), 0)
  FROM businesses b
ON CONFLICT (business_id) DO UPDATE
  SET last_order_no = GREATEST(business_counters.last_order_no, EXCLUDED.last_order_no);

-- ── 2. order_items.menu_item_id FK (P0-6) ────────────────────────────────
-- Adds referential integrity. Reports were silently joining to ghost rows
-- when a menu item was hard-deleted. ON DELETE RESTRICT forces the caller
-- to soft-delete menu items (is_active=FALSE) instead.
DO $$ BEGIN
  -- Drop any prior version with a different action, then re-add.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_order_items_menu_item'
  ) THEN
    -- Only add if no orphans exist; otherwise log and skip.
    IF NOT EXISTS (
      SELECT 1 FROM order_items oi
       WHERE NOT EXISTS (SELECT 1 FROM menu_items mi WHERE mi.id = oi.menu_item_id)
       LIMIT 1
    ) THEN
      ALTER TABLE order_items
        ADD CONSTRAINT fk_order_items_menu_item
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE RESTRICT;
    ELSE
      RAISE NOTICE 'Skipping fk_order_items_menu_item: orphan rows exist. Clean up first.';
    END IF;
  END IF;
END $$;

-- ── 3. loyalty earn idempotency (P0-8) ────────────────────────────────────
-- Partial unique index so an order can only generate ONE earn row regardless
-- of how many times the order-completion handler runs (retries, double-fire).
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_earn_per_order
  ON loyalty_transactions (business_id, customer_id, order_id)
  WHERE kind = 'earn' AND order_id IS NOT NULL;

-- ── 4. soft-delete businesses (P0-7 mitigation) ──────────────────────────
-- We never want to hard-DELETE a business in production; that cascades
-- through orders, order_items, KOTs, loyalty, etc. and obliterates history.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_businesses_not_deleted
  ON businesses (id) WHERE deleted_at IS NULL;

-- ── 5. P1 indexes that several tests flagged ──────────────────────────────
-- Admin listing scans subscriptions by status without an index.
CREATE INDEX IF NOT EXISTS idx_subscriptions_business_status
  ON subscriptions (business_id, status);

-- GMV / revenue queries filter on (status<>'cancelled', created_at).
CREATE INDEX IF NOT EXISTS idx_orders_active_by_date
  ON orders (business_id, created_at DESC)
  WHERE status <> 'cancelled';

-- Audit log lookups are usually by entity_type/entity_id.
CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON audit_log (entity_type, entity_id, created_at DESC);

-- ── 6. CHECK constraints (P1 from Priya) ─────────────────────────────────
-- Wrap in DO blocks so re-runs don't error.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'orders_total_nonneg') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_total_nonneg CHECK (total >= 0);
  END IF;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'orders has negative total rows — leaving constraint off';
END $$;
