-- Seed compliance_settings (DPDP grievance officer / DPO / legal entity).
--
-- Hardcode-audit fix (2026-08-24): personal contact details are no longer
-- committed to the repo — pass them as psql variables:
--
--   psql -d namastepos \
--     -v officer_name="'Full Name'" \
--     -v officer_email="'grievance@yourdomain.in'" \
--     -v officer_phone="'+91 XXXXXXXXXX'" \
--     -v legal_entity="'Your Legal Entity Name'" \
--     -f scripts/seed-compliance.sql
--
-- Re-run-safe — UPDATE only, no inserts. Migration 041 already created
-- the singleton row. Served publicly via /v1/compliance, so use a role
-- address (e.g. grievance@), not a personal one.

UPDATE compliance_settings SET
  grievance_officer_name    = :officer_name,
  grievance_officer_email   = :officer_email,
  grievance_officer_phone   = :officer_phone,
  -- Until incorporation, the founder may also be the DPO.
  dpo_name                  = :officer_name,
  dpo_email                 = :officer_email,
  legal_entity_name         = :legal_entity,
  -- Stamp the policy versions that the apps are currently shipping.
  privacy_policy_version    = 'privacy-2026-05-26',
  terms_of_service_version  = 'tos-2026-05-26',
  updated_at                = NOW()
WHERE id = 1;

-- Show the result
SELECT grievance_officer_name, grievance_officer_email,
       grievance_officer_phone, privacy_policy_version,
       terms_of_service_version, updated_at
  FROM compliance_settings WHERE id = 1;
