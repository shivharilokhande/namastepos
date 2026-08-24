#!/usr/bin/env bash
# Installs a crontab entry to run backup-db.sh every hour on the user's Mac.
# Idempotent — running it twice does NOT duplicate the entry.
#
# Usage:
#   ./scripts/install-backup-cron.sh         # install / update
#   ./scripts/install-backup-cron.sh remove  # remove the entry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-backup.sh"
MARKER_BACKUP="# namastepos-db-backup"
MARKER_VERIFY="# namastepos-db-verify"
LOG_FILE="$HOME/namastepos-backups/backup-cron.log"
VERIFY_LOG="$HOME/namastepos-backups/verify-cron.log"

# Make sure every script is executable (no harm if already is)
for s in "$BACKUP_SCRIPT" "$VERIFY_SCRIPT" "$SCRIPT_DIR/restore-db.sh"; do
  [[ -f "$s" && ! -x "$s" ]] && chmod +x "$s"
done

# Hourly backup
BACKUP_CRON="0 * * * * cd \"$SCRIPT_DIR/..\" && /bin/bash \"$BACKUP_SCRIPT\" >> \"$LOG_FILE\" 2>&1 $MARKER_BACKUP"
# Weekly verify — Sunday 03:30 (after the 03:00 backup landed)
VERIFY_CRON="30 3 * * 0 cd \"$SCRIPT_DIR/..\" && /bin/bash \"$VERIFY_SCRIPT\" >> \"$VERIFY_LOG\" 2>&1 $MARKER_VERIFY"

if [[ "${1:-}" == "remove" ]]; then
  echo "Removing namastepos backup + verify cron entries..."
  (crontab -l 2>/dev/null | grep -v -F "$MARKER_BACKUP" | grep -v -F "$MARKER_VERIFY") | crontab - || true
  echo "Done."
  exit 0
fi

echo "Installing cron entries:"
echo "  hourly  : $BACKUP_CRON"
echo "  weekly  : $VERIFY_CRON"
echo ""

# Strip any existing entries (both markers) then re-add — idempotent
(crontab -l 2>/dev/null \
   | grep -v -F "$MARKER_BACKUP" \
   | grep -v -F "$MARKER_VERIFY"
 echo "$BACKUP_CRON"
 echo "$VERIFY_CRON") | crontab -

mkdir -p "$(dirname "$LOG_FILE")"

echo "Installed."
echo "  Backup log : $LOG_FILE"
echo "  Verify log : $VERIFY_LOG"
echo "  Verify cron runs Sundays at 03:30 local time."
echo ""
echo "Verify both entries with: crontab -l"
echo "To uninstall later:       $0 remove"
