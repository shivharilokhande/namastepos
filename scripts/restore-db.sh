#!/usr/bin/env bash
# NamastePOS — restore a DB from a pg_dump backup file.
#
# DESTRUCTIVE: this drops the target schema before restoring. The script
# requires two confirmations + the target DB name typed verbatim, and refuses
# to run unless the file is a valid gzipped SQL dump.
#
# Usage:
#   ./scripts/restore-db.sh <path-to-backup.sql.gz> [target-db-name]
#
# Default target DB: namastepos_restore  (NEVER overwrites the live `namastepos`
# DB unless you explicitly pass it as the 2nd arg AND type it again to confirm)

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_DB="${2:-namastepos_restore}"
USER_PG="${FF_BACKUP_USER:-$USER}"
HOST="${FF_BACKUP_HOST:-localhost}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <path-to-backup.sql.gz> [target-db-name]"
  echo ""
  echo "Available local backups:"
  ls -lh "${FF_BACKUP_DIR:-$HOME/namastepos-backups}"/*.sql.gz 2>/dev/null || echo "  (none)"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: backup file not found: $BACKUP_FILE"
  exit 1
fi

# Verify it's a gzip
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "ERROR: $BACKUP_FILE is not a valid gzip file"
  exit 1
fi

echo "================================================================"
echo " Restore plan"
echo "================================================================"
echo "  Source file : $BACKUP_FILE"
echo "  File size   : $(du -h "$BACKUP_FILE" | cut -f1)"
echo "  Target DB   : $TARGET_DB"
echo "  Host        : $HOST"
echo "  User        : $USER_PG"
echo "================================================================"
echo ""

if [[ "$TARGET_DB" == "namastepos" ]]; then
  echo "⚠️  YOU ARE ABOUT TO OVERWRITE THE LIVE DEV DB (namastepos)."
  echo "⚠️  All current data in this DB will be LOST."
  echo ""
fi

read -p "Type the target DB name verbatim to proceed (or Ctrl+C to abort): " CONFIRM_DB
if [[ "$CONFIRM_DB" != "$TARGET_DB" ]]; then
  echo "Confirmation mismatch. Aborting."
  exit 1
fi

read -p "Are you sure? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# Create target DB if it doesn't exist (skip error if it does)
echo "[restore-db] ensuring database $TARGET_DB exists..."
createdb -h "$HOST" -U "$USER_PG" "$TARGET_DB" 2>/dev/null || true

# Restore. The dump was made with --clean --if-exists, so it will drop tables
# inside the target before recreating.
echo "[restore-db] restoring $BACKUP_FILE → $TARGET_DB ..."
gunzip -c "$BACKUP_FILE" | psql -h "$HOST" -U "$USER_PG" -d "$TARGET_DB" -v ON_ERROR_STOP=1

echo ""
echo "[restore-db] DONE."
echo ""
echo "Next steps:"
echo "  • Verify: psql $TARGET_DB -c 'SELECT count(*) FROM businesses;'"
if [[ "$TARGET_DB" != "namastepos" ]]; then
  echo "  • To make this the live DB, update DATABASE_URL in namastepos_backend/.env"
  echo "    or rename the DBs: ALTER DATABASE namastepos RENAME TO namastepos_old;"
  echo "                        ALTER DATABASE $TARGET_DB RENAME TO namastepos;"
fi
