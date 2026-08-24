-- NamastePOS migration 007 — QR-code dine-in ordering
-- Each table gets a permanent QR token. Customer scans → opens menu in browser →
-- orders directly. Backend creates orders with source = 'qr'.

-- ── 1. Extend order_source enum ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'order_source'::regtype AND enumlabel = 'qr'
  ) THEN
    ALTER TYPE order_source ADD VALUE 'qr';
  END IF;
END$$;

-- ── 2. Per-table QR config ─────────────────────────────────────────────
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS qr_token   VARCHAR(255) UNIQUE,
  ADD COLUMN IF NOT EXISTS qr_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_tables_qr_token ON tables(qr_token);

-- ── 3. Per-business QR settings (branding, welcome text, etc.) ─────────
CREATE TABLE IF NOT EXISTS qr_settings (
  business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  welcome_title   VARCHAR(255) DEFAULT 'Welcome!',
  welcome_subtitle TEXT DEFAULT 'Scan, browse, order — no waiting.',
  brand_color     VARCHAR(7) DEFAULT '#FF6B35',
  require_phone   BOOLEAN NOT NULL DEFAULT TRUE,
  require_name    BOOLEAN NOT NULL DEFAULT FALSE,
  show_prices     BOOLEAN NOT NULL DEFAULT TRUE,
  show_veg_badge  BOOLEAN NOT NULL DEFAULT TRUE,
  auto_accept     BOOLEAN NOT NULL DEFAULT TRUE,         -- false = staff must approve
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_qr_settings_updated ON qr_settings;
CREATE TRIGGER trg_qr_settings_updated BEFORE UPDATE ON qr_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed defaults for existing businesses
INSERT INTO qr_settings (business_id)
SELECT id FROM businesses
ON CONFLICT (business_id) DO NOTHING;

-- ── 4. guest_sessions (track each phone's browsing session) ────────────
CREATE TABLE IF NOT EXISTS guest_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  table_id          UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  table_session_id  UUID REFERENCES table_sessions(id) ON DELETE SET NULL,
  customer_phone    VARCHAR(20),
  customer_name     VARCHAR(255),
  ip_address        VARCHAR(45),
  user_agent        VARCHAR(500),
  total_orders      INTEGER NOT NULL DEFAULT 0,
  total_inr         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_table
  ON guest_sessions(table_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_business
  ON guest_sessions(business_id, created_at DESC);
