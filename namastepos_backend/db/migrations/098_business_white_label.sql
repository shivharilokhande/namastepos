-- 098 — white-label branding settings (round-2 fix batch 2026-09-06, CONTRACTS §4)
--
-- WHY
-- ---------------------------------------------------------------------------
-- `white_label` has been sold on the Enterprise plan and enforced NOWHERE
-- (entitlements review 2026-09-05: "No white-label implementation exists").
-- `custom_branding` is the bill-template capability and stays as it is; this
-- column is the tenant's OWN brand shown where NamastePOS otherwise brands the
-- diner-facing surfaces: guest QR pages, the public mini-site and printed
-- receipts.
--
-- Shape: { enabled: bool, brandName: text|null, hidePoweredBy: bool,
--          accentColor: '#rrggbb'|null }. Kept as one JSONB rather than four
-- columns because the render path reads it as a unit and the dashboard round-
-- trips it as a unit; whiteLabelService.normalise() is the single place that
-- validates and fills defaults.
--
-- The column being set is NOT the gate. Every render site re-checks
-- featureService.hasFeature(businessId, 'white_label') at request time, so a
-- downgrade turns the branding off without touching this row (the settings
-- survive and come back if the tenant upgrades again).
--
-- Idempotent: IF NOT EXISTS.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS white_label JSONB NOT NULL DEFAULT '{}'::jsonb;
