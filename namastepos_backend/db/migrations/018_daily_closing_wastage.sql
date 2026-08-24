-- Migration 018 — Daily closing (Z-report) + wastage (Sprint 2 / FF-403, FF-402)

CREATE TABLE IF NOT EXISTS daily_closings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  closing_date    DATE NOT NULL,
  payload         JSONB NOT NULL,       -- full report snapshot
  cash_expected   INTEGER NOT NULL DEFAULT 0,    -- paise
  cash_counted    INTEGER,                       -- paise (cashier enters)
  variance        INTEGER GENERATED ALWAYS AS (COALESCE(cash_counted, 0) - cash_expected) STORED,
  signature       TEXT,                          -- cashier name / PIN hash
  notes           TEXT,
  closed_by_user_id UUID REFERENCES users(id),
  closed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_daily_closing UNIQUE (business_id, closing_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_closings_business_date
  ON daily_closings (business_id, closing_date DESC);

-- Once a day is closed, lock it from edits (enforced at app layer)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS day_closed BOOLEAN NOT NULL DEFAULT FALSE;

-- Wastage log
CREATE TABLE IF NOT EXISTS wastage_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id   UUID REFERENCES ingredients(id) ON DELETE SET NULL,
  menu_item_id    UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  qty             NUMERIC(10,3) NOT NULL,
  unit            VARCHAR(20),
  cost_paise      INTEGER NOT NULL DEFAULT 0,
  reason          VARCHAR(40) NOT NULL,   -- 'expired' | 'spilled' | 'over_prep' | 'damaged' | 'other'
  note            TEXT,
  logged_by_user_id UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wastage_business_date
  ON wastage_log (business_id, created_at DESC);
