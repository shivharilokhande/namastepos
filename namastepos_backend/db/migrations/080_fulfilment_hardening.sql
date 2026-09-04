-- 2026-09-03 — hardening found by the post-deploy verification pass on the
-- delivery lifecycle shipped in 079. Three money/reliability holes:
--
-- 1. The POS-status mirror (delivered → collected, which is what RECOGNISES
--    REVENUE and awards loyalty) ran after the fulfilment transaction and only
--    logged a warning on failure. An order could sit `delivered` with the money
--    never booked, invisible to everyone. Record the failure on the row so a
--    cron can retry it and the nightly integrity email can report it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pos_mirror_error TEXT;

-- Bounded sweep for the repair cron: normally an empty set.
CREATE INDEX IF NOT EXISTS idx_orders_pos_mirror_stuck
  ON orders (delivered_at)
  WHERE fulfilment_state = 'delivered'
    AND status NOT IN ('collected', 'cancelled');

-- 2. Inbound webhook dedupe keyed on (provider, external_id, event_type) with
--    NO business_id — two tenants on the same provider whose order ids collide
--    would silently swallow each other's events. Re-key per tenant.
DROP INDEX IF EXISTS uq_inbound_provider_event;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_business_event
  ON aggregator_inbound_events (business_id, provider, external_id, event_type)
  WHERE external_id IS NOT NULL;

-- 3. Outbound dead-letters and never-flushed `skipped` events were invisible
--    (no admin surface, no cron check) — which defeats the point of a queue
--    built for aggregator SLA compliance. Index them so the integrity sweep
--    is cheap.
CREATE INDEX IF NOT EXISTS idx_outbound_attention
  ON aggregator_outbound_events (status, created_at)
  WHERE status IN ('failed', 'skipped');
