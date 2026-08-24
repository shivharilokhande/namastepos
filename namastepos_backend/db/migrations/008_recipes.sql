-- NamastePOS migration 008 — Recipe-based inventory
--
-- Ingredient model:
--   `ingredients` (raw materials) holds stock, unit, cost.
--   `recipes`     maps each menu_item → ingredients with quantities.
--   On order placement, we walk the recipe and deduct ingredient stock
--   (instead of just deducting the menu_item.stock counter).
--
-- Cost tracking:
--   ingredient.cost_per_unit_paise is updated via weighted-average on each
--   purchase. We snapshot the cost into the transaction at deduction time
--   so historical food-cost reports stay accurate even if prices change.

-- ── 1. Ingredients (raw materials) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingredients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  category        VARCHAR(50),                    -- 'grains','dairy','vegetables','spices','oils','meats','packaging','other'
  unit            VARCHAR(20) NOT NULL DEFAULT 'g', -- g, kg, ml, l, piece, pack
  stock           NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(12,3) NOT NULL DEFAULT 0,
  cost_per_unit_paise INTEGER NOT NULL DEFAULT 0,  -- weighted-average cost
  vendor          VARCHAR(255),
  vendor_phone    VARCHAR(20),
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ingredient_name UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ingredients_active
  ON ingredients(business_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ingredients_low
  ON ingredients(business_id) WHERE stock <= reorder_level AND is_active = TRUE;

DROP TRIGGER IF EXISTS trg_ingredients_updated ON ingredients;
CREATE TRIGGER trg_ingredients_updated BEFORE UPDATE ON ingredients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Recipes (menu_item → ingredients) ────────────────────────────────
CREATE TABLE IF NOT EXISTS recipes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty             NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_recipe UNIQUE (menu_item_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_item ON recipes(menu_item_id);

-- ── 3. Ingredient transactions (full stock movement log) ────────────────
DO $$ BEGIN
  CREATE TYPE ingredient_txn_kind AS ENUM
    ('purchase','sale','waste','adjustment','spoilage','reverse','manual_in','manual_out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ingredient_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty_change      NUMERIC(12,3) NOT NULL,             -- +ve in, -ve out
  balance_after   NUMERIC(12,3) NOT NULL,
  unit_cost_paise INTEGER,                            -- cost snapshot at the time
  kind            ingredient_txn_kind NOT NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  menu_item_id    UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  recipe_id       UUID REFERENCES recipes(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ingredient_txn_ingredient
  ON ingredient_transactions(ingredient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingredient_txn_business
  ON ingredient_transactions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingredient_txn_order
  ON ingredient_transactions(order_id);

-- ── 4. Capture cost-of-goods-sold per order_item ────────────────────────
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS food_cost_paise INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS food_cost_paise INTEGER NOT NULL DEFAULT 0;
