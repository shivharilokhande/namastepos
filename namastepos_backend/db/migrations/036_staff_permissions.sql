-- Migration 036 — Per-staff permission overrides (Push 14c).
--
-- Until now the mobile drawer + bottom nav decided what a staff member
-- could see based on their `role` alone (hardcoded map in
-- namastepos_flutter/lib/utils/role_permissions.dart). That worked for the
-- typical case but every business has weird configurations — a Captain
-- who ALSO settles bills, a Kitchen lead who manages the menu, etc.
--
-- Now each business_users row carries an explicit `permissions` array.
-- We seed it from the role's defaults on create, and the owner can
-- toggle individual permissions per-staff via the Staff edit screen.
--
-- Permission keys (must match namastepos_flutter/lib/utils/role_permissions.dart):
--   home, pos, orders, tables, reports, settings,
--   menu_editor, modifier_groups, customers, reservations, reviews,
--   wastage, daily_closing, kds, captain, driver, memberships,
--   surge, qr_codes, bill_template, thermal_printer, aggregators,
--   whatsapp_marketing, accounting, einvoice
--
-- Empty array = fall back to the role's defaults (so legacy rows behave
-- the same as before). Non-empty array overrides.

ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN business_users.permissions IS
  'Per-staff permission overrides (array of permission keys). Empty = use role defaults.';

-- No backfill: empty arrays mean "use the role's defaults", which is
-- already what existing rows behave like.
