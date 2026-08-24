-- 054: Pre-deployment schema fixes (2026-08-22)
-- Adds columns/tables that services already reference but no migration created.
-- Every statement is idempotent.

-- 0. Driver staff role (founder request 2026-08-22: "in staff no option
--    to set Driver"). Staff with this role sign in via PIN and land on
--    the My-deliveries screen; creating one also registers them in the
--    drivers table so the delivery picker sees them.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff_driver';

-- 1. Split-tender payment legs reference their order directly
--    (orderService.create FF-312 + guestController both insert payments.order_id)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- 2. Manager PIN for discount approvals (discountApprovalService)
ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS discount_pin_hash TEXT;

-- 3. Order cancellation timestamp + sales channel
--    (forceCloseSessionService sets cancelled_at; aggregatorService passes
--     channel; _queueOrderWhatsApp selects o.channel)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS channel VARCHAR(30);

-- 4. Who closed a table session when it wasn't a user (support intervention)
ALTER TABLE table_sessions
  ADD COLUMN IF NOT EXISTS closed_by_type VARCHAR(20);

-- 5. Aggregator orders can contain items not yet mapped to a menu item.
--    aggregatorService passes menuItemId=null for those; 001 made the
--    column NOT NULL which silently dropped every such order.
ALTER TABLE order_items ALTER COLUMN menu_item_id DROP NOT NULL;

-- 6. Loyalty: auto-created settings rows defaulted is_active=FALSE, so
--    points silently never earned. Enable them; owners can still turn
--    loyalty off from the dashboard settings.
UPDATE loyalty_settings SET is_active = TRUE WHERE is_active = FALSE;

-- 7. Revenue leakage events (walkouts recorded by forceCloseSessionService,
--    surfaced on the Revenue Leakage dashboard)
CREATE TABLE IF NOT EXISTS revenue_leakage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind          VARCHAR(30) NOT NULL,            -- walkout | void | comp | ...
  amount_paise  BIGINT NOT NULL DEFAULT 0,
  source_type   VARCHAR(30),                     -- table_session | order | ...
  source_id     UUID,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leakage_business
  ON revenue_leakage_events(business_id, detected_at DESC);
-- One leakage event per source (keeps forceClose idempotent via ON CONFLICT)
CREATE UNIQUE INDEX IF NOT EXISTS uq_leakage_source
  ON revenue_leakage_events(business_id, kind, source_type, source_id);
