-- 070_membership_client_key.sql
-- NP-116 (2026-09-03): idempotency key for membership sales.
-- A mobile retry of POST /memberships/subscribe used to sell the membership
-- TWICE (two subscription rows, two wallet debits). The client now sends an
-- optional `clientKey`; membershipService.subscribe returns the original sale
-- for a repeated (business_id, client_key) instead of double-selling — same
-- pattern as orders.client_id.
-- Additive only (house rule): nullable column + partial unique index; existing
-- rows keep client_key NULL and are unaffected.
ALTER TABLE membership_subscriptions
  ADD COLUMN IF NOT EXISTS client_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_subs_client_key
  ON membership_subscriptions (business_id, client_key)
  WHERE client_key IS NOT NULL;
