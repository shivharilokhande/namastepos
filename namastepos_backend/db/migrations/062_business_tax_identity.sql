-- 062: business tax identity for GST-compliant SUBSCRIPTION invoices
--      (founder request, 26 Aug: "when new business owner pay for us we take
--       GST from them ... they need GST compliant invoice if they provide GST
--       name ... also ask for GST number, FSSAI number if they has optional")
--
-- The businesses table already has `gstin` (001) and `state_code` (017) and
-- `address` (001). This adds the remaining fields needed to print a fully
-- compliant tax invoice: the registered legal name (often different from the
-- trading/brand name), the FSSAI licence number (restaurant-specific, optional)
-- and PAN. All optional/nullable so existing rows and onboarding are unaffected.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS legal_name  VARCHAR(255);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS fssai       VARCHAR(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pan         VARCHAR(10);
