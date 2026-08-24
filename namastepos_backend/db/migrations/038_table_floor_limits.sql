-- Migration 038 — Add tables + floors caps to plan.limits (Push 16d).
--
-- Existing plans got their limits JSONB seeded with menu_items, staff,
-- monthly_orders, businesses but NOT tables or floors. The owner-side
-- enforceLimit('tables') / enforceLimit('floors') middleware we added
-- in Push 16d returns -1 (unlimited) when the key is absent, so this
-- migration backfills sensible caps for each tier.
--
-- Super-admin can tweak these via the Plans page → Edit dialog
-- → "Add new limit key" form.
--
-- Defaults rationale:
--   Starter   → 1 floor / 5 tables  (cart / single-counter vendor)
--   Pro       → 3 floors / 30 tables (cafe, small restaurant)
--   Enterprise→ -1 / -1 (chain, multi-outlet — unlimited)

UPDATE plans
   SET limits = limits || jsonb_build_object('floors', 1, 'tables', 5)
 WHERE tier_kind = 'starter';

UPDATE plans
   SET limits = limits || jsonb_build_object('floors', 3, 'tables', 30)
 WHERE tier_kind = 'pro';

UPDATE plans
   SET limits = limits || jsonb_build_object('floors', -1, 'tables', -1)
 WHERE tier_kind = 'enterprise';

-- Push 16h — seed auto_whatsapp_order into Pro + Enterprise feature
-- matrix. Super-admin can move it down to Starter via the Features
-- picker if they want it everywhere.
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('pro',        'auto_whatsapp_order'),
  ('enterprise', 'auto_whatsapp_order')
ON CONFLICT DO NOTHING;

-- Push 16b — sunset memberships across all tiers. Anyone who'd
-- previously been seeded with it loses access at the next /auth/me
-- refresh.
DELETE FROM plan_features WHERE feature_key = 'memberships';

-- Push 16g — same for marketplace_addons (we removed the Marketplace
-- page; addons now auto-activate based on plan, not paid separately).
DELETE FROM plan_features WHERE feature_key = 'marketplace_addons';

-- Push 17a — Reviews removed from the product.
DELETE FROM plan_features WHERE feature_key = 'reviews';
