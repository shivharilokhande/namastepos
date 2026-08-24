-- NamastePOS · Migration 048 — Second launch bundle.
--
-- Tables + columns for:
--   • FF-330 Push notifications (device tokens per user)
--   • FF-331 Delivery zones + fees
--   • FF-332 Staff shifts + payroll periods
--   • FF-333 Referral program
--   • FF-329 Promo-code rules engine (extends existing coupons)
--   • FF-334 Late-delivery expected_ready_at + warning ledger
--   • FF-336 Weekly owner email digest send-log

-- ── FF-330 device tokens for FCM/APNS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id   UUID           REFERENCES businesses(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,        -- 'android' | 'ios' | 'web'
  token         TEXT NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token)
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_business
  ON device_tokens(business_id, last_seen_at DESC);

-- ── FF-331 delivery zones ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_zones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,        -- e.g. "Within 2km"
  fee_inr_paise BIGINT NOT NULL DEFAULT 0,
  min_order_inr_paise BIGINT NOT NULL DEFAULT 0,
  pincodes      TEXT[]  NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT     NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_zones_biz
  ON delivery_zones(business_id, display_order);

-- ── FF-332 staff shifts + payroll ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_shifts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  clock_in_at    TIMESTAMPTZ NOT NULL,
  clock_out_at   TIMESTAMPTZ,          -- null = still on shift
  hours_worked   NUMERIC(6,2),         -- computed on clock-out
  hourly_rate_inr NUMERIC(10,2),       -- captured at clock-in for audit
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_user_time
  ON staff_shifts(user_id, clock_in_at DESC);
-- Postgres refuses `DATE_TRUNC('month', clock_in_at)` AND `clock_in_at::date`
-- in index expressions because both are STABLE, not IMMUTABLE (they
-- depend on session timezone). A plain btree on the timestamptz
-- column supports the month-range queries perfectly well via
-- BETWEEN scans — the planner turns "clock_in_at BETWEEN X AND Y"
-- into a range lookup on this index.
CREATE INDEX IF NOT EXISTS idx_staff_shifts_biz_time
  ON staff_shifts(business_id, clock_in_at DESC);

-- Staff hourly rate lives on business_users so payroll math has a
-- source of truth. Older payroll systems use monthly salary; we
-- support both.
ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS hourly_rate_inr NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS monthly_salary_inr NUMERIC(10,2);

-- ── FF-333 referral program ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_biz_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code             TEXT UNIQUE NOT NULL,   -- shareable code
  referred_biz_id  UUID REFERENCES businesses(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' → shared but nobody signed up yet
  -- 'signed_up' → referred business created; award pending activation
  -- 'awarded'  → both parties got their 1-month bonus
  -- 'expired'  → 60d elapsed with no signup
  awarded_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals(referrer_biz_id, created_at DESC);

-- ── FF-329 promo rules — extends existing coupons ──────────────────────
-- The `coupons` table already exists (migration 003). We add rule
-- columns without touching the base so the /food-coupons UI keeps
-- working.
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS rule_type       TEXT DEFAULT 'flat',      -- 'flat' | 'first_order' | 'happy_hour' | 'min_basket'
  ADD COLUMN IF NOT EXISTS min_basket_inr  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS happy_hour_from TIME,
  ADD COLUMN IF NOT EXISTS happy_hour_to   TIME,
  ADD COLUMN IF NOT EXISTS max_uses_per_customer INT DEFAULT NULL;

-- ── FF-334 late-delivery expected_ready_at ─────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS expected_ready_at TIMESTAMPTZ;

-- ── FF-336 weekly digest send log ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_digest_log (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, week_start)
);
