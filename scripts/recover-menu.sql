-- Menu recovery for <owner-email>
-- Business ID: <business_id>
--
-- Categories in menu_items.category are free-text varchar(50) — no separate
-- categories table. We use 6 categories appropriate for an Indian café/QSR.
--
-- WHAT THIS SCRIPT DOES (read before running):
--   1. INSERTs ~22 menu items across 6 categories
--   2. INSERTs 4 modifier groups (Size, Sugar Level, Spice Level, Add-ons)
--   3. INSERTs the option rows (modifiers) inside each group
--   4. LINKs modifier groups to relevant items via item_modifier_groups
--
-- THIS SCRIPT MAKES NO DELETIONS. Re-running it will fail on the second run
-- because of unique constraints — that's intentional, so you can't double-add.
-- If you need to re-run, hand-delete the rows you want to replace first.
--
-- Run with:
--   psql namastepos -v business_id="'<uuid>'" -f scripts/recover-menu.sql

BEGIN;

-- ── Sanity check: business exists ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = :'business_id') THEN
    RAISE EXCEPTION 'Business <business_id> not found. Check the email maps to this id.';
  END IF;
END $$;

-- ── Menu items ─────────────────────────────────────────────────────────
INSERT INTO menu_items (business_id, name, description, category, price, cost_price, stock, reorder_level, is_veg, is_active) VALUES
  -- Chai / Coffee
  (:'business_id', 'Masala Chai',         'Classic spiced milk tea',                'Chai/Coffee', 20,  6,  500, 50, TRUE, TRUE),
  (:'business_id', 'Ginger Chai',         'Fresh ginger tea',                       'Chai/Coffee', 25,  7,  500, 50, TRUE, TRUE),
  (:'business_id', 'Filter Coffee',       'South Indian filter coffee',             'Chai/Coffee', 30,  10, 300, 30, TRUE, TRUE),
  (:'business_id', 'Cold Coffee',         'Iced coffee with cream',                 'Chai/Coffee', 80,  30, 200, 20, TRUE, TRUE),

  -- Snacks
  (:'business_id', 'Samosa',              'Crispy potato + peas, two pieces',       'Snacks',      30,  10, 300, 30, TRUE, TRUE),
  (:'business_id', 'Vada Pav',            'Spiced potato fritter in bun',           'Snacks',      35,  12, 250, 30, TRUE, TRUE),
  (:'business_id', 'Bhel Puri',           'Puffed rice chaat with tamarind',        'Snacks',      50,  18, 200, 25, TRUE, TRUE),
  (:'business_id', 'Pakora Plate',        'Mixed vegetable fritters',               'Snacks',      80,  30, 150, 20, TRUE, TRUE),

  -- South Indian
  (:'business_id', 'Masala Dosa',         'Crispy crepe with potato filling',       'South Indian', 90,  30, 200, 25, TRUE, TRUE),
  (:'business_id', 'Plain Dosa',          'Crispy plain crepe',                     'South Indian', 70,  25, 200, 25, TRUE, TRUE),
  (:'business_id', 'Idli (3 pcs)',        'Steamed rice cakes with chutney',        'South Indian', 60,  20, 200, 25, TRUE, TRUE),
  (:'business_id', 'Medu Vada',           'Crispy lentil donuts (2 pcs)',           'South Indian', 70,  22, 150, 20, TRUE, TRUE),
  (:'business_id', 'Uttapam',             'Thick savoury pancake',                  'South Indian', 100, 35, 150, 20, TRUE, TRUE),

  -- North Indian
  (:'business_id', 'Paneer Butter Masala','Cottage cheese in rich tomato gravy',    'North Indian', 220, 90, 100, 15, TRUE, TRUE),
  (:'business_id', 'Dal Tadka',           'Yellow lentils with tempering',          'North Indian', 150, 50, 120, 15, TRUE, TRUE),
  (:'business_id', 'Aloo Gobi',           'Potato + cauliflower curry',             'North Indian', 160, 55, 100, 15, TRUE, TRUE),
  (:'business_id', 'Butter Naan',         'Tandoor-baked flatbread',                'North Indian', 40,  12, 200, 25, TRUE, TRUE),
  (:'business_id', 'Jeera Rice',          'Cumin-flavored basmati',                 'North Indian', 110, 35, 150, 20, TRUE, TRUE),

  -- Beverages
  (:'business_id', 'Fresh Lime Soda',     'Sweet or salted',                        'Beverages',    50,  15, 200, 25, TRUE, TRUE),
  (:'business_id', 'Mango Lassi',         'Sweet yogurt drink with mango',          'Beverages',    80,  30, 150, 20, TRUE, TRUE),

  -- Desserts
  (:'business_id', 'Gulab Jamun (2 pcs)', 'Warm milk-solids dumplings in syrup',    'Desserts',     60,  20, 150, 20, TRUE, TRUE),
  (:'business_id', 'Gajar Halwa',         'Slow-cooked carrot pudding',             'Desserts',     90,  35, 100, 15, TRUE, TRUE);


