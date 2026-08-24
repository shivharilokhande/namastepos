-- NamastePOS · Migration 044 — Aggregator webhook health (FF-245).
--
-- Track the last time each aggregator (Zomato / Swiggy / Dunzo /
-- Magicpin) delivered a webhook per business so the dashboard can
-- show a live "last synced 3m ago" badge next to each integration.
--
-- We don't need the payload — just the timestamp + a status token
-- (ok / hmac_fail / provider_error). The actual order payload is
-- already logged elsewhere.

CREATE TABLE IF NOT EXISTS aggregator_health (
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,        -- 'zomato' | 'swiggy' | 'dunzo' | 'magicpin'
  last_ok_at    TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error    TEXT,
  ok_count_24h  INT NOT NULL DEFAULT 0,
  err_count_24h INT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_agg_health_last_ok
  ON aggregator_health(business_id, last_ok_at DESC);
