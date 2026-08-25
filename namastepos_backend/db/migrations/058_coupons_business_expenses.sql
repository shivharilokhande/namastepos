-- 058: Real-world expense categories + business-scoped food coupons
--      (founder bugs #4 and #13, 25 Aug)

-- 1. New expense categories requested by pilot restaurants. NOTE: like 055,
--    the new enum values are only USED at runtime, never inside this
--    migration — Postgres forbids using a value in the transaction that
--    adds it.
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'chef_salary';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'helper_salary';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'staff_salary';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'gas';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'electricity';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'water';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'transport';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'equipment';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'cleaning';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'license_fees';

-- 2. Food coupons become business-owned (founder #13: "10% off upto ₹50").
--    NULL business_id = legacy/platform-wide coupon, still visible to all
--    businesses; owned rows are only visible to (and editable by) the owner.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
-- Cap for percent coupons: discount = min(subtotal * value%, max_discount_inr)
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS max_discount_inr NUMERIC(10,2);
CREATE INDEX IF NOT EXISTS idx_coupons_business ON coupons(business_id);
