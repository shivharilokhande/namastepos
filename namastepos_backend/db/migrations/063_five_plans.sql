-- 063: five-plan structure (Starter · Growth · Pro · Advanced · Enterprise)
--      founder request 2026-08-26. Reprices Growth + Enterprise and adds two
--      new plans (Pro, Advanced). Feature-gating in this codebase resolves by
--      the plan's `tier` code against plan_features.tier_kind (featureService
--      queries WHERE tier_kind = plan.tier first). Existing live sets:
--        free=11 (Starter), basic=31 (Growth), pro=51 (Enterprise), enterprise=48.
--      We reuse those and add a curated 'pro_plan' (~40) set for the new Pro
--      tier and reuse the 48-feature set for Advanced. Idempotent.

-- 1) Reprice existing plans -------------------------------------------------
-- Growth ₹299 -> ₹399 (yearly = 10x)
UPDATE plans SET price_inr_paise = 39900, price_yearly_paise = 399000
 WHERE tier = 'basic';

-- Enterprise ₹799 -> ₹2999 (top tier; keeps its 51-feature 'pro' set)
UPDATE plans SET price_inr_paise = 299900, price_yearly_paise = 2999000, name = 'Enterprise'
 WHERE tier = 'pro';

-- Starter: raise menu-items cap so paid tiers are always >= free
UPDATE plans SET limits = jsonb_set(limits, '{menu_items}', '50', true)
 WHERE tier = 'free';

-- 2) New plans --------------------------------------------------------------
-- Pro ₹799 (single full-service outlet) — tier 'pro_plan'
-- Advanced ₹1499 (multi-station / inventory + accounting heavy) — tier 'advanced'
INSERT INTO plans (tier, tier_kind, name, price_inr_paise, price_yearly_paise, billing_period, is_active, limits, features)
VALUES
 ('pro_plan', 'pro_plan', 'Pro', 79900, 799000, 'monthly', TRUE,
  '{"staff":15,"floors":-1,"tables":-1,"businesses":1,"menu_items":-1,"monthly_orders":-1}'::jsonb,
  '{"reports":"advanced","exports":true,"support":"priority","aggregators":true}'::jsonb),
 ('advanced', 'advanced', 'Advanced', 149900, 1499000, 'monthly', TRUE,
  '{"staff":-1,"floors":-1,"tables":-1,"businesses":3,"menu_items":-1,"monthly_orders":-1}'::jsonb,
  '{"reports":"advanced","exports":true,"support":"priority","aggregators":true}'::jsonb)
ON CONFLICT (tier) DO NOTHING;

-- 3) Feature sets for the new tiers ----------------------------------------
-- Pro = everything in Growth (basic) plus a curated set of higher-tier tools.
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'pro_plan', feature_key FROM plan_features WHERE tier_kind = 'basic'
 ON CONFLICT DO NOTHING;
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('pro_plan', 'inventory_tracking'),
 ('pro_plan', 'tax_invoices'),
 ('pro_plan', 'einvoice_gst'),
 ('pro_plan', 'pnl_statement'),
 ('pro_plan', 'registers'),
 ('pro_plan', 'dead_stock'),
 ('pro_plan', 'recurring_invoices'),
 ('pro_plan', 'reviews'),
 ('pro_plan', 'marketplace_addons')
 ON CONFLICT DO NOTHING;

-- Advanced = the existing 48-feature 'enterprise' set (everything except the
-- top enterprise-only extras like API access / white-label, which stay on the
-- Enterprise plan's 51-feature 'pro' set).
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'advanced', feature_key FROM plan_features WHERE tier_kind = 'enterprise'
 ON CONFLICT DO NOTHING;
