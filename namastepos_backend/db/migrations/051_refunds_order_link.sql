-- NamastePOS · Migration 051 — Order-linked refunds (B4 fix).
--
-- The `refunds` table was designed for platform subscription refunds
-- (payments → invoices → subscriptions) and had NO way to reference
-- a customer order. `refundService.refundOrder` tried to join
-- `payments.order_id`, which doesn't exist — every FF-304 partial
-- refund attempt 500'd.
--
-- Fix: add `refunds.order_id` so customer-order refunds can be logged
-- directly without needing a platform Payment row (which they don't
-- have — customer orders never touch platform Razorpay). Existing
-- rows keep NULL (they're subscription refunds).

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_order
  ON refunds(order_id) WHERE order_id IS NOT NULL;
