-- NamastePOS SaaS migration 003 — admin platform features
-- Adds: admin_users (multi-admin RBAC), coupons, refunds, platform_settings,
--       feature_flags, support_notes, GST configuration, audit_log columns.

-- ── ENUMs ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE admin_role AS ENUM ('super_admin','finance','support','sales');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE coupon_type AS ENUM ('percent','flat','trial_extension');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE coupon_status AS ENUM ('active','disabled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE refund_status AS ENUM ('pending','processed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. admin_users (multi-admin RBAC, supersedes super_admins) ──────────
CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  display_name    VARCHAR(255),
  role            admin_role NOT NULL DEFAULT 'support',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  invited_by      UUID REFERENCES admin_users(id),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill from legacy super_admins
INSERT INTO admin_users (id, email, password_hash, display_name, role, last_login_at, created_at)
SELECT id, email, password_hash, display_name, 'super_admin'::admin_role,
       last_login_at, created_at
FROM super_admins
ON CONFLICT (email) DO NOTHING;

DROP TRIGGER IF EXISTS trg_admin_users_updated ON admin_users;
CREATE TRIGGER trg_admin_users_updated BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. coupons / promotions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(50) UNIQUE NOT NULL,
  description     TEXT,
  type            coupon_type NOT NULL,
  value           NUMERIC(10,2) NOT NULL,        -- 20 = 20% or ₹20 or 20 days
  applies_to_plan plan_tier,                     -- NULL = all paid plans
  max_redemptions INTEGER,                       -- NULL = unlimited
  redemption_count INTEGER NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  status          coupon_status NOT NULL DEFAULT 'active',
  created_by      UUID REFERENCES admin_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);

DROP TRIGGER IF EXISTS trg_coupons_updated ON coupons;
CREATE TRIGGER trg_coupons_updated BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-business redemptions
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id       UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT uq_redemption UNIQUE (coupon_id, business_id)
);

-- ── 3. refunds ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  payment_id      UUID REFERENCES payments(id) ON DELETE SET NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_paise    INTEGER NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  reason          TEXT,
  status          refund_status NOT NULL DEFAULT 'pending',
  razorpay_refund_id VARCHAR(100),
  initiated_by    UUID REFERENCES admin_users(id),
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refunds_business ON refunds(business_id, created_at DESC);

-- ── 4. platform_settings (KV store for platform config) ─────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key             VARCHAR(100) PRIMARY KEY,
  value           JSONB NOT NULL,
  description     TEXT,
  updated_by      UUID REFERENCES admin_users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (key, value, description) VALUES
  ('brand.name',        '"NamastePOS"',                          'Display name of the platform'),
  ('brand.support_email','"support@namastepos.in"',              'Support contact email'),
  ('platform.gstin',    '""',                                  'Platform GST registration number'),
  ('platform.hsn',      '"998314"',                            'HSN/SAC code for SaaS services in India'),
  ('platform.tax_pct',  '18',                                  'GST percentage on subscriptions (18%)'),
  ('platform.address',  '""',                                  'Registered office address for tax invoices'),
  ('platform.legal_name','"NamastePOS Technologies Pvt. Ltd."',  'Legal entity name'),
  ('feature.maintenance_mode', 'false',                        'When true, the API returns 503 for non-admin users'),
  ('feature.new_signups_open', 'true',                         'When false, /auth/google rejects new businesses')
ON CONFLICT (key) DO NOTHING;

-- ── 5. feature_flags (per-business or global) ───────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag            VARCHAR(100) NOT NULL,
  business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_flag UNIQUE (flag, business_id)
);

-- ── 6. support_notes (per-customer notes from admin team) ───────────────
CREATE TABLE IF NOT EXISTS support_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  admin_id        UUID NOT NULL REFERENCES admin_users(id),
  body            TEXT NOT NULL,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_business ON support_notes(business_id, created_at DESC);

-- ── 7. tax invoices (one per paid invoice, GST broken out) ──────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS subtotal_paise INTEGER,
  ADD COLUMN IF NOT EXISTS tax_paise      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_pct   NUMERIC(5,2) DEFAULT 18,
  ADD COLUMN IF NOT EXISTS hsn_code       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(50),
  ADD COLUMN IF NOT EXISTS customer_gstin VARCHAR(15),
  ADD COLUMN IF NOT EXISTS coupon_id      UUID REFERENCES coupons(id),
  ADD COLUMN IF NOT EXISTS discount_paise INTEGER DEFAULT 0;

-- ── 8. audit_log additional columns for admin_id ────────────────────────
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS admin_id UUID REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS module   VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module, created_at DESC);

-- ── 9. daily_metrics (pre-aggregated for dashboards) ────────────────────
CREATE TABLE IF NOT EXISTS daily_metrics (
  day             DATE PRIMARY KEY,
  total_businesses INTEGER NOT NULL DEFAULT 0,
  active_subscriptions INTEGER NOT NULL DEFAULT 0,
  trial_subscriptions  INTEGER NOT NULL DEFAULT 0,
  paid_subscriptions   INTEGER NOT NULL DEFAULT 0,
  mrr_paise       BIGINT NOT NULL DEFAULT 0,
  signups         INTEGER NOT NULL DEFAULT 0,
  churn           INTEGER NOT NULL DEFAULT 0,
  total_orders    INTEGER NOT NULL DEFAULT 0,
  total_gmv_paise BIGINT NOT NULL DEFAULT 0,
  payments_succeeded INTEGER NOT NULL DEFAULT 0,
  payments_failed    INTEGER NOT NULL DEFAULT 0
);
