-- Rebrand FoodFlow → NamastePOS inside the DATABASE (2026-08-24).
-- The codebase rename is complete; this script migrates the data + names
-- that live in Postgres. NOTHING here drops anything.
--
-- STEP 1 — rename the database itself (run from psql connected to
-- `postgres`, NOT to the foodflow db; all other connections must be closed):
--
--   ALTER DATABASE foodflow RENAME TO namastepos;
--   ALTER DATABASE foodflow_test RENAME TO namastepos_test;   -- if it exists
--   ALTER ROLE foodflow RENAME TO namastepos;                  -- only if you use the `foodflow` role (docker/prod; local dev uses `shiv`)
--   -- NOTE: renaming a role clears its MD5 password — reset it:
--   -- ALTER ROLE namastepos WITH PASSWORD '<same-or-new-password>';
--
-- STEP 2 — run this file against the renamed db for the data rebrand:
--
--   psql -d namastepos -f scripts/rebrand-to-namastepos.sql

BEGIN;

-- Super-admin identities (both legacy and RBAC tables)
UPDATE super_admins SET email = replace(email, '@foodflow.in', '@namastepos.in')
 WHERE email LIKE '%@foodflow.in';
UPDATE admin_users  SET email = replace(email, '@foodflow.in', '@namastepos.in')
 WHERE email LIKE '%@foodflow.in';

-- Any stored brand strings
UPDATE compliance_settings
   SET legal_entity_name = replace(legal_entity_name, 'FoodFlow', 'NamastePOS')
 WHERE legal_entity_name LIKE '%FoodFlow%';

-- Platform settings KV — brand name / support email style values
-- value is JSONB — cast through text for the replace
UPDATE platform_settings
   SET value = replace(replace(value::text, 'FoodFlow', 'NamastePOS'), 'foodflow.in', 'namastepos.in')::jsonb
 WHERE value::text LIKE '%FoodFlow%' OR value::text LIKE '%foodflow.in%';

-- Show what changed
SELECT 'super_admins' AS t, email FROM super_admins WHERE email LIKE '%namastepos%'
UNION ALL
SELECT 'admin_users', email FROM admin_users WHERE email LIKE '%namastepos%';

COMMIT;

-- STEP 3 — after this, the super-admin login email is admin@namastepos.in
-- (matches SUPER_ADMIN_EMAIL in .env). If you also changed the password,
-- run: node scripts/rotate-super-admin.js
