-- Migration 074 — Custom per-customer plans + addon feature grants +
-- addon expiry-notification flag (plans/addons audit fixes, 2026-09-03).
--
-- Additive only. Three concerns:
--   1. addons.grants_features — the explicit list of feature keys an active
--      addon unlocks (until now only the addon SLUG was merged into the
--      feature set, so e.g. 'whatsapp-marketing' never unlocked the
--      'whatsapp_marketing' feature key that featureGate checks).
--   2. business_addons.notified_expiry_at — once-per-activation guard for
--      the nightly "your addon expires soon / just expired" notification.
--   3. plans.is_public + plans.business_id — custom (per-customer) plans.
--      is_public=FALSE hides a plan from every public/pricing surface;
--      business_id scopes a custom plan to exactly one tenant, whose own
--      plan list still includes it.

-- ── 1. Addon feature grants ─────────────────────────────────────────────
ALTER TABLE addons
  ADD COLUMN IF NOT EXISTS grants_features TEXT[] NOT NULL DEFAULT '{}';

-- Seed the mapping for the stock catalog addons. Idempotent (plain UPDATEs
-- by slug; re-running just rewrites the same values).
UPDATE addons SET grants_features = '{aggregators}'          WHERE slug = 'online-orders';
UPDATE addons SET grants_features = '{whatsapp_marketing}'   WHERE slug = 'whatsapp-marketing';
UPDATE addons SET grants_features = '{recipe_costing}'       WHERE slug = 'recipe-costing';
UPDATE addons SET grants_features = '{multi_outlet}'         WHERE slug = 'multi-outlet';
UPDATE addons SET grants_features = '{loyalty,customers_basic}' WHERE slug = 'loyalty';
UPDATE addons SET grants_features = '{custom_branding}'      WHERE slug = 'custom-branding';

-- ── 2. Addon expiry notification guard ──────────────────────────────────
ALTER TABLE business_addons
  ADD COLUMN IF NOT EXISTS notified_expiry_at TIMESTAMPTZ;

-- ── 3. Custom (per-customer) plans ──────────────────────────────────────
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

-- Fast "does this tenant have a custom plan?" lookup; tiny partial index.
CREATE INDEX IF NOT EXISTS idx_plans_business_custom
  ON plans(business_id) WHERE business_id IS NOT NULL;
