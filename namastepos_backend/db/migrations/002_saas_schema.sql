-- NamastePOS SaaS migration 002
-- Adds: users, business_users (RBAC), plans, subscriptions, invoices,
--       payments, invitations, super_admins. Decouples user identity from
--       business identity so a user can belong to multiple businesses and a
--       business can have multiple users (staff).

-- ── ENUMs ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM
    ('business_owner', 'staff_manager', 'staff_cashier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE plan_tier AS ENUM ('free', 'basic', 'pro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM
    ('trialing','active','past_due','paused','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft','open','paid','void','uncollectible','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invitation_status AS ENUM ('pending','accepted','revoked','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. users (separated from businesses) ────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      VARCHAR(255) UNIQUE,
  email           CITEXT UNIQUE NOT NULL,
  display_name    VARCHAR(255),
  photo_url       TEXT,
  phone           VARCHAR(20),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: every existing business becomes a user (owner) of itself.
INSERT INTO users (id, google_sub, email, display_name, photo_url)
SELECT id, google_sub, email, display_name, photo_url
FROM businesses
ON CONFLICT (id) DO NOTHING;

-- ── 2. super_admins (platform operators — separate auth) ────────────────
CREATE TABLE IF NOT EXISTS super_admins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  display_name    VARCHAR(255),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. business_users (membership + role) ───────────────────────────────
CREATE TABLE IF NOT EXISTS business_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            user_role NOT NULL DEFAULT 'business_owner',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  invited_by      UUID REFERENCES users(id),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_business_user UNIQUE (business_id, user_id)
);

-- Backfill: every existing business → owner membership of itself
INSERT INTO business_users (business_id, user_id, role)
SELECT id, id, 'business_owner'::user_role
FROM businesses
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_bu_user     ON business_users(user_id);
CREATE INDEX IF NOT EXISTS idx_bu_business ON business_users(business_id);

-- ── 4. invitations (invite staff by email) ──────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email           CITEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'staff_cashier',
  token_hash      VARCHAR(64) UNIQUE NOT NULL,
  status          invitation_status NOT NULL DEFAULT 'pending',
  invited_by      UUID NOT NULL REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invitation UNIQUE (business_id, email, status)
);

-- ── 5. plans (catalog) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier            plan_tier NOT NULL UNIQUE,
  name            VARCHAR(50) NOT NULL,
  price_inr_paise INTEGER NOT NULL DEFAULT 0,    -- 29900 = ₹299
  billing_period  VARCHAR(20) NOT NULL DEFAULT 'monthly',  -- monthly|yearly
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  razorpay_plan_id VARCHAR(100),                  -- set after Razorpay plan creation
  limits          JSONB NOT NULL DEFAULT '{}'::jsonb,
  features        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the three default plans
INSERT INTO plans (tier, name, price_inr_paise, limits, features) VALUES
  ('free',  'Free',  0,
   '{"menu_items": 30, "monthly_orders": 200, "staff": 1, "businesses": 1}',
   '{"reports": "basic", "exports": false, "aggregators": false, "support": "community"}'),
  ('basic', 'Basic', 29900,
   '{"menu_items": 200, "monthly_orders": 2000, "staff": 3, "businesses": 1}',
   '{"reports": "advanced", "exports": true, "aggregators": false, "support": "email"}'),
  ('pro',   'Pro',   79900,
   '{"menu_items": -1, "monthly_orders": -1, "staff": -1, "businesses": 3}',
   '{"reports": "advanced", "exports": true, "aggregators": true, "support": "priority"}')
ON CONFLICT (tier) DO UPDATE
  SET name = EXCLUDED.name,
      price_inr_paise = EXCLUDED.price_inr_paise,
      limits = EXCLUDED.limits,
      features = EXCLUDED.features,
      updated_at = NOW();

-- ── 6. subscriptions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id         UUID NOT NULL REFERENCES plans(id),
  status          subscription_status NOT NULL DEFAULT 'trialing',
  trial_ends_at   TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at    TIMESTAMPTZ,
  razorpay_subscription_id VARCHAR(100),
  razorpay_customer_id     VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_sub_period_end ON subscriptions(current_period_end);

-- Backfill: every existing business → 14-day Free trial
INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at, current_period_end)
SELECT b.id,
       (SELECT id FROM plans WHERE tier = 'free'),
       'trialing'::subscription_status,
       NOW() + INTERVAL '14 days',
       NOW() + INTERVAL '14 days'
FROM businesses b
ON CONFLICT (business_id) DO NOTHING;

-- ── 7. invoices ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  number          VARCHAR(50) UNIQUE,             -- e.g. INV-2026-000123
  status          invoice_status NOT NULL DEFAULT 'open',
  amount_paise    INTEGER NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  due_at          TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  razorpay_invoice_id VARCHAR(100),
  pdf_url         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_business ON invoices(business_id, created_at DESC);

-- ── 8. payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_paise    INTEGER NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  method          VARCHAR(20),                    -- upi|card|netbanking|wallet
  razorpay_payment_id VARCHAR(100) UNIQUE,
  status          VARCHAR(20) NOT NULL DEFAULT 'captured',
  failure_reason  TEXT,
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 9. webhook_events (for idempotency + replay) ────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        VARCHAR(20) NOT NULL,           -- razorpay|stripe|...
  external_id     VARCHAR(255) UNIQUE NOT NULL,   -- provider's event id
  event_type      VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 10. usage_counters (for plan-limit enforcement) ─────────────────────
CREATE TABLE IF NOT EXISTS usage_counters (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  metric          VARCHAR(50) NOT NULL,            -- monthly_orders|...
  period          VARCHAR(10) NOT NULL,            -- 'YYYY-MM'
  count           INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, metric, period)
);

-- ── Triggers ────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_users_updated ON users;
DROP TRIGGER IF EXISTS trg_plans_updated ON plans;
DROP TRIGGER IF EXISTS trg_subs_updated  ON subscriptions;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_plans_updated BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subs_updated  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
