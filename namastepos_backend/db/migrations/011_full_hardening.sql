-- NamastePOS migration 011 — Full hardening (closes EVERYTHING remaining)
-- ──────────────────────────────────────────────────────────────────────────
-- Covers:
--   QA-8  2FA TOTP for super admins (admin_users + admin_2fa_pending)
--   QA-8  CSRF tokens table (for httpOnly cookie refresh flow)
--   QA-9  Customer.tier_locked_at to avoid per-order tier recompute
--   QA-10 Remaining perf/P2 indexes flagged by Vivek + Priya
--   QA-10 Loyalty tier helper materialized on the customer row
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. 2FA for super-admin team (TOTP) ────────────────────────────────────
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS totp_secret_enc  TEXT,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_codes   TEXT[];

CREATE TABLE IF NOT EXISTS admin_2fa_pending (
  challenge_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_2fa_pending_admin
  ON admin_2fa_pending(admin_id, expires_at);

-- ── 2. CSRF tokens (for cookie-based refresh flow) ────────────────────────
-- Double-submit cookie pattern: same token in cookie + custom header.
-- Stored server-side only as a 1-hour rolling secret.
CREATE TABLE IF NOT EXISTS csrf_tokens (
  token_hash  CHAR(64) PRIMARY KEY,         -- sha256 hex
  user_id     UUID,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_csrf_expires ON csrf_tokens(expires_at);

-- ── 3. Loyalty perf — tier cache columns ──────────────────────────────────
-- Vivek perf #3: tier was recomputed on every order. Now we materialize
-- tier_locked_at + cached threshold so the order path becomes a cheap read.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tier_at_lifetime INTEGER,
  ADD COLUMN IF NOT EXISTS tier_locked_at   TIMESTAMPTZ DEFAULT NOW();

-- ── 4. P2 missing indexes (Priya + Vivek list) ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_customer_only
  ON loyalty_transactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_business_addons_status
  ON business_addons (business_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_expenses_business_category
  ON expenses (business_id, category, date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_active_business
  ON menu_items (business_id, is_active, category);

-- ── 5. Health check ───────────────────────────────────────────────────────
-- Used by /v1/health/db to verify the connection pool isn't wedged.
CREATE OR REPLACE FUNCTION health_db_ping() RETURNS TIMESTAMPTZ AS $$
  SELECT NOW();
$$ LANGUAGE sql STABLE;
