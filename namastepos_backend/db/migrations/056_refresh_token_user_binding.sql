-- 056 — Bind refresh tokens to the user who logged in (security S1).
--
-- Before this, refresh_tokens only stored business_id. On /auth/refresh the
-- consume query joined business_users on business_id alone and took LIMIT 1
-- with no ORDER BY, so the refreshed access token's identity/role came from
-- an ARBITRARY active member of the business — a staff_cashier could refresh
-- and be minted the owner's role. This adds the missing user binding.
--
-- Additive only (ADD COLUMN) — no drops, no data loss.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill: for businesses with exactly one active member (the common
-- solo-owner case) we can unambiguously attribute existing tokens, so those
-- sessions keep working across the deploy. Multi-member businesses stay NULL
-- and those refresh tokens simply require a fresh sign-in (safe default).
UPDATE refresh_tokens rt
   SET user_id = sub.user_id
  FROM (
    SELECT business_id, MIN(user_id::text)::uuid AS user_id
      FROM business_users
     WHERE is_active = TRUE
     GROUP BY business_id
    HAVING COUNT(*) = 1
  ) sub
 WHERE rt.user_id IS NULL
   AND rt.business_id = sub.business_id;

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(business_id, user_id);
