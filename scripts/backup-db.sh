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

# Strix M-3 (2026-08-31): the dump contains every tenant's data — password
# hashes, 2FA secrets, payment config. umask 077 so dump files are readable
# only by the owner; set FF_BACKUP_ENC_PASSPHRASE to encrypt at rest.
umask 077

DB="${FF_BACKUP_DB:-namastepos}"
USER_PG="${FF_BACKUP_USER:-$USER}"
HOST="${FF_BACKUP_HOST:-localhost}"
OUT_DIR="${FF_BACKUP_DIR:-$HOME/namastepos-backups}"
RETAIN_DAYS="${FF_BACKUP_RETAIN_D:-30}"
S3_BUCKET="${FF_BACKUP_S3_BUCKET:-}"
ENC_PASS="${FF_BACKUP_ENC_PASSPHRASE:-}"          # set to encrypt dumps at rest
S3_SSE="${FF_BACKUP_S3_SSE:-AES256}"              # SSE-S3 by default

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_SHA="$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [[ -n "$ENC_PASS" ]]; then EXT="sql.gz.enc"; else EXT="sql.gz"; fi
OUT_FILE="${OUT_DIR}/${DB}-${TIMESTAMP}-${SHORT_SHA}.${EXT}"

echo "[backup-db] dumping $DB@$HOST → $OUT_FILE"

# --no-owner + --no-privileges so the dump is restorable into any user/role.
# When FF_BACKUP_ENC_PASSPHRASE is set the gzip stream is symmetrically
# encrypted (AES-256, PBKDF2) before it ever touches disk.
if [[ -n "$ENC_PASS" ]]; then
  pg_dump --host="$HOST" --username="$USER_PG" --no-owner --no-privileges \
    --format=plain --clean --if-exists "$DB" 2>/tmp/namastepos-backup-stderr.log \
    | gzip -9 \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:FF_BACKUP_ENC_PASSPHRASE -out "$OUT_FILE"
else
  echo "[backup-db] WARNING: FF_BACKUP_ENC_PASSPHRASE not set — this dump is UNENCRYPTED."
  pg_dump --host="$HOST" --username="$USER_PG" --no-owner --no-privileges \
    --format=plain --clean --if-exists "$DB" 2>/tmp/namastepos-backup-stderr.log \
    | gzip -9 > "$OUT_FILE"
fi
chmod 600 "$OUT_FILE" 2>/dev/null || true

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "[backup-db] ok ($SIZE)"

# Optional S3 upload (skipped if aws CLI missing or no bucket configured).
# Server-side encryption enforced via --sse (Strix M-3).
if [[ -n "$S3_BUCKET" ]] && command -v aws >/dev/null 2>&1; then
  echo "[backup-db] uploading to s3://$S3_BUCKET/ (sse=$S3_SSE)"
  aws s3 cp "$OUT_FILE" "s3://$S3_BUCKET/" --sse "$S3_SSE" >/dev/null
  echo "[backup-db] s3 ok"
fi

# Prune old local backups (both plain and encrypted)
echo "[backup-db] pruning > ${RETAIN_DAYS}d in $OUT_DIR"
find "$OUT_DIR" -type f \( -name "${DB}-*.sql.gz" -o -name "${DB}-*.sql.gz.enc" \) \
  -mtime +"$RETAIN_DAYS" -print -delete \
  | awk '{ print "[backup-db]  deleted " $0 }'

echo "[backup-db] done"
