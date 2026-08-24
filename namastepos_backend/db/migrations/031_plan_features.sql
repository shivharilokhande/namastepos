-- Migration 031 — Plan-tier feature matrix
-- Three logical tiers: starter / pro / enterprise. Mapped onto the existing
-- plan_tier enum (free, basic, pro) without altering the enum:
--   free  → starter   (cart/street vendor — FREE FOREVER)
--   basic → pro       (cafe/small restaurant — ₹299/mo)
--   pro   → enterprise (hotel/chain — ₹799/mo)
--
-- The featureService check resolves a business's active plan_id, looks up
-- its tier_kind, then queries plan_features for the requested key.

-- 1. Soft "tier_kind" column on plans (string, no enum extension needed).
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS tier_kind VARCHAR(20) NOT NULL DEFAULT 'starter';

UPDATE plans SET tier_kind = 'starter'    WHERE tier = 'free';
UPDATE plans SET tier_kind = 'pro'        WHERE tier = 'basic';
UPDATE plans SET tier_kind = 'enterprise' WHERE tier = 'pro';

-- 2. Plan ↔ feature matrix
CREATE TABLE IF NOT EXISTS plan_features (
  tier_kind     VARCHAR(20) NOT NULL,
  feature_key   VARCHAR(60) NOT NULL,
  PRIMARY KEY (tier_kind, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_plan_features_key ON plan_features (feature_key);

-- 3. Seed the matrix. Each tier is a SUPERSET of the previous one.
-- Adding a feature later: just INSERT another row.

-- ── STARTER (free tier, cart/street vendor) ─────────────────────────────
INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('starter', 'pos'),
  ('starter', 'orders'),
  ('starter', 'token_generation'),
  ('starter', 'tables_single_floor'),
  ('starter', 'menu_basic'),
  ('starter', 'reports_basic'),
  ('starter', 'expenses'),
  ('starter', 'invoice_basic'),
  ('starter', 'staff_lite'),
  ('starter', 'customers_basic')
ON CONFLICT DO NOTHING;

-- ── PRO (cafe / small restaurant — inherits starter + adds) ─────────────
INSERT INTO plan_features (tier_kind, feature_key)
SELECT 'pro', feature_key FROM plan_features WHERE tier_kind = 'starter'
ON CONFLICT DO NOTHING;

INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('pro', 'tables_multi_floor'),
  ('pro', 'menu_variants_modifiers'),
  ('pro', 'kds'),
  ('pro', 'captain_mode'),
  ('pro', 'driver_mode'),
  ('pro', 'loyalty'),
  ('pro', 'customers_crm'),
  ('pro', 'aggregators'),
  ('pro', 'memberships'),
  ('pro', 'reservations'),
  ('pro', 'wastage'),
  ('pro', 'daily_closing'),
  ('pro', 'b2b_invoice'),
  ('pro', 'qr_ordering'),
  ('pro', 'reviews'),
  ('pro', 'whatsapp_marketing'),
  ('pro', 'recipe_costing'),
  ('pro', 'bill_split'),
  ('pro', 'staff_unlimited'),
  ('pro', 'voice_pos')
ON CONFLICT DO NOTHING;

-- ── ENTERPRISE (hotel / chain — inherits pro + adds) ────────────────────
INSERT INTO plan_features (tier_kind, feature_key)
SELECT 'enterprise', feature_key FROM plan_features WHERE tier_kind = 'pro'
ON CONFLICT DO NOTHING;

INSERT INTO plan_features (tier_kind, feature_key) VALUES
  ('enterprise', 'multi_outlet'),
  ('enterprise', 'accounting_pnl_bs'),
  ('enterprise', 'einvoice_gst'),
  ('enterprise', 'recurring_invoices'),
  ('enterprise', 'bank_reconcile'),
  ('enterprise', 'surge_pricing'),
  ('enterprise', 'marketplace_addons'),
  ('enterprise', 'heat_map'),
  ('enterprise', 'forecast'),
  ('enterprise', 'dead_stock'),
  ('enterprise', 'bulk_import'),
  ('enterprise', 'api_access'),
  ('enterprise', 'white_label'),
  ('enterprise', 'tds_tcs'),
  ('enterprise', 'multi_currency_fx')
ON CONFLICT DO NOTHING;

-- 4. Re-price the existing plans to make the tier story consistent
UPDATE plans SET name = 'Starter',    price_inr_paise = 0,      tier_kind = 'starter'    WHERE tier = 'free';
UPDATE plans SET name = 'Pro',        price_inr_paise = 29900,  tier_kind = 'pro'        WHERE tier = 'basic';
UPDATE plans SET name = 'Enterprise', price_inr_paise = 79900,  tier_kind = 'enterprise' WHERE tier = 'pro';
