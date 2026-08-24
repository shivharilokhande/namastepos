-- NamastePOS migration 006 — KOT routing + Table management
--
-- KOT routing:
--   Restaurant defines stations (Tandoor, Cold Counter, Bar…). Each menu item
--   is assigned to one station. When an order is placed, we generate one
--   ticket per station containing only that station's items, with its own
--   printer destination.
--
-- Tables:
--   Floors → Tables → Sessions. A session opens when guests are seated,
--   accumulates orders (split-bill friendly), closes on payment.

-- ── ENUMs ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE kot_status   AS ENUM ('pending','in_progress','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE table_status AS ENUM ('available','occupied','reserved','cleaning','blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE table_shape  AS ENUM ('round','square','rectangle','booth');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. KOT stations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kot_stations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             VARCHAR(100) NOT NULL,
  printer_address  VARCHAR(50),     -- BT MAC, NULL = uses default printer
  printer_paper_mm INTEGER NOT NULL DEFAULT 58,
  color            VARCHAR(7) DEFAULT '#FF6B35',     -- for floor-plan badges
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  display_order    INTEGER NOT NULL DEFAULT 100,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_station UNIQUE (business_id, name)
);

DROP TRIGGER IF EXISTS trg_kot_stations_updated ON kot_stations;
CREATE TRIGGER trg_kot_stations_updated BEFORE UPDATE ON kot_stations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Link menu_items → station ────────────────────────────────────────
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS kot_station_id UUID REFERENCES kot_stations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_menu_kot_station ON menu_items(kot_station_id);

-- ── 3. KOT tickets ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kot_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id      UUID NOT NULL REFERENCES kot_stations(id) ON DELETE CASCADE,
  ticket_no       INTEGER NOT NULL,
  status          kot_status NOT NULL DEFAULT 'pending',
  printed         BOOLEAN NOT NULL DEFAULT FALSE,
  printed_at      TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kot_ticket UNIQUE (business_id, order_id, station_id)
);
CREATE INDEX IF NOT EXISTS idx_kot_station_status
  ON kot_tickets(station_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kot_business_date
  ON kot_tickets(business_id, created_at DESC);

-- ── 4. KOT ticket items (a subset of order_items, scoped to that station) ──
CREATE TABLE IF NOT EXISTS kot_ticket_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES kot_tickets(id) ON DELETE CASCADE,
  order_item_id   UUID REFERENCES order_items(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  qty             NUMERIC(10,2) NOT NULL,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_kot_items_ticket ON kot_ticket_items(ticket_id);

-- ── 5. Floors (a restaurant can have Ground, First, Garden, …) ──────────
CREATE TABLE IF NOT EXISTS floors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_floor UNIQUE (business_id, name)
);

-- ── 6. Tables ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  floor_id        UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  label           VARCHAR(20) NOT NULL,             -- '1', 'A1', 'VIP-1'
  seats           INTEGER NOT NULL DEFAULT 4,
  shape           table_shape NOT NULL DEFAULT 'square',
  x_pos           INTEGER NOT NULL DEFAULT 0,       -- floor-plan grid cell
  y_pos           INTEGER NOT NULL DEFAULT 0,
  status          table_status NOT NULL DEFAULT 'available',
  current_session_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_table UNIQUE (business_id, floor_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tables_floor ON tables(floor_id);
CREATE INDEX IF NOT EXISTS idx_tables_status ON tables(business_id, status);

DROP TRIGGER IF EXISTS trg_tables_updated ON tables;
CREATE TRIGGER trg_tables_updated BEFORE UPDATE ON tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 7. Table sessions (one open per table at a time) ────────────────────
CREATE TABLE IF NOT EXISTS table_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  table_id          UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  guest_count       INTEGER NOT NULL DEFAULT 2,
  customer_phone    VARCHAR(20),
  customer_name     VARCHAR(255),
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'open',   -- open | closed
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  opened_by_user_id UUID REFERENCES users(id),
  closed_by_user_id UUID REFERENCES users(id),
  notes             TEXT,
  total_paise       INTEGER NOT NULL DEFAULT 0    -- denormalised, refreshed on close
);
CREATE INDEX IF NOT EXISTS idx_sessions_open
  ON table_sessions(business_id, status, opened_at DESC);
-- A table can have only one open session at a time:
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_session
  ON table_sessions(table_id) WHERE status = 'open';

-- Foreign-key the live pointer (after the sessions table exists)
-- (wrapped 2026-08-22: ADD CONSTRAINT isn't idempotent — broke the
--  second pass of scripts/test-migrations.sh)
DO $$ BEGIN
  ALTER TABLE tables
    ADD CONSTRAINT fk_tables_current_session
    FOREIGN KEY (current_session_id)
    REFERENCES table_sessions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 8. Orders link to a session (optional — dine-in only) ───────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS table_session_id UUID
    REFERENCES table_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS table_id UUID
    REFERENCES tables(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(table_session_id);