-- ── Modifier groups ────────────────────────────────────────────────────
INSERT INTO modifier_groups (business_id, name, kind, min_select, max_select, display_order) VALUES
  (:'business_id', 'Size',         'single_select', 1, 1, 10),
  (:'business_id', 'Sugar Level',  'single_select', 0, 1, 20),
  (:'business_id', 'Spice Level',  'single_select', 0, 1, 30),
  (:'business_id', 'Add-ons',      'multi_select',  0, 5, 40);


-- ── Modifier options (the actual choices inside each group) ────────────
-- Size
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, v.delta, v.ord
FROM modifier_groups mg, (VALUES
  ('Small',  -10, 10),
  ('Medium',   0, 20),
  ('Large',   20, 30)
) AS v(name, delta, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Size';

-- Sugar Level
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('No Sugar',     10),
  ('Less Sugar',   20),
  ('Normal',       30),
  ('Extra Sugar',  40)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Sugar Level';

-- Spice Level
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('Mild',    10),
  ('Medium',  20),
  ('Hot',     30),
  ('Extra Hot', 40)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Spice Level';

-- Add-ons
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, v.delta, v.ord
FROM modifier_groups mg, (VALUES
  ('Extra Cheese',  30, 10),
  ('Extra Butter',  15, 20),
  ('Extra Onion',   10, 30),
  ('Extra Chutney', 10, 40),
  ('Lemon Wedge',    5, 50)
) AS v(name, delta, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Add-ons';


-- ── Link modifier groups to relevant items ─────────────────────────────
-- Chai/Coffee items get Size + Sugar Level
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi
JOIN modifier_groups mg ON mg.business_id = mi.business_id
WHERE mi.business_id = :'business_id'
  AND mi.category = 'Chai/Coffee'
  AND mg.name IN ('Size', 'Sugar Level');

-- South Indian + North Indian items get Spice Level + Add-ons
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi
JOIN modifier_groups mg ON mg.business_id = mi.business_id
WHERE mi.business_id = :'business_id'
  AND mi.category IN ('South Indian', 'North Indian')
  AND mg.name IN ('Spice Level', 'Add-ons');

-- Snacks get Spice Level + Add-ons too
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi
JOIN modifier_groups mg ON mg.business_id = mi.business_id
WHERE mi.business_id = :'business_id'
  AND mi.category = 'Snacks'
  AND mg.name IN ('Spice Level', 'Add-ons');

-- Lassi gets Size
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi
JOIN modifier_groups mg ON mg.business_id = mi.business_id
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Mango Lassi'
  AND mg.name = 'Size';

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────
SELECT category, COUNT(*) AS items FROM menu_items
WHERE business_id = :'business_id'
GROUP BY category ORDER BY category;

SELECT mg.name AS group_name, COUNT(m.id) AS options
FROM modifier_groups mg LEFT JOIN modifiers m ON m.group_id = mg.id
WHERE mg.business_id = :'business_id'
GROUP BY mg.name ORDER BY mg.display_order;

SELECT mi.name AS item, mg.name AS group_name
FROM item_modifier_groups img
JOIN menu_items mi ON mi.id = img.menu_item_id
JOIN modifier_groups mg ON mg.id = img.group_id
WHERE mi.business_id = :'business_id'
ORDER BY mi.category, mi.name, mg.display_order;
