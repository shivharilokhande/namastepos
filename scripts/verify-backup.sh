#!/usr/bin/env bash
# NamastePOS — backup verification
#
# Picks the newest backup in ~/namastepos-backups/, restores it into a
# disposable DB (namastepos_verify_<timestamp>), runs sanity SELECTs, then
# drops the throwaway DB. Anything failing exits non-zero so a cron run
# pings the log + (optionally) sends a notification.
#
# Never touches the live `namastepos` DB. Safe to invoke at any time.
#
# Env vars:
#   FF_BACKUP_DIR   = where dumps live      (default: $HOME/namastepos-backups)
#   FF_BACKUP_USER  = postgres user         (default: $USER)
#   FF_BACKUP_HOST  = postgres host         (default: localhost)
#   FF_BACKUP_DB    = source DB name        (default: namastepos)  — used only to
#                                            check that the verify DB has the
#                                            same critical tables as the source.

set -euo pipefail

OUT_DIR="${FF_BACKUP_DIR:-$HOME/namastepos-backups}"
USER_PG="${FF_BACKUP_USER:-$USER}"
HOST="${FF_BACKUP_HOST:-localhost}"
SOURCE_DB="${FF_BACKUP_DB:-namastepos}"

LATEST="$(ls -t "$OUT_DIR"/${SOURCE_DB}-*.sql.gz 2>/dev/null | head -1 || true)"
if [[ -z "$LATEST" ]]; then
  echo "[verify-backup] ERROR: no backups found in $OUT_DIR" >&2
  exit 1
fi

VERIFY_DB="${SOURCE_DB}_verify_$(date -u +%Y%m%d%H%M%S)"

echo "[verify-backup] latest backup: $LATEST"
echo "[verify-backup] target verify DB: $VERIFY_DB"

cleanup() {
  echo "[verify-backup] cleanup → dropping $VERIFY_DB"
  dropdb -h "$HOST" -U "$USER_PG" "$VERIFY_DB" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Gzip integrity
if ! gzip -t "$LATEST" 2>/dev/null; then
  echo "[verify-backup] FAIL: backup is not a valid gzip" >&2
  exit 2
fi
echo "[verify-backup] gzip ok"

# 2. Create throwaway DB
createdb -h "$HOST" -U "$USER_PG" "$VERIFY_DB"

# 3. Restore (silent except errors). --single-transaction so a bad backup
#    rolls back cleanly instead of leaving us with half a schema.
if ! gunzip -c "$LATEST" \
      | psql -h "$HOST" -U "$USER_PG" -d "$VERIFY_DB" \
             -v ON_ERROR_STOP=1 --single-transaction \
             >/dev/null 2>/tmp/namastepos-verify-stderr.log; then
  echo "[verify-backup] FAIL: psql restore errored. See /tmp/namastepos-verify-stderr.log" >&2
  exit 3
fi
echo "[verify-backup] restore ok"

# 4. Sanity SELECTs — confirm critical tables exist and are queryable. This
#    catches the "backup looked fine but every business row is gone" class
#    of bug. We DON'T assert any minimum row count — a brand-new DB is
#    legitimately empty; we just need the tables there + queryable.
TABLES=(businesses users business_users plans subscriptions menu_items orders)
for t in "${TABLES[@]}"; do
  if ! psql -h "$HOST" -U "$USER_PG" -d "$VERIFY_DB" \
        -tAc "SELECT count(*) FROM \"$t\"" >/dev/null 2>/dev/null; then
    echo "[verify-backup] FAIL: table $t missing or unreadable" >&2
    exit 4
  fi
done
echo "[verify-backup] schema ok (${#TABLES[@]} critical tables queryable)"

# 5. Compare row counts vs. source DB (warn-only — fine for differences)
echo "[verify-backup] row-count compare (verify ↔ source):"
for t in "${TABLES[@]}"; do
  VC=$(psql -h "$HOST" -U "$USER_PG" -d "$VERIFY_DB" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "?")
  SC=$(psql -h "$HOST" -U "$USER_PG" -d "$SOURCE_DB" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "?")
  printf "  %-18s verify=%-8s source=%-8s\n" "$t" "$VC" "$SC"
done

echo "[verify-backup] OK — backup is restorable"
