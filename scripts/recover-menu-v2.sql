-- Menu recovery v2 for <owner-email>
-- Business ID: <business_id>
--
-- WHAT'S DIFFERENT vs v1:
--   • reorder_level = price (your preference)
--   • Modifier groups are CATEGORY-SPECIFIC — no "Extra Cheese" on Lime Soda
--   • Real VARIANTS added (Half/Full plate, Single/Double, etc.) — separate
--     from modifier_groups, captured in menu_item_variants table
--   • Mappings are tight: each item gets only the groups that make sense
--
-- IMPORTANT — DESTRUCTIVE SECTIONS ARE COMMENTED OUT.
--   If you already ran v1, the existing wrong modifier links + items are still
--   there. To start clean, uncomment the "OPTIONAL CLEANUP" block at the top
--   AFTER you've reviewed it. Nothing else in this script deletes anything.
--
-- Run with:
--   psql namastepos -v business_id="'<uuid>'" -f scripts/recover-menu-v2.sql

BEGIN;

-- ── Sanity check ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = :'business_id') THEN
    RAISE EXCEPTION 'Business <business_id> not found.';
  END IF;
END $$;

-- ── OPTIONAL CLEANUP (uncomment to wipe v1 data first) ─────────────────
--
-- Uncomment ONLY if you want to drop the v1 menu/modifier rows entirely
-- and start fresh. Order matters (junction tables first, then parents).
--
-- DELETE FROM item_modifier_groups   WHERE menu_item_id IN
--   (SELECT id FROM menu_items WHERE business_id = :'business_id');
-- DELETE FROM menu_item_variants     WHERE menu_item_id IN
--   (SELECT id FROM menu_items WHERE business_id = :'business_id');
-- DELETE FROM modifiers              WHERE business_id = :'business_id';
-- DELETE FROM modifier_groups        WHERE business_id = :'business_id';
-- DELETE FROM menu_items             WHERE business_id = :'business_id';

-- ── Update reorder_level on EXISTING items (your preference: = price) ──
UPDATE menu_items
   SET reorder_level = price
 WHERE business_id = :'business_id';

-- ── Add modifier groups (skip if v1 already created them — uniq constraint) ──
-- 1. Lime soda style — applies ONLY to Fresh Lime Soda
-- 2. Lassi flavour — applies to Mango Lassi
-- 3. Chai sweetness — for Chai/Coffee
-- 4. Curry spice level — for North/South Indian curries
-- 5. Dosa add-ons — for Dosa items
-- 6. Naan/Bread choice — for North Indian gravies (paired)
-- 7. Chutney choice — for South Indian items
-- 8. Snack chutney — for Snacks
INSERT INTO modifier_groups (business_id, name, kind, min_select, max_select, display_order) VALUES
  (:'business_id', 'Lime soda style', 'single_select', 1, 1, 10),
  (:'business_id', 'Lassi flavour',   'single_select', 1, 1, 11),
  (:'business_id', 'Chai sweetness',  'single_select', 1, 1, 12),
  (:'business_id', 'Curry spice',     'single_select', 1, 1, 13),
  (:'business_id', 'Dosa add-ons',    'multi_select',  0, 4, 14),
  (:'business_id', 'Chutney choice',  'multi_select',  0, 3, 15),
  (:'business_id', 'Snack chutney',   'multi_select',  0, 2, 16)
ON CONFLICT (business_id, name) DO NOTHING;

-- ── Modifier options per group ─────────────────────────────────────────
-- Lime soda style
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('Sweet',         10),
  ('Salted',        20),
  ('Sweet & Salt',  30)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Lime soda style'
ON CONFLICT (group_id, name) DO NOTHING;

