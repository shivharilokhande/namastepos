-- Migration 034 — Mobile-first tier rescope (Push 11)
--
-- Goal: mobile-first GTM. The mobile app is what we sell; the dashboard
-- becomes the Pro+ carrot.
--
-- Two changes:
--   1. Captain mode moves from Pro → Starter so trial users immediately
--      experience the floor/orders flow that justifies the subscription.
--   2. New feature key `dashboard_access` introduced, granted to Pro and
--      Enterprise only. Starter users still get the mobile app + Captain
--      but can't log into the customer dashboard.
--
-- ON CONFLICT DO NOTHING throughout because plan_features uses a composite
-- PRIMARY KEY (tier_kind, feature_key) — re-running this migration is safe.

-- 1. Captain on Starter
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('starter', 'captain_mode')
ON CONFLICT DO NOTHING;

-- 2. Dashboard access — Pro + Enterprise only
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('pro',        'dashboard_access'),
  ('enterprise', 'dashboard_access')
ON CONFLICT DO NOTHING;
