-- 068_addon_revenue_share.sql (2026-08-28) — L5 add-on marketplace revenue share.
-- Lets the platform attribute a marketplace add-on to a partner and track the
-- revenue-share % owed, so an admin payout report can be produced. Additive.

ALTER TABLE addons
  ADD COLUMN IF NOT EXISTS partner_name       VARCHAR(120),
  ADD COLUMN IF NOT EXISTS revenue_share_pct  NUMERIC(5,2) NOT NULL DEFAULT 0;
