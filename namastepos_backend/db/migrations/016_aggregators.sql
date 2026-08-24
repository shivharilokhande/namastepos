-- Migration 016 — Aggregator (Zomato/Swiggy) ingestion
-- Sprint 2 / FF-101, FF-102, FF-103, FF-104.

-- Per-tenant credentials + auto-accept setting
CREATE TABLE IF NOT EXISTS aggregator_credentials (
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider       VARCHAR(20) NOT NULL CHECK (provider IN ('zomato','swiggy','dunzo','magicpin')),
  outlet_id      VARCHAR(100),
  api_key        TEXT,
  webhook_secret TEXT,
  auto_accept    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, provider)
);

-- External-SKU mapping per menu item
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS external_skus JSONB;  -- { zomato: "...", swiggy: "..." }

CREATE INDEX IF NOT EXISTS idx_menu_external_skus
  ON menu_items USING GIN (external_skus);

-- Track aggregator orders distinctly so reports can split them
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS aggregator_order_id  VARCHAR(80),
  ADD COLUMN IF NOT EXISTS aggregator_payload   JSONB,
  ADD COLUMN IF NOT EXISTS aggregator_status    VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aggregator_order_id
  ON orders (business_id, aggregator_order_id) WHERE aggregator_order_id IS NOT NULL;

-- Unmapped-SKU warnings surface to the UI
CREATE TABLE IF NOT EXISTS aggregator_mapping_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider        VARCHAR(20) NOT NULL,
  external_sku    VARCHAR(80) NOT NULL,
  external_name   VARCHAR(255),
  count_seen      INTEGER NOT NULL DEFAULT 1,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_mapping_issue UNIQUE (business_id, provider, external_sku)
);
