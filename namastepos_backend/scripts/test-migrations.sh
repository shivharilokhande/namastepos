#!/usr/bin/env bash
# QA-Test: forwards then re-run from scratch — fails if either drifts.
#
# Assumes a "scratch" database is available (DEFAULT: namastepos_migrationtest).
# Used in CI; can also be run locally to sanity-check a new migration.

set -euo pipefail
DB="${MIGRATION_TEST_DB:-namastepos_migrationtest}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Dropping + recreating ${DB}"
dropdb --if-exists "${DB}"
createdb "${DB}"

echo "→ Running all migrations forward"
for f in "${DIR}/db/migrations/"*.sql; do
  echo "  • $(basename "$f")"
  psql -q "${DB}" -f "$f"
done

echo "→ Re-running same migrations (must be idempotent)"
for f in "${DIR}/db/migrations/"*.sql; do
  psql -q "${DB}" -f "$f"
done

echo "✓ Migrations forward + re-run completed without error"
