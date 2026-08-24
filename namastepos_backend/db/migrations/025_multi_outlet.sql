-- Migration 025 — Multi-outlet / franchise (Sprint 8 / FF-1201, FF-1202, FF-1203)

CREATE TABLE IF NOT EXISTS outlet_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  parent_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outlet_group_id UUID REFERENCES outlet_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outlet_label    VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_business_outlet_group
  ON businesses (outlet_group_id) WHERE outlet_group_id IS NOT NULL;

-- Inter-outlet stock transfers
CREATE TABLE IF NOT EXISTS stock_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_group_id UUID NOT NULL REFERENCES outlet_groups(id) ON DELETE CASCADE,
  from_business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  to_business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id   UUID REFERENCES ingredients(id) ON DELETE SET NULL,
  menu_item_id    UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  qty             NUMERIC(10,3) NOT NULL,
  unit            VARCHAR(20),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | in_transit | received | rejected
  initiated_by_user_id UUID REFERENCES users(id),
  received_by_user_id  UUID REFERENCES users(id),
  initiated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at     TIMESTAMPTZ,
  notes           TEXT
);

-- Centralized prices for a franchise group (override per outlet allowed)
CREATE TABLE IF NOT EXISTS franchise_prices (
  outlet_group_id UUID NOT NULL REFERENCES outlet_groups(id) ON DELETE CASCADE,
  menu_item_sku   VARCHAR(80) NOT NULL,    -- common SKU across outlets
  price           NUMERIC(10,2) NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (outlet_group_id, menu_item_sku)
);
