-- NamastePOS migration 013 — Item variants + modifier groups
-- Sprint 1 / Story FF-201 + FF-202.
--
-- Variants:
--   Same item, multiple price points. Pizza · Medium ₹299, Pizza · Large ₹449.
--   A variant inherits the parent's category/veg flag/etc but can override
--   stock, recipe, image and price.
--
-- Modifiers:
--   Customer-side customisation. "Extra cheese ₹30", "No onion", "Spice: Hot".
--   Grouped (Spice = single-select required; Toppings = multi-select optional).
--
-- Order lines now store the selected variant + modifier list per-line.

-- ── 1. menu_item_variants ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_item_variants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  label           VARCHAR(80) NOT NULL,           -- "Half", "Full", "Medium"
  price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  cost_price      NUMERIC(10,2) CHECK (cost_price IS NULL OR cost_price >= 0),
  sku             VARCHAR(50),
  stock           NUMERIC(10,2),                  -- NULL = share parent stock
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  display_order   INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_variant_label UNIQUE (menu_item_id, label)
);
CREATE INDEX IF NOT EXISTS idx_variant_item ON menu_item_variants(menu_item_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_variants_updated ON menu_item_variants;
CREATE TRIGGER trg_variants_updated BEFORE UPDATE ON menu_item_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. modifier_groups ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE modifier_group_kind AS ENUM ('single_select','multi_select');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS modifier_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  kind            modifier_group_kind NOT NULL DEFAULT 'single_select',
  min_select      INTEGER NOT NULL DEFAULT 0,
  max_select      INTEGER NOT NULL DEFAULT 1,
  display_order   INTEGER NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_modgroup UNIQUE (business_id, name),
  CONSTRAINT chk_modgroup_range CHECK (min_select >= 0 AND max_select >= min_select)
);

-- ── 3. modifiers (the actual options inside a group) ─────────────────────
CREATE TABLE IF NOT EXISTS modifiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id            UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name                VARCHAR(100) NOT NULL,
  price_delta_inr     NUMERIC(10,2) NOT NULL DEFAULT 0,    -- can be negative
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  display_order       INTEGER NOT NULL DEFAULT 100,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_modifier_name UNIQUE (group_id, name)
);

-- ── 4. item ↔ modifier_group link ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_modifier_groups (
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id        UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  display_order   INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (menu_item_id, group_id)
);

-- ── 5. order_items: variant + modifier capture ───────────────────────────
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS variant_id      UUID REFERENCES menu_item_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_label   VARCHAR(80),   -- denormalised snapshot
  ADD COLUMN IF NOT EXISTS modifier_lines  JSONB;         -- [{ modifierId, name, price_delta_inr, qty }]

-- ── 6. menu_items: 86 / out-of-stock flag (Story FF-401) ─────────────────
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS sold_out_until TIMESTAMPTZ;   -- NULL = available

CREATE INDEX IF NOT EXISTS idx_menu_sold_out
  ON menu_items(business_id) WHERE sold_out_until IS NOT NULL;
