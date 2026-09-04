-- 2026-09-03 — delivery/aggregator ORDER LIFECYCLE.
--
-- Founder ask: the exact flow a Zomato/Swiggy (or own-fleet) order goes
-- through — accept, preparing with a prep time, prepared/food-ready, rider
-- arrives, OTP handover, delivered — visible in both dashboard and app.
--
-- DESIGN NOTE (deliberate): this does NOT extend `orders.status`
-- (pending/ready/collected/cancelled). That enum drives revenue recognition,
-- loyalty earn/reversal and every report; widening it would put the money
-- state machine at risk for a fulfilment concern. Fulfilment is a SEPARATE,
-- orthogonal dimension: a delivery order can be `status='ready'` (kitchen
-- done) while `fulfilment_state='rider_assigned'` (waiting for pickup).
-- Reports keep reading `status`; the delivery board reads `fulfilment_state`.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfilment_state VARCHAR(24),
  ADD COLUMN IF NOT EXISTS prep_minutes     INTEGER,
  ADD COLUMN IF NOT EXISTS reject_reason    TEXT,
  ADD COLUMN IF NOT EXISTS rider_name       VARCHAR(120),
  ADD COLUMN IF NOT EXISTS rider_phone      VARCHAR(20),
  -- Handover OTP. `rider_otp_expected` is the code the aggregator/rider
  -- presents (or the one WE generate for own-fleet); it is compared against
  -- what staff type in. 4-6 digits, low value, short-lived, and never a
  -- credential — stored plain so staff can be told it for own deliveries.
  ADD COLUMN IF NOT EXISTS rider_otp_expected VARCHAR(8),
  ADD COLUMN IF NOT EXISTS rider_otp_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS food_ready_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picked_up_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ;

COMMENT ON COLUMN orders.fulfilment_state IS
  'Delivery lifecycle, orthogonal to orders.status: placed|accepted|rejected|preparing|food_ready|rider_assigned|picked_up|delivered|cancelled. NULL = not a delivery order (dine-in/takeaway).';

-- The delivery board queries "everything live for this outlet", so index the
-- open states only — a restaurant's history is far larger than its live board.
CREATE INDEX IF NOT EXISTS idx_orders_fulfilment_live
  ON orders (business_id, fulfilment_state, created_at DESC)
  WHERE fulfilment_state IS NOT NULL
    AND fulfilment_state NOT IN ('delivered', 'rejected', 'cancelled');

-- ── Outbound event queue ────────────────────────────────────────────────
-- Aggregators enforce SLAs on accept/reject and food-ready callbacks, so a
-- fire-and-forget HTTP call is not good enough: every outbound status change
-- is persisted first, then drained with retries and a dead-letter. With no
-- partner credentials configured the adapter is a no-op that marks the event
-- `skipped` — so the whole flow works for own-fleet delivery today and starts
-- pushing the moment real Zomato/Swiggy credentials exist.
CREATE TABLE IF NOT EXISTS aggregator_outbound_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider        VARCHAR(32) NOT NULL,          -- zomato | swiggy | own | …
  event           VARCHAR(32) NOT NULL,          -- accepted | rejected | preparing | food_ready | picked_up | delivered
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(16) NOT NULL DEFAULT 'queued', -- queued|sent|skipped|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One event per (order, event) — re-sending "accepted" must not duplicate.
  CONSTRAINT uq_outbound_order_event UNIQUE (order_id, event)
);
CREATE INDEX IF NOT EXISTS idx_outbound_due
  ON aggregator_outbound_events (next_attempt_at)
  WHERE status = 'queued';

-- Inbound webhook events, for replay/debug and duplicate suppression beyond
-- the order-level idempotency we already have.
CREATE TABLE IF NOT EXISTS aggregator_inbound_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider      VARCHAR(32) NOT NULL,
  event_type    VARCHAR(48) NOT NULL,
  external_id   TEXT,
  payload       JSONB NOT NULL,
  handled       BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_provider_event
  ON aggregator_inbound_events (provider, external_id, event_type)
  WHERE external_id IS NOT NULL;

-- Backfill: existing aggregator orders that are still open become `placed`
-- so they appear on the new board instead of vanishing; anything already
-- collected/cancelled is left NULL (history, not live work).
UPDATE orders
   SET fulfilment_state = CASE
     WHEN status = 'cancelled' THEN 'cancelled'
     WHEN status = 'collected' THEN 'delivered'
     ELSE 'placed'
   END
 WHERE aggregator_order_id IS NOT NULL
   AND fulfilment_state IS NULL;
