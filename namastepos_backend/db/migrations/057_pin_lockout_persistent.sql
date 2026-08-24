-- 057 — Persistent staff-PIN lockout (security S4).
--
-- The PIN brute-force lockout lived in an in-memory Map: it reset on every
-- deploy/restart and was per-process, so under PM2 cluster mode the effective
-- cap multiplied by the worker count. Move the counter onto business_users so
-- it is shared across workers and survives restarts.
--
-- Additive only — no drops.

ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS pin_fail_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pin_first_fail_at TIMESTAMPTZ;
