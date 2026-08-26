-- 064: re-gate features into a compelling 5-tier value ladder.
--      founder 2026-08-26: Advanced(48) vs Enterprise(51) was only 3 apart for
--      2x price — no one upgrades for that. Redistribute so each tier adds a
--      clear value band, and the Enterprise premium is high-value EXCLUSIVES
--      (multi-outlet, API, white-label, multi-currency, TDS/TCS, bank rec),
--      not raw count. Add-ons are bundled into plans (loyalty/WhatsApp/
--      aggregators/recipe) at the tier where they become "free".
--
-- Feature resolution: featureService looks up plan_features WHERE tier_kind =
-- plan.tier. Live plan.tier codes: free, basic, pro_plan, advanced, pro.
-- We DELETE + re-INSERT each of those sets. Counts: 15 / 24 / 35 / 45 / 51.

-- ── Starter (tier 'free') — 7-day trial demo: a compelling taste (15) ──────
DELETE FROM plan_features WHERE tier_kind = 'free';
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('free','pos'),('free','orders'),('free','token_generation'),
 ('free','tables_single_floor'),('free','menu_basic'),('free','menu_variants_modifiers'),
 ('free','invoice_basic'),('free','customers_basic'),('free','reports_basic'),
 ('free','expenses'),('free','qr_ordering'),('free','captain_mode'),
 ('free','kds'),('free','staff_lite'),('free','daily_closing');

-- ── Growth ₹299 (tier 'basic') — single-outlet essentials (24) ────────────
-- Bundles: WhatsApp marketing + Loyalty become free here.
DELETE FROM plan_features WHERE tier_kind = 'basic';
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'basic', feature_key FROM plan_features WHERE tier_kind = 'free';
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('basic','tables_multi_floor'),('basic','bill_split'),('basic','whatsapp_marketing'),
 ('basic','loyalty'),('basic','customers_crm'),('basic','reservations'),
 ('basic','voice_pos'),('basic','wastage'),('basic','dashboard_access');

-- ── Pro ₹799 (tier 'pro_plan') — full-service restaurant (35) ─────────────
-- Bundles: Aggregators (online orders), Loyalty/Memberships, Recipe & Food
-- Cost, Inventory become free here. This is the "Most popular" full package.
DELETE FROM plan_features WHERE tier_kind = 'pro_plan';
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'pro_plan', feature_key FROM plan_features WHERE tier_kind = 'basic';
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('pro_plan','memberships'),('pro_plan','aggregators'),('pro_plan','driver_mode'),
 ('pro_plan','auto_whatsapp_order'),('pro_plan','recipe_costing'),('pro_plan','inventory_tracking'),
 ('pro_plan','tax_invoices'),('pro_plan','b2b_invoice'),('pro_plan','registers'),
 ('pro_plan','staff_unlimited'),('pro_plan','reviews');

-- ── Advanced ₹999 (tier 'advanced') — scaling / accounting heavy (45) ─────
DELETE FROM plan_features WHERE tier_kind = 'advanced';
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'advanced', feature_key FROM plan_features WHERE tier_kind = 'pro_plan';
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('advanced','einvoice_gst'),('advanced','pnl_statement'),('advanced','accounting_pnl_bs'),
 ('advanced','dead_stock'),('advanced','forecast'),('advanced','heat_map'),
 ('advanced','surge_pricing'),('advanced','recurring_invoices'),('advanced','bulk_import'),
 ('advanced','marketplace_addons');

-- ── Enterprise ₹1999 (tier 'pro') — chains/franchise: all + exclusives (51)
-- The premium band: multi-outlet, API, white-label, multi-currency, TDS/TCS,
-- bank reconciliation — the things large operators actually pay for.
DELETE FROM plan_features WHERE tier_kind = 'pro';
INSERT INTO plan_features (tier_kind, feature_key)
 SELECT 'pro', feature_key FROM plan_features WHERE tier_kind = 'advanced';
INSERT INTO plan_features (tier_kind, feature_key) VALUES
 ('pro','multi_outlet'),('pro','api_access'),('pro','white_label'),
 ('pro','multi_currency_fx'),('pro','tds_tcs'),('pro','bank_reconcile');
