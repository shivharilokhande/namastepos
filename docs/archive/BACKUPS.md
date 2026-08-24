# FoodFlow — DB backup & restore

Backups protect against the kind of data loss that hit the dev DB on 2026-05-25.
Three scripts live in `scripts/`, all additive — they never touch the running
backend, dashboard, admin, or mobile app.

## What's where

| File | Purpose |
|---|---|
| `scripts/backup-db.sh` | Runs `pg_dump` → gzip → timestamped file in `~/foodflow-backups/`. Auto-prunes anything older than 30 days. |
| `scripts/restore-db.sh` | Restores a chosen backup into a target DB. Refuses to run without typing the target DB name verbatim. Defaults to a NEW DB (`foodflow_restore`) so the live `foodflow` is never overwritten by accident. |
| `scripts/install-backup-cron.sh` | Installs a Mac crontab entry to run the backup once per hour. Idempotent — re-running just replaces the entry, doesn't duplicate. |

## One-time setup (manual run)

```bash
# Make scripts executable + run once to verify
chmod +x scripts/*.sh
./scripts/backup-db.sh
```

Expected output:
```
[backup-db] dumping foodflow@localhost → /Users/<you>/foodflow-backups/foodflow-20260525T123000Z-abc1234.sql.gz
[backup-db] ok (xxK)
[backup-db] pruning > 30d in /Users/<you>/foodflow-backups
[backup-db] done
```

## Schedule it (hourly)

```bash
./scripts/install-backup-cron.sh
```

This adds **one** crontab line — verify with `crontab -l`. Logs go to `~/foodflow-backups/backup-cron.log`.

To uninstall:
```bash
./scripts/install-backup-cron.sh remove
```

## Restoring (the part that would have saved us today)

```bash
# 1. See available backups
./scripts/restore-db.sh
# (with no args, prints the list and exits)

# 2. Restore into a SAFE staging DB first (default behaviour)
./scripts/restore-db.sh ~/foodflow-backups/foodflow-20260525T120000Z-abc1234.sql.gz
# Creates / overwrites foodflow_restore — your live foodflow stays intact.

# 3. Verify it
psql foodflow_restore -c "SELECT count(*) FROM businesses;"
psql foodflow_restore -c "SELECT count(*) FROM menu_items;"

# 4a. If correct AND you want to swap it in as live:
psql postgres -c "ALTER DATABASE foodflow RENAME TO foodflow_old_$(date +%Y%m%d);"
psql postgres -c "ALTER DATABASE foodflow_restore RENAME TO foodflow;"
# (Backend reconnects on next request; no restart needed.)

# 4b. OR explicitly restore over foodflow (requires typing 'foodflow' twice)
./scripts/restore-db.sh ~/foodflow-backups/foodflow-20260525T120000Z-abc1234.sql.gz foodflow
```

## S3 offsite (optional)

If you have AWS credentials configured and want backups uploaded:

```bash
export FF_BACKUP_S3_BUCKET=your-bucket-name
./scripts/backup-db.sh
```

Or set it in your shell rc / cron environment. With `FF_BACKUP_S3_BUCKET` unset
the script just keeps the local copy.

## Environment variables (all optional)

| Var | Default | What |
|---|---|---|
| `FF_BACKUP_DB` | `foodflow` | DB to dump |
| `FF_BACKUP_USER` | `$USER` | Postgres user |
| `FF_BACKUP_HOST` | `localhost` | Postgres host |
| `FF_BACKUP_DIR` | `~/foodflow-backups` | Where dumps go |
| `FF_BACKUP_RETAIN_D` | `30` | Days to keep |
| `FF_BACKUP_S3_BUCKET` | (empty) | Optional S3 destination |

## Weekly verification

`scripts/verify-backup.sh` proves the latest backup is restorable. It:

1. Picks the newest `*.sql.gz` in `$HOME/foodflow-backups/`
2. Tests gzip integrity
3. Creates a disposable `foodflow_verify_<timestamp>` DB
4. Restores into it inside a single transaction (`--single-transaction`)
5. Runs `SELECT count(*)` on critical tables (businesses, users, business_users, plans, subscriptions, menu_items, orders)
6. Drops the throwaway DB at the end (or on any failure)

The live `foodflow` DB is never touched. Exit code is non-zero on any failure, so a cron run will leave a clear error in `~/foodflow-backups/verify-cron.log`.

`install-backup-cron.sh` schedules the verify weekly (Sunday 03:30 local). Run the install script again any time to re-sync; it's idempotent.

```bash
# Manual run any time
./scripts/verify-backup.sh
```

## What's intentionally NOT done yet

- **WAL archiving for point-in-time recovery** (sub-second restore granularity) — adds complexity; defer until prod traffic is real.
- **Encrypted backups** — `gpg --encrypt` step before upload. Add when we start handling production customer data.
- **Notification on verify failure** — currently only logs to `~/foodflow-backups/verify-cron.log`. Add Sentry / Slack hook once observability is wired up (Sprint 0.6).
