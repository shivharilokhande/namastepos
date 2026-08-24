-- NamastePOS · Migration 045 — Anomaly alerts dedupe (FF-248).
--
-- Ensures at most one WhatsApp per (business, anomaly kind, hourly
-- bucket) so a single storm of cancellations doesn't send the owner
-- 30 duplicate pings.

CREATE TABLE IF NOT EXISTS anomaly_alerts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                     -- VOID_SPIKE | AFTER_HOURS | STOCK_OUT | ...
  bucket_hour  TIMESTAMPTZ NOT NULL,              -- DATE_TRUNC('hour', NOW()) at time of alert
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, kind, bucket_hour)
);

CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_business
  ON anomaly_alerts(business_id, created_at DESC);
