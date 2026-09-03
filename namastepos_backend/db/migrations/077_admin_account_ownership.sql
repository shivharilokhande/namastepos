-- 077_admin_account_ownership.sql (2026-09-03) — SaaS control-plane gaps.
--
-- Two additive columns on `businesses` so the admin console can run a real
-- book of business:
--   • account_owner_email — which internal AE/CSM owns this tenant. Plain
--     email (not a FK to admin_users) on purpose: the owner may be someone
--     without an admin login yet, and deactivating an admin must not null
--     out the assignment or block the delete.
--   • tags — free-form segment labels ('chain', 'pilot', 'high-touch') used
--     for filtering the customer list and (later) broadcast segments.
--
-- Both are nullable / defaulted, so every existing row stays valid and no
-- read path changes behaviour until the admin sets them. Idempotent.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS account_owner_email CITEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];

-- "Show me my book" — the single most common admin filter.
CREATE INDEX IF NOT EXISTS idx_businesses_account_owner
  ON businesses(account_owner_email)
  WHERE account_owner_email IS NOT NULL;

-- Tag filtering uses @> / && containment, which needs GIN to stay cheap.
CREATE INDEX IF NOT EXISTS idx_businesses_tags
  ON businesses USING GIN (tags);
