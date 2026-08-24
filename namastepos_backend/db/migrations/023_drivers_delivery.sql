-- Migration 023 — Driver / delivery rider management (Sprint 7 / FF-703)

CREATE TABLE IF NOT EXISTS drivers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  phone           VARCHAR(20) NOT NULL,
  vehicle_no      VARCHAR(20),
  vehicle_type    VARCHAR(20),   -- bike, scooter, car, cycle
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_on_duty      BOOLEAN NOT NULL DEFAULT FALSE,
  current_lat     NUMERIC(10,7),
  current_lng     NUMERIC(10,7),
  last_ping_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_driver_phone UNIQUE (business_id, phone)
);

CREATE TABLE IF NOT EXISTS delivery_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id       UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'assigned',  -- assigned | picked_up | delivered | failed
  delivery_address TEXT,
  delivery_lat    NUMERIC(10,7),
  delivery_lng    NUMERIC(10,7),
  distance_km     NUMERIC(5,2),
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_up_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  proof_signature TEXT,
  proof_photo_url TEXT,
  CONSTRAINT uq_delivery_order UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_driver_status
  ON delivery_assignments (driver_id, status);
