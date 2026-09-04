-- 085_idempotency_keys.sql
-- NP-401 (2026-09-04): ONE generic request-dedup table so every mutation the
-- Flutter offline outbox can replay is idempotent, instead of a bespoke
-- client-key column per table (orders.client_id / expenses.client_key /
-- membership_subscriptions.client_key were the only three that had one).
--
-- THE FAILURE THIS CLOSES
-- The outbox retries a queued write whenever the response never arrived. If
-- the server COMMITTED and only the response was lost (Render cold-start
-- timeout, app killed mid-flight, tunnel dropped), the retry re-ran the
-- handler and the side effect happened TWICE: stock double-decremented, a
-- refund paid out twice, loyalty points granted twice, a wastage/tip row
-- duplicated. See src/middleware/idempotent.js for the contract.
--
-- SHAPE
--   (business_id, key, endpoint) is the primary key, so the claim is a single
--   atomic INSERT ... ON CONFLICT DO NOTHING RETURNING — the same pattern the
--   Razorpay webhook dedup already uses (razorpayService.handleWebhook).
--   * business_id in the key = tenant scoping. The same client uuid arriving
--     for two businesses is two independent requests and both must run.
--   * endpoint in the key = one outbox row's uuid cannot accidentally suppress
--     a different mutation that happens to reuse it.
--   * response/status_code are NULL while the first attempt is in flight; a
--     concurrent retry that sees NULL gets 409 + Retry-After (never a 2xx —
--     acking early would let the client drop a write the winner may still
--     fail and roll back).
--
-- Additive only (house rule): new table, no existing table touched, no data
-- migration. ON DELETE CASCADE so deleting a business takes its keys with it.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  business_id  UUID         NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key          VARCHAR(64)  NOT NULL,
  endpoint     VARCHAR(120) NOT NULL,
  response     JSONB,
  status_code  INT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, key, endpoint)
);

-- Retention sweep index. cronWorker's 02:02 IST heavy block deletes keys older
-- than IDEMPOTENCY_RETENTION_DAYS (default 7) — without this the nightly
-- DELETE would seq-scan a table that grows with every mutation forever.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
