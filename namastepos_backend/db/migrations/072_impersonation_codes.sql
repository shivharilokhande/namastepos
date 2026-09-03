-- 072: One-time impersonation handoff codes (NP-126, 2026-09-03).
--
-- Until now, admin impersonation handed the RAW 15-min tenant JWT to the
-- browser via a URL fragment (#imp=<jwt>) — leakable through shoulder-surfing,
-- browser history sync, and copy/paste. The new flow mints a one-time code
-- instead: the admin console calls POST /v1/admin/customers/:businessId/
-- impersonation-code (stores only the SHA-256 hash here, 60s expiry, returns
-- the raw code once), the dashboard exchanges it via the public
-- POST /v1/auth/impersonation-exchange (atomic single-use claim) for the same
-- short-lived read-only tenant token the old flow issued.
--
-- Additive only. The legacy /impersonate endpoint stays for back-compat until
-- the web half fully migrates.

CREATE TABLE IF NOT EXISTS impersonation_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     TEXT NOT NULL UNIQUE,               -- SHA-256 hex of the raw code (raw never stored)
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,               -- NOW() + 60s at mint time
  used_at       TIMESTAMPTZ                          -- NULL until claimed; claim is atomic
);

-- The exchange path looks rows up by code_hash (already UNIQUE-indexed).
-- This one supports sweeping/inspecting stale codes.
CREATE INDEX IF NOT EXISTS idx_impersonation_codes_expires
  ON impersonation_codes (expires_at);
