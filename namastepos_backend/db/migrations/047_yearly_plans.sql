-- NamastePOS · Migration 047 — Yearly billing (FF-313).
--
-- Adds columns to `plans` so we can offer monthly + yearly pricing
-- side by side. Yearly defaults to 10× monthly (2 months free) if
-- `price_yearly_paise` isn't explicitly set.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS price_yearly_paise        BIGINT,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_yearly   TEXT;

-- Backfill the yearly price at 10× monthly for existing rows.
UPDATE plans
   SET price_yearly_paise = price_inr_paise * 10
 WHERE price_yearly_paise IS NULL
   AND price_inr_paise > 0;

-- `subscriptions.billing_period` tracks whether this business is on
-- monthly or yearly cadence so the renewal + upgrade logic can
-- charge the right amount.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_period TEXT NOT NULL DEFAULT 'monthly';
