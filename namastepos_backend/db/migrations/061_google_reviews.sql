-- 061: Google reviews — per-business Google Maps link + Place ID
--      (founder request, 25 Aug: "add google map link in settings so it
--       will fetch reviews there on review screen")

-- WHY businesses and not platform_settings (2026-08-25): reviewsService and
-- npsService used to look up google_place_id in platform_settings scoped by
-- business_id — but platform_settings (003) is a PLATFORM-GLOBAL KV whose
-- primary key is `key` and which has NO business_id column, so that query
-- could never return a row (latent bug). The Place ID is per-tenant business
-- identity data, exactly like gstin/upi_id/logo_url, and the businesses row
-- already has an owner-editable update path (PATCH /auth/me → authService
-- updateBusiness whitelist). So it lives on businesses.

-- google_maps_url: raw link the owner pastes in Settings (kept for display /
--   re-parsing). google_place_id: resolved Places ID actually used for the
--   Places Details API call; ChIJ… IDs are well under 100 chars.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_maps_url TEXT;
