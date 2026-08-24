-- Migration 053 — Phone OTP + aggregator merchant linking sessions.
-- 2026-08-22
--
-- Backs otpService (SMS OTP via MSG91) and aggregatorLinkService
-- (Zomato/Swiggy merchant linking flow).

BEGIN;

-- ── otp_requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  purpose       text NOT NULL,          -- 'signin' | 'aggregator_link' | ...
  code_hash     text NOT NULL,          -- bcrypt-hashed 6-digit code
  attempts      int  NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  verified_at   timestamptz,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_requests_phone_purpose_idx
  ON otp_requests (phone, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_requests_expires_at_idx
  ON otp_requests (expires_at)
  WHERE verified_at IS NULL;

-- ── aggregator_link_sessions ────────────────────────────────────────────
-- One row per attempt to link a Zomato/Swiggy merchant account by phone.
-- On successful OTP verification we upsert into aggregator_credentials.
CREATE TABLE IF NOT EXISTS aggregator_link_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider       text NOT NULL,          -- 'zomato' | 'swiggy'
  phone          text NOT NULL,
  otp_request_id uuid REFERENCES otp_requests(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'awaiting_otp',
                                          -- awaiting_otp | verified | linked | failed
  merchant_ref   text,                    -- outlet_id / restaurant_id once we know it
  raw_payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  linked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS aggregator_link_sessions_biz_provider_idx
  ON aggregator_link_sessions (business_id, provider, created_at DESC);

COMMIT;
