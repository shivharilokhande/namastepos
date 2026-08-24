-- 055: Wastage-as-expense + membership item bundles (founder feedback 23 Aug)

-- 1. New expense category for wastage. NOTE: the new enum value is only
--    USED at runtime (wastageService), never inside this migration —
--    Postgres forbids using a value in the transaction that adds it.
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'wastage';
-- Refunded-but-prepared food cost (refundService)
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'refund_cogs';

-- 2. Membership bundles: a membership can carry an item entitlement
--    bundle (e.g. 20 cold coffees + 20 pizzas / 30 days). The bundle
--    definition lives in memberships.benefits (JSONB, already exists):
--      { "items": [ { "menuItemId": "...", "qty": 20 }, ... ] }
--    Each subscription tracks what's LEFT of the bundle:
ALTER TABLE membership_subscriptions
  ADD COLUMN IF NOT EXISTS remaining JSONB;
-- Backfill: existing active subs get their plan's full bundle (if any)
UPDATE membership_subscriptions ms
   SET remaining = m.benefits->'items'
  FROM memberships m
 WHERE m.id = ms.membership_id
   AND ms.remaining IS NULL
   AND m.benefits ? 'items';

-- 3. Track membership redemptions per order (audit + reporting)
CREATE TABLE IF NOT EXISTS membership_redemptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id  UUID NOT NULL REFERENCES membership_subscriptions(id) ON DELETE CASCADE,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  menu_item_id     UUID,
  qty              NUMERIC(10,2) NOT NULL,
  value_inr        NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_membership_redemptions_biz
  ON membership_redemptions(business_id, created_at DESC);
