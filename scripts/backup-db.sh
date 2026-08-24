#!/usr/bin/env bash
# NamastePOS — automated pg_dump backup
#
# Default behaviour: dumps the `namastepos` DB to ~/namastepos-backups/, gzips it,
# stamps it with timestamp + git short SHA, and prunes anything older than
# 30 days. Safe to run any number of times — never touches the DB itself.
#
# Configure via env vars (all optional):
#   FF_BACKUP_DB        = database name              (default: namastepos)
#   FF_BACKUP_USER      = postgres user              (default: $USER)
#   FF_BACKUP_HOST      = postgres host              (default: localhost)
#   FF_BACKUP_DIR       = where dumps land           (default: $HOME/namastepos-backups)
#   FF_BACKUP_RETAIN_D  = days to keep old backups   (default: 30)
#   FF_BACKUP_S3_BUCKET = optional S3 bucket name    (default: empty — local only)
#
# Manual run:
#   ./scripts/backup-db.sh
# Or via cron (see scripts/install-backup-cron.sh).

set -euo pipefail

DB="${FF_BACKUP_DB:-namastepos}"
USER_PG="${FF_BACKUP_USER:-$USER}"
HOST="${FF_BACKUP_HOST:-localhost}"
OUT_DIR="${FF_BACKUP_DIR:-$HOME/namastepos-backups}"
RETAIN_DAYS="${FF_BACKUP_RETAIN_D:-30}"
S3_BUCKET="${FF_BACKUP_S3_BUCKET:-}"

mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_SHA="$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo nogit)"
OUT_FILE="${OUT_DIR}/${DB}-${TIMESTAMP}-${SHORT_SHA}.sql.gz"

echo "[backup-db] dumping $DB@$HOST → $OUT_FILE"

# --no-owner + --no-privileges so the dump is restorable into any user/role
pg_dump \
  --host="$HOST" \
  --username="$USER_PG" \
  --no-owner \
  --no-privileges \
  --format=plain \
  --clean --if-exists \
  "$DB" 2>/tmp/namastepos-backup-stderr.log \
  | gzip -9 > "$OUT_FILE"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "[backup-db] ok ($SIZE)"

# Optional S3 upload (skipped if aws CLI missing or no bucket configured)
if [[ -n "$S3_BUCKET" ]] && command -v aws >/dev/null 2>&1; then
  echo "[backup-db] uploading to s3://$S3_BUCKET/"
  aws s3 cp "$OUT_FILE" "s3://$S3_BUCKET/" >/dev/null
  echo "[backup-db] s3 ok"
fi

# Prune old local backups
echo "[backup-db] pruning > ${RETAIN_DAYS}d in $OUT_DIR"
find "$OUT_DIR" -name "${DB}-*.sql.gz" -type f -mtime +"$RETAIN_DAYS" -print -delete \
  | awk '{ print "[backup-db]  deleted " $0 }'

echo "[backup-db] done"
