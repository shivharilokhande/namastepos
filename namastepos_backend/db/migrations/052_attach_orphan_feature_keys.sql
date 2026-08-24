-- Migration 052 — attach previously-orphaned feature keys to their tiers.
--
-- Follow-up to the FF-402 restore-orphans pass. Four feature keys were
-- referenced by the app / middleware but never inserted into
-- plan_features, so `PlanGate` treated them as locked for every business
-- even after the admin catalog was updated:
--
--   inventory_tracking  → mobile drawer → Inventory
--   memberships         → backend middleware gates /memberships
--   reviews             → backend middleware gates /reviews
--   marketplace_addons  → backend middleware gates /marketplace
--
-- Attach them to the tiers where they belong. Trial (`starter`) stays
-- lean; Pro gets the operational features (Inventory + Reviews); Enterprise
-- adds Memberships + Marketplace addons on top.
--
-- Safe to re-run: plan_features PRIMARY KEY (tier_kind, feature_key) +
-- ON CONFLICT DO NOTHING.

-- Pro tier — operational feature parity.
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('pro', 'inventory_tracking'),
  ('pro', 'reviews')
ON CONFLICT DO NOTHING;

-- Enterprise — everything Pro gets, plus loyalty extensions + marketplace.
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('enterprise', 'inventory_tracking'),
  ('enterprise', 'reviews'),
  ('enterprise', 'memberships'),
  ('enterprise', 'marketplace_addons')
ON CONFLICT DO NOTHING;