-- Lassi flavour
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, v.delta, v.ord
FROM modifier_groups mg, (VALUES
  ('Mango',     0,  10),
  ('Sweet',     0,  20),
  ('Salted',    0,  30),
  ('Rose',     10,  40),
  ('Strawberry', 20, 50)
) AS v(name, delta, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Lassi flavour'
ON CONFLICT (group_id, name) DO NOTHING;

-- Chai sweetness
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('No sugar',    10),
  ('Less sugar',  20),
  ('Normal',      30),
  ('Extra sweet', 40)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Chai sweetness'
ON CONFLICT (group_id, name) DO NOTHING;

-- Curry spice
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('Mild',     10),
  ('Medium',   20),
  ('Spicy',    30),
  ('Extra hot', 40)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Curry spice'
ON CONFLICT (group_id, name) DO NOTHING;

-- Dosa add-ons
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, v.delta, v.ord
FROM modifier_groups mg, (VALUES
  ('Extra cheese',  30, 10),
  ('Extra masala',  15, 20),
  ('Extra ghee',    10, 30),
  ('Onion stuffing',15, 40)
) AS v(name, delta, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Dosa add-ons'
ON CONFLICT (group_id, name) DO NOTHING;

-- Chutney choice (South Indian)
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('Coconut',  10),
  ('Tomato',   20),
  ('Coriander',30),
  ('Sambar (extra)', 40)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Chutney choice'
ON CONFLICT (group_id, name) DO NOTHING;

-- Snack chutney
INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, display_order)
SELECT :'business_id', id, v.name, 0, v.ord
FROM modifier_groups mg, (VALUES
  ('Mint',     10),
  ('Tamarind', 20),
  ('Red chilli', 30)
) AS v(name, ord)
WHERE mg.business_id = :'business_id' AND mg.name = 'Snack chutney'
ON CONFLICT (group_id, name) DO NOTHING;


-- ── INTELLIGENT mapping: each item → only the groups that make sense ──
-- Fresh Lime Soda → Lime soda style ONLY
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Fresh Lime Soda'
  AND mg.business_id = mi.business_id
  AND mg.name = 'Lime soda style'
ON CONFLICT DO NOTHING;

-- Mango Lassi → Lassi flavour
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Mango Lassi'
  AND mg.business_id = mi.business_id
  AND mg.name = 'Lassi flavour'
ON CONFLICT DO NOTHING;

-- All Chai/Coffee → Chai sweetness
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.category = 'Chai/Coffee'
  AND mg.business_id = mi.business_id
  AND mg.name = 'Chai sweetness'
ON CONFLICT DO NOTHING;

-- All North Indian gravy/curry → Curry spice
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.category = 'North Indian'
  AND mi.name IN ('Paneer Butter Masala', 'Dal Tadka', 'Aloo Gobi')
  AND mg.business_id = mi.business_id
  AND mg.name = 'Curry spice'
ON CONFLICT DO NOTHING;

-- Dosa items → Dosa add-ons + Chutney choice
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.name IN ('Masala Dosa', 'Plain Dosa')
  AND mg.business_id = mi.business_id
  AND mg.name IN ('Dosa add-ons', 'Chutney choice')
ON CONFLICT DO NOTHING;

-- Idli/Vada/Uttapam → Chutney choice
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.name IN ('Idli (3 pcs)', 'Medu Vada', 'Uttapam')
  AND mg.business_id = mi.business_id
  AND mg.name = 'Chutney choice'
ON CONFLICT DO NOTHING;

-- Snacks (samosa/pakora/vada-pav/bhel) → Snack chutney
INSERT INTO item_modifier_groups (menu_item_id, group_id, display_order)
SELECT mi.id, mg.id, mg.display_order
FROM menu_items mi, modifier_groups mg
WHERE mi.business_id = :'business_id'
  AND mi.category = 'Snacks'
  AND mg.business_id = mi.business_id
  AND mg.name = 'Snack chutney'
ON CONFLICT DO NOTHING;


-- ── VARIANTS — size/portion options that CHANGE the base item ──────────
-- Note: variants belong in menu_item_variants table (separate from
-- modifier_groups). They typically represent Half/Full, regular/large, etc.

-- Half / Full plate for North Indian gravies
INSERT INTO menu_item_variants (business_id, menu_item_id, label, price, display_order, is_active)
SELECT mi.business_id, mi.id, v.label, v.price, v.ord, TRUE
FROM menu_items mi, (VALUES
  ('Half',     130, 10),
  ('Full',     220, 20)
) AS v(label, price, ord)
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Paneer Butter Masala'
ON CONFLICT DO NOTHING;

INSERT INTO menu_item_variants (business_id, menu_item_id, label, price, display_order, is_active)
SELECT mi.business_id, mi.id, v.label, v.price, v.ord, TRUE
FROM menu_items mi, (VALUES
  ('Half',      90, 10),
  ('Full',     150, 20)
) AS v(label, price, ord)
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Dal Tadka'
ON CONFLICT DO NOTHING;

-- Single / Double for Vada Pav
INSERT INTO menu_item_variants (business_id, menu_item_id, label, price, display_order, is_active)
SELECT mi.business_id, mi.id, v.label, v.price, v.ord, TRUE
FROM menu_items mi, (VALUES
  ('Single', 35, 10),
  ('Double', 65, 20)
) AS v(label, price, ord)
WHERE mi.business_id = :'business_id'
  AND mi.name = 'Vada Pav'
ON CONFLICT DO NOTHING;

-- Large variant for hot beverages (base item IS the regular size)
INSERT INTO menu_item_variants (business_id, menu_item_id, label, price, display_order, is_active)
SELECT mi.business_id, mi.id, v.label, v.price, v.ord, TRUE
FROM menu_items mi
CROSS JOIN LATERAL (VALUES
  ('Large', ROUND(mi.price * 1.5)::numeric, 20)
) AS v(label, price, ord)
WHERE mi.business_id = :'business_id'
  AND mi.name IN ('Masala Chai', 'Ginger Chai', 'Filter Coffee')
ON CONFLICT DO NOTHING;

-- Small / Large for cold drinks (base item is the regular size)
INSERT INTO menu_item_variants (business_id, menu_item_id, label, price, display_order, is_active)
SELECT mi.business_id, mi.id, v.label, v.price, v.ord, TRUE
FROM menu_items mi
CROSS JOIN LATERAL (VALUES
  ('Small', ROUND(mi.price * 0.7)::numeric, 10),
  ('Large', ROUND(mi.price * 1.4)::numeric, 30)
) AS v(label, price, ord)
WHERE mi.business_id = :'business_id'
  AND mi.name IN ('Mango Lassi', 'Cold Coffee')
ON CONFLICT DO NOTHING;


COMMIT;

-- ── Verify: print what's mapped ───────────────────────────────────────
SELECT mi.name AS item, mg.name AS group_name
FROM item_modifier_groups img
JOIN menu_items mi ON mi.id = img.menu_item_id
JOIN modifier_groups mg ON mg.id = img.group_id
WHERE mi.business_id = :'business_id'
ORDER BY mi.category, mi.name, mg.display_order;

SELECT mi.name AS item, v.label, v.price
FROM menu_item_variants v
JOIN menu_items mi ON mi.id = v.menu_item_id
WHERE mi.business_id = :'business_id'
ORDER BY mi.category, mi.name, v.display_order;
