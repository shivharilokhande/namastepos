-- NP-137 follow-up (2026-09-03): server-side idempotency for offline-queued
-- mobile expenses. The app already sends a per-attempt uuid `clientKey`; the
-- client-side content-match reconcile (category+amount+day) could delete a
-- genuinely different expense or duplicate a timeout-committed one. A real
-- unique key removes both failure modes. Additive only.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS client_key VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_client_key
  ON expenses (business_id, client_key)
  WHERE client_key IS NOT NULL;
