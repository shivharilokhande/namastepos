-- 097 — tenant API keys (round-2 fix batch 2026-09-06, CONTRACTS §3)
--
-- WHY
-- ---------------------------------------------------------------------------
-- `api_access` has been sold on the Enterprise plan since the five-plan ladder
-- landed and, until today, was enforced NOWHERE: no key issuance, no key auth
-- path, nothing that read the feature key (entitlements review 2026-09-05,
-- registry `enforcement: 'ungated'`). This table is the missing surface.
--
-- One row per key. The SECRET is never stored: `key_hash` is sha256(secret)
-- and `prefix` is the first characters of the secret so the owner can tell
-- keys apart in the list ("npk_live_a1b2…"). `revoked_at` is a soft delete so
-- a revoked key can still be shown (and its last use audited) rather than
-- vanishing. `last_used_at` is touched by the auth path, throttled, so the
-- owner can spot a key nobody uses any more.
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- The list endpoint and the "max 10 active keys" check are both per business.
CREATE INDEX IF NOT EXISTS idx_api_keys_business
  ON api_keys (business_id, created_at DESC);

-- Auth resolves a presented secret by its hash; only live keys matter there.
CREATE INDEX IF NOT EXISTS idx_api_keys_live_hash
  ON api_keys (key_hash) WHERE revoked_at IS NULL;
