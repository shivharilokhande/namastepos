-- NamastePOS SaaS migration 004 — paid add-ons (marketplace)
--
-- Lets the platform sell modular features (Online Orders, Loyalty,
-- WhatsApp Marketing, Multi-outlet, etc.) on top of the base plan.
-- Each customer's bill = plan_price + sum(active_addon_prices).

DO $$ BEGIN
  CREATE TYPE addon_status AS ENUM ('trialing','active','past_due','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. addons (the catalog — managed by super admin) ────────────────────
CREATE TABLE IF NOT EXISTS addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            VARCHAR(50) UNIQUE NOT NULL,           -- 'online-orders'
  name            VARCHAR(100) NOT NULL,                  -- 'Online Orders'
  tagline         VARCHAR(255),                           -- card subtitle
  description     TEXT,                                   -- long form
  icon            VARCHAR(50),                            -- lucide icon name
  category        VARCHAR(50),                            -- integrations|marketing|operations|reports
  price_inr_paise INTEGER NOT NULL DEFAULT 0,             -- 14900 = ₹149
  billing_period  VARCHAR(20) NOT NULL DEFAULT 'monthly', -- monthly|yearly|one_time
  required_plan_tier plan_tier,                           -- NULL = any plan can buy
  trial_days      INTEGER NOT NULL DEFAULT 0,
  features        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {permissions: [...], limits: {...}}
  razorpay_plan_id VARCHAR(100),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  display_order   INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_addons_active ON addons(is_active, display_order);

DROP TRIGGER IF EXISTS trg_addons_updated ON addons;
CREATE TRIGGER trg_addons_updated BEFORE UPDATE ON addons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. business_addons (per-customer activations) ──────────────────────
CREATE TABLE IF NOT EXISTS business_addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  addon_id        UUID NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  status          addon_status NOT NULL DEFAULT 'trialing',
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at   TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at    TIMESTAMPTZ,
  razorpay_subscription_id VARCHAR(100) UNIQUE,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_business_addon UNIQUE (business_id, addon_id)
);
CREATE INDEX IF NOT EXISTS idx_business_addons_status ON business_addons(status);
CREATE INDEX IF NOT EXISTS idx_business_addons_business ON business_addons(business_id);
CREATE INDEX IF NOT EXISTS idx_business_addons_period_end ON business_addons(current_period_end);

DROP TRIGGER IF EXISTS trg_business_addons_updated ON business_addons;
CREATE TRIGGER trg_business_addons_updated BEFORE UPDATE ON business_addons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 3. Invoice line items (to break out plan + addons on the same bill) ──
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind            VARCHAR(20) NOT NULL,                   -- 'plan'|'addon'|'discount'|'tax'
  reference_id    UUID,                                   -- plan_id or addon_id
  label           VARCHAR(255) NOT NULL,
  amount_paise    INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);

-- ── 4. Seed the launch catalog ──────────────────────────────────────────
INSERT INTO addons
  (slug, name, tagline, description, icon, category, price_inr_paise, billing_period,
   required_plan_tier, features, display_order) VALUES

-- The flagship one the user asked about
('online-orders', 'Online Orders',
 'Receive Zomato, Swiggy & direct orders straight in your POS',
 'Stop juggling three apps. Aggregator orders push into your queue with sound + notification. Accept or reject in one tap. Status auto-syncs back to Zomato/Swiggy. Track delivery riders.',
 'shopping-bag', 'integrations', 14900, 'monthly', NULL,
 '{"permissions": ["aggregator_integrations","push_notifications","delivery_management","accept_reject_flow"], "limits": {"aggregator_apps": 3}}'::jsonb, 10),

-- Loyalty / cashback
('loyalty', 'Loyalty & Cashback',
 'Give your regulars points and watch repeat visits triple',
 'Auto-earn points on every order. Customers redeem for discounts on future visits. Birthday rewards. Customer database with order history.',
 'gift', 'marketing', 9900, 'monthly', 'basic',
 '{"permissions": ["loyalty_program","customer_database","birthday_rewards"]}'::jsonb, 20),

-- WhatsApp marketing
('whatsapp-marketing', 'WhatsApp Marketing',
 'Send promos and re-engagement campaigns via WhatsApp Business',
 'Use approved WhatsApp Business templates to push offers, festive specials, or "we miss you" messages to your customer list. Track open & click rates.',
 'message-circle', 'marketing', 19900, 'monthly', 'basic',
 '{"permissions": ["whatsapp_campaigns","campaign_analytics"], "limits": {"messages_per_month": 1000}}'::jsonb, 30),

-- Multi-outlet
('multi-outlet', 'Multi-outlet (3 branches)',
 'Run all your branches from one account',
 'Manage menu, staff, and reports across up to 3 outlets. Consolidated daily P&L. Branch-wise revenue split.',
 'building-2', 'operations', 49900, 'monthly', 'pro',
 '{"permissions": ["multi_outlet"], "limits": {"outlets": 3}}'::jsonb, 40),

-- Food cost / recipes
('recipe-costing', 'Recipe & Food Cost',
 'Know the exact food cost of every dish',
 'Define recipes per menu item. Get real-time food cost % per dish and per order. Get alerts when ingredient prices spike.',
 'chef-hat', 'operations', 14900, 'monthly', 'basic',
 '{"permissions": ["recipe_costing","ingredient_alerts"]}'::jsonb, 50),

-- Custom branding
('custom-branding', 'Custom Branding',
 'Your logo on every receipt + branded WhatsApp messages',
 'Upload your high-res logo. Customize receipt header/footer. Pick the print color (one-color thermal printers). Custom WhatsApp message templates.',
 'palette', 'operations', 4900, 'monthly', NULL,
 '{"permissions": ["custom_receipt_logo","custom_whatsapp_template"]}'::jsonb, 60)

ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      description = EXCLUDED.description,
      icon = EXCLUDED.icon,
      category = EXCLUDED.category,
      price_inr_paise = EXCLUDED.price_inr_paise,
      billing_period = EXCLUDED.billing_period,
      required_plan_tier = EXCLUDED.required_plan_tier,
      features = EXCLUDED.features,
      display_order = EXCLUDED.display_order,
      updated_at = NOW();
