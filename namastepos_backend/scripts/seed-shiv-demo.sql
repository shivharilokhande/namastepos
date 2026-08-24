-- Seed a demo user + business + tables + menu.
-- Hardcode-audit fix (2026-08-24): demo identity is a psql variable, not a
-- committed personal email (which, combined with FF_DEV_LOGIN, granted
-- passwordless access to this tenant). Run with:
--   psql -d namastepos -v demo_email="'demo@example.com'" -v demo_name="'Demo Owner'" \
--     -f scripts/seed-shiv-demo.sql
BEGIN;

-- 1. User --------------------------------------------------------------
INSERT INTO users (google_sub, email, display_name, last_seen_at)
VALUES ('dev-' || :'demo_email',
        :'demo_email',
        :'demo_name',
        NOW())
ON CONFLICT (email) DO UPDATE SET last_seen_at = NOW();

-- 2. Business ----------------------------------------------------------
INSERT INTO businesses
  (google_sub, email, display_name, name, city, category, gstin, onboarded)
VALUES
  ('dev-' || :'demo_email',
   :'demo_email',
   :'demo_name',
   'Shiv''s Cafe', 'Pune', 'cafe', '27ABCDE1234F1Z5', TRUE)
ON CONFLICT (email) DO NOTHING;

-- 3. Membership --------------------------------------------------------
INSERT INTO business_users (business_id, user_id, role)
SELECT b.id, u.id, 'business_owner'
  FROM businesses b
  JOIN users u ON u.email = b.email
 WHERE b.email = :'demo_email'
ON CONFLICT (business_id, user_id) DO NOTHING;

-- 4. Free-trial subscription ------------------------------------------
INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at, current_period_end)
SELECT b.id, p.id, 'trialing', NOW() + INTERVAL '30 days', NOW() + INTERVAL '30 days'
  FROM businesses b, plans p
 WHERE b.email = :'demo_email' AND p.tier = 'free'
ON CONFLICT (business_id) DO NOTHING;

-- 5..7  Floor + tables + menu (gated so re-runs don't duplicate) -------
-- psql variables aren't substituted inside dollar-quoted blocks, so pass
-- the email through a session GUC instead.
SELECT set_config('ff.demo_email', :'demo_email', true);

DO $$
DECLARE
  biz_id  UUID;
  flr_id  UUID;
BEGIN
  SELECT id INTO biz_id FROM businesses WHERE email = current_setting('ff.demo_email');

  -- Floor (idempotent via uq_floor)
  INSERT INTO floors (business_id, name)
  VALUES (biz_id, 'Ground floor')
  ON CONFLICT (business_id, name) DO NOTHING;
  SELECT id INTO flr_id FROM floors WHERE business_id = biz_id LIMIT 1;

  -- Tables (idempotent via uq_table)
  INSERT INTO tables (business_id, floor_id, label, seats, shape, status, x_pos, y_pos)
  VALUES
    (biz_id, flr_id, '1', 4, 'square',    'available', 0,   0),
    (biz_id, flr_id, '2', 4, 'square',    'available', 220, 0),
    (biz_id, flr_id, '3', 2, 'round',     'available', 0,   220),
    (biz_id, flr_id, '4', 6, 'rectangle', 'available', 220, 220)
  ON CONFLICT (business_id, floor_id, label) DO NOTHING;

  -- Menu items (idempotent via uq_menu_sku)
  INSERT INTO menu_items (business_id, name, price, category, is_veg, is_active, sku, stock, reorder_level)
  VALUES
    (biz_id, 'Paneer Tikka',         250, 'Starters',  TRUE,  TRUE, 'PT01',  50, 10),
    (biz_id, 'Chicken 65',           280, 'Starters',  FALSE, TRUE, 'CH01',  40, 10),
    (biz_id, 'Veg Manchurian',       220, 'Starters',  TRUE,  TRUE, 'VM01',  40, 10),
    (biz_id, 'Butter Naan',           40, 'Breads',    TRUE,  TRUE, 'BN01', 100, 30),
    (biz_id, 'Tandoori Roti',         25, 'Breads',    TRUE,  TRUE, 'TR01', 100, 30),
    (biz_id, 'Paneer Butter Masala', 320, 'Main',      TRUE,  TRUE, 'PBM01', 30, 10),
    (biz_id, 'Dal Tadka',            180, 'Main',      TRUE,  TRUE, 'DT01',  40, 10),
    (biz_id, 'Masala Chai',           30, 'Beverages', TRUE,  TRUE, 'CH02', 100, 30)
  ON CONFLICT (business_id, sku) DO NOTHING;
END $$;

COMMIT;

-- Show what got seeded
SELECT 'User'       AS what, email::text  AS detail FROM users      WHERE email = :'demo_email'
UNION ALL
SELECT 'Business',  name::text             FROM businesses WHERE email = :'demo_email'
UNION ALL
SELECT 'Floors',    COUNT(*)::text         FROM floors
   WHERE business_id = (SELECT id FROM businesses WHERE email = :'demo_email')
UNION ALL
SELECT 'Tables',    COUNT(*)::text         FROM tables
   WHERE business_id = (SELECT id FROM businesses WHERE email = :'demo_email')
UNION ALL
SELECT 'Menu items', COUNT(*)::text        FROM menu_items
   WHERE business_id = (SELECT id FROM businesses WHERE email = :'demo_email');
