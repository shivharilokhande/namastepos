-- Migration 032 — Email + password login alongside Google Sign-In.
-- Adds a nullable `password_hash` column on users. Existing Google-only
-- accounts keep working; users can opt into setting a password from the
-- profile screen.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Optional: track which auth method was last used (Google or password).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_method VARCHAR(20);

-- google_sub was NOT NULL + UNIQUE originally. We need to relax NOT NULL so
-- password-only registrations don't need a synthetic Google sub, and convert
-- the full UNIQUE constraint into a PARTIAL UNIQUE index so multiple NULLs
-- are allowed (rather than just one).
--
-- DROP CONSTRAINT (not DROP INDEX) — Postgres bound the unique behaviour to
-- a CONSTRAINT created automatically by the `UNIQUE` clause on the column.

ALTER TABLE users
  ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_google_sub_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
  ON users (google_sub) WHERE google_sub IS NOT NULL;

ALTER TABLE businesses
  ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_google_sub_key;
CREATE UNIQUE INDEX IF NOT EXISTS businesses_google_sub_unique
  ON businesses (google_sub) WHERE google_sub IS NOT NULL;
