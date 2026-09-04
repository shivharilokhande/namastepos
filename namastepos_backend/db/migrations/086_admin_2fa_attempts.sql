-- ──────────────────────────────────────────────────────────────────────────
-- 086 — Persist the admin 2FA challenge attempt counter.
--
-- Security review 2026-09-04, item 1 (other process-local caches).
--
-- twoFactorService counted failed TOTP submissions in a process-local
-- `Map` (`_attempts`), with a comment explaining that "a single backend
-- process handles admin auth, so an in-memory counter is sufficient". That
-- assumption is what this whole review is about:
--
--   • Multi-instance: the cap is per PROCESS, so N instances behind the load
--     balancer give an attacker N × 5 guesses against a 15-minute challenge —
--     and Render can scale the service at any time without anyone editing
--     this code.
--   • Restart: an instance restart (deploy, OOM, Render's free-tier idle
--     recycle) reset the counter to zero on a challenge that was still live.
--   • Leak: entries were only removed on success or on hitting the cap, so
--     every abandoned login left one behind for the process's lifetime.
--
-- Moving the counter onto the row it belongs to makes the cap global, durable
-- and self-cleaning (the row is deleted when the challenge is burned or
-- expires). Same pattern otp_requests already uses.
--
-- Additive and idempotent: one nullable-with-default column, no backfill, no
-- data movement. Existing in-flight challenges simply start from 0.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE admin_2fa_pending
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
