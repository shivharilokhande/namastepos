-- Migration 019 — Reservations + wait list (Sprint 3 / FF-505)

DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM
    ('booked','confirmed','seated','no_show','cancelled','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  table_id        UUID REFERENCES tables(id) ON DELETE SET NULL,
  customer_name   VARCHAR(255) NOT NULL,
  customer_phone  VARCHAR(20) NOT NULL,
  customer_email  CITEXT,
  party_size      INTEGER NOT NULL CHECK (party_size > 0),
  reserved_at     TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER NOT NULL DEFAULT 90,
  status          reservation_status NOT NULL DEFAULT 'booked',
  special_requests TEXT,
  source          VARCHAR(40) DEFAULT 'phone',  -- phone, walk_up, web, google
  reminder_sent_at TIMESTAMPTZ,
  arrived_at      TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reservations_business_date
  ON reservations (business_id, reserved_at) WHERE status IN ('booked','confirmed');
CREATE INDEX IF NOT EXISTS idx_reservations_table_date
  ON reservations (table_id, reserved_at) WHERE table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_phone
  ON reservations (business_id, customer_phone);

DROP TRIGGER IF EXISTS trg_reservations_updated ON reservations;
CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS wait_list (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name   VARCHAR(255) NOT NULL,
  customer_phone  VARCHAR(20) NOT NULL,
  party_size      INTEGER NOT NULL CHECK (party_size > 0),
  estimated_wait_min INTEGER,
  status          VARCHAR(20) NOT NULL DEFAULT 'waiting',  -- waiting | seated | left
  notified_at     TIMESTAMPTZ,
  seated_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wait_list_business
  ON wait_list (business_id, status, created_at);
