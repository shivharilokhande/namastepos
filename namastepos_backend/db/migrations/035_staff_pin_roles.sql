-- Migration 035 — Staff roles + PIN login (Push 14a)
--
-- Adds three new staff roles (captain, waiter, kitchen) on top of the
-- existing owner/manager/cashier set, plus PIN auth so non-owner users
-- can sign in on shared devices without an email/password.
--
-- New tables / columns:
--   business_users.pin_hash    — bcrypt of 4-digit PIN (nullable; owner
--                                still uses email/password)
--   business_users.display_name — friendly label for staff-picker login
--   business_users.is_active   — already exists per migration 002; we
--                                rely on it for soft-delete
--
-- Tier caps for staff count live in plan_features as soft limits and
-- are enforced at the API layer (no DB constraint).

-- 1. Add new role values to the existing user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff_captain';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff_waiter';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff_kitchen';

-- 2. PIN + display_name on business_users
ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS pin_hash       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS display_name   VARCHAR(120);

-- Backfill display_name from users.display_name where missing
UPDATE business_users bu
   SET display_name = u.display_name
  FROM users u
 WHERE u.id = bu.user_id
   AND bu.display_name IS NULL;

-- 3. Index for the staff-picker login flow: list active staff for a biz
CREATE INDEX IF NOT EXISTS idx_business_users_biz_active
  ON business_users (business_id, is_active)
 WHERE is_active = TRUE;

-- 4. Soft-cap on number of active staff per tier (informational; the
--    API enforces this — DB constraint would be too rigid if Razorpay
--    downgrades happen mid-session)
COMMENT ON COLUMN business_users.pin_hash IS
  '4-digit PIN bcrypt for staff (non-owner) login on shared devices';
COMMENT ON COLUMN business_users.display_name IS
  'Friendly label shown in the mobile staff-picker login screen';
