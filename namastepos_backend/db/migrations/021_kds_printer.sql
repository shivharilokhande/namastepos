-- Migration 021 — KDS + printer queue (Sprint 5 / FF-603, FF-801, FF-802)

CREATE TABLE IF NOT EXISTS printers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(80) NOT NULL,
  kind            VARCHAR(20) NOT NULL,   -- bill | kot
  connection      VARCHAR(20) NOT NULL,   -- bluetooth | wifi | usb | network
  address         VARCHAR(120),           -- MAC / IP:port / device path
  paper_width_mm  INTEGER NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58, 80)),
  station_id      UUID REFERENCES kot_stations(id) ON DELETE SET NULL,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_printer_name UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  printer_id      UUID REFERENCES printers(id) ON DELETE SET NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  kot_ticket_id   UUID REFERENCES kot_tickets(id) ON DELETE SET NULL,
  kind            VARCHAR(20) NOT NULL,   -- bill | kot | duplicate
  payload_text    TEXT NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued | printing | done | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_queue
  ON print_jobs (business_id, status, created_at) WHERE status IN ('queued','printing');
