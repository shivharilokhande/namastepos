# Disaster Recovery drill — NamastePOS

**Audience:** the founder, alone, possibly at 22:00 during dinner service.
**Goal of the drill:** prove in ~20 minutes that you can get the data back and
tell whether what you got back is *correct*.

This is specific to the deployment as it actually exists today:

| Layer | Where it lives | Config stored in |
| --- | --- | --- |
| Database | **Neon** Postgres | connection string in Render env |
| API | **Render** (`namastepos-api`), auto-deploys on push to `main` | Render dashboard **only** — there is no `render.yaml` |
| Dashboard + Admin SPAs | **Cloudflare Pages** | Pages dashboard **only** — no `wrangler.toml` for them |
| Menu photos / logos | **Cloudflare R2** `namastepos-uploads` → `images.namastepos.in` | — |
| Android APK | **Cloudflare R2** `namastepos-downloads/NamastePOS.apk` | — |
| Keep-alive | Cloudflare Worker `namastepos-keepalive` (`ops/keepalive-worker/`) | `wrangler.toml` in repo |
| Local hourly dumps | founder's Mac, `~/namastepos-backups/` | crontab (`scripts/install-backup-cron.sh`) |

> **Read this first:** `GET /health` returns **200 with a completely dead
> database** — it is a one-line liveness route (`src/app.js:193`). The endpoint
> that actually checks Postgres is **`GET /v1/health`**, which runs
> `SELECT health_db_ping()` and returns **503 + `status:"degraded"`** when the DB
> is unreachable. Never use `/health` to judge a restore.

---

## 1. What your RPO and RTO actually are

Honest numbers for the current plan tiers, not aspirational ones.

### RPO (how much data you can lose)

| Mechanism | RPO | Confidence |
| --- | --- | --- |
| **Neon history / PITR**, if enabled | **~0–1 minute** (continuous WAL, restore to any instant in the window) | ⚠️ **UNVERIFIED — see below** |
| **Hourly `pg_dump` cron** on the founder's Mac | **up to 60 minutes** | Only if the Mac was awake and online |
| Both unavailable | **total loss** | — |

**The retention window is the number to go confirm right now.** Neon's history
retention is tier-dependent — 24 hours on the free tier, longer on paid. Outside
that window PITR cannot help you at all, and you fall back to the hourly dump.

⚠️ **PITR is not confirmed enabled anywhere in this repo.**
`docs/archive/DEPLOYMENT.md` still lists "enable Point-In-Time Recovery" as an
**unchecked** launch task, and `docs/archive/BACKUPS.md` lists "WAL archiving for
point-in-time recovery" under *"What's intentionally NOT done yet."*
**Task zero of this drill is to open the Neon console and write the real
retention window into the log table at the bottom.** Until you do, your true
RPO is 60 minutes, not one minute.

### RTO (how long until you are serving again)

| Scenario | RTO | What dominates it |
| --- | --- | --- |
| Render is down, DB is fine | **Render's recovery time — not yours** | Free/Starter tiers carry no SLA. You wait, or §5 |
| Stand the API up somewhere else | **45–90 min** | ⚠️ Re-entering ~40 env vars by hand |
| DB restore from Neon branch | **15–30 min** | Branch creation is fast; repointing + redeploy is not |
| DB restore from hourly dump | **30–60 min** | `psql` restore of the gzip, then the swap |
| Rebuild an SPA | **~10 min** | Cloudflare Pages build from `main` |
| Re-publish the APK | **~5 min** with the file, **~25 min** if you must rebuild | `wrangler r2 object put` |

**The single biggest RTO risk is not the database — it is that there is no
infrastructure-as-code.** No `render.yaml`, no Pages config in the repo. Every
environment variable, build command and custom domain lives in a web dashboard
and in your password manager. If the Render *account* is what you lose, the
recovery is a manual re-entry of the whole env surface, and `src/config/env.js`
is the only authoritative list of what that surface is (`.env.production.example`
is **incomplete** — it is missing `R2_*`, `REDIS_URL`, `META_WA_*`,
`DATABASE_SSL`/`DB_SSL_VERIFY`, `REVENUE_INTEGRITY_CRON` and `ORDER_TAX_ENFORCE`).

**Fixing that is worth more than any rehearsal in this document.** See §8.

---

## 2. Before you start (5 minutes, once)

Have these open or to hand. If any is missing, the drill *is* discovering that.

- [ ] Neon console → the project, and its **history retention** setting
- [ ] Render dashboard → `namastepos-api` → Environment tab
- [ ] Cloudflare dashboard → Pages projects, R2 buckets
- [ ] Password manager entry with `JWT_SECRET`, `DATABASE_URL`, `RAZORPAY_*`, `R2_*`
- [ ] `psql` installed locally (`psql --version`)
- [ ] The repo checked out at the commit currently deployed (`git log -1 --oneline origin/main`)

> **Never rotate `JWT_SECRET` during a recovery.** It signs access tokens *and*
> derives the 2FA key-encryption key. Changing it logs everyone out **and makes
> every stored 2FA secret permanently undecryptable.** It is not a "while we're
> here" hygiene task.

---

## 3. THE DRILL (~20 minutes) — restore to a branch and verify it

This is the rehearsal you can run any time without touching production. It uses
a Neon **branch**, which is a copy-on-write clone: creating one does not move
load onto your live database and does not affect it.

### Step 1 — pick a restore point (1 min)

Choose a timestamp ~30 minutes ago. Record it in the log table; every
verification below is judged against it.

### Step 2 — create a branch at that point in time (3 min)

Neon console → your project → **Branches** → **New branch** →
*Create from: point in time* → paste the timestamp → name it
`dr-drill-YYYY-MM-DD`.

Copy its connection string. It looks like the production one with a different
host. Export it locally — **note this is the branch, never production**:

```bash
export DR_URL='postgresql://…@ep-dr-drill-….neon.tech/namastepos?sslmode=require'
psql "$DR_URL" -c 'SELECT current_database(), now();'
```

### Step 3 — run the verification suite (10 min)

Everything in **§4**. Do not skip the tie-out query — row counts prove the
restore *ran*; only the tie-out proves it is *right*.

### Step 4 — point a local API at the branch (3 min, optional but valuable)

This is what catches "the data is fine but the app can't boot", which is a
different failure and a common one.

```bash
cd namastepos_backend
DATABASE_URL="$DR_URL" DATABASE_SSL=1 \
JWT_SECRET='<the real one, from the vault>' \
NODE_ENV=development CORS_ORIGINS='http://localhost:5174' \
  npm start

# in another shell — note /v1, not /health
curl -s localhost:4000/v1/health | tee /dev/stderr | grep -q '"db":"ok"' \
  && echo "RESTORE BOOTS OK" || echo "RESTORE DOES NOT BOOT"
```

`JWT_SECRET` is **required at boot** outside `NODE_ENV=test`, so `npm start` and
`npm run migrate` both refuse to run without it. Discovering that during a real
outage costs ten minutes; discovering it here costs none.

### Step 5 — record and tear down (3 min)

Fill in the log table. Then **delete the branch** — a forgotten branch quietly
accrues storage cost.

---

## 4. How to verify a restore is GOOD

Run these against `$DR_URL`. Each has a pass condition, not just an output.

### 4.1 Schema is complete

```sql
-- Migration ledger. 82 files ship today, highest = 085_idempotency_keys.sql.
-- (Numbers 063, 064 and 067 are RETIRED — gaps are expected, do not backfill.)
SELECT count(*) AS applied, max(name) AS highest FROM _migrations;

-- /v1/health depends on this function (created in 011_full_hardening.sql).
-- If it is missing, the API will report db:"down" against a perfectly good DB.
SELECT health_db_ping();
```

**Pass:** `applied` matches `ls namastepos_backend/db/migrations/*.sql | wc -l`
for the deployed commit; `health_db_ping()` returns a timestamp.

### 4.2 The data is there, and it is recent

```sql
SELECT
  (SELECT count(*) FROM businesses)   AS businesses,
  (SELECT count(*) FROM users)        AS users,
  (SELECT count(*) FROM orders)       AS orders,
  (SELECT count(*) FROM order_items)  AS order_items,
  (SELECT count(*) FROM payments)     AS saas_payments,
  (SELECT count(*) FROM tax_invoices) AS tax_invoices,
  (SELECT count(*) FROM daily_closings) AS daily_closings;

-- How close to the restore point did we actually land?
SELECT max(created_at) AS newest_order,
       max(updated_at) AS newest_touch,
       now() - max(created_at) AS age
  FROM orders;
```

**Pass:** `newest_order` is at or just before your chosen restore point. If it is
*hours* earlier, you restored from the wrong mechanism or the wrong timestamp.

> `payments` is the **SaaS subscription** table (`amount_paise`), not customer
> tender. Customer payment lives on `orders.payment_method` and
> `orders.payment_breakdown` (JSONB, amounts in **rupees**). There is no
> `order_payments` table — do not go looking for one.

### 4.3 Order numbering is intact

`orders` has `uq_orders_no UNIQUE (business_id, order_no)`. A torn restore shows
up here before it shows up in money.

```sql
SELECT business_id,
       count(*)        AS orders,
       max(order_no)   AS highest_no,
       max(order_no) - count(*) AS gap
  FROM orders
 GROUP BY business_id
 ORDER BY orders DESC
 LIMIT 10;
```

**Pass:** `gap` is small and stable (cancellations create legitimate gaps). A
*negative* gap means duplicate order numbers — stop and investigate.

### 4.4 THE MONEY TIE-OUT — restored orders vs. the last signed closing

This is the one that matters. `daily_closings` is the founder-signed Z-report;
if the restored `orders` rows still reproduce it, the money survived.

```sql
WITH last_close AS (
  SELECT business_id, closing_date, cash_expected, cash_counted, closed_at
    FROM daily_closings
   ORDER BY closing_date DESC, closed_at DESC
   LIMIT 1
)
SELECT
  lc.business_id,
  lc.closing_date,
  lc.cash_expected AS closing_expected_paise,
  ROUND(COALESCE(SUM(o.total) FILTER (WHERE o.payment_method = 'cash'), 0) * 100)::bigint
    AS restored_cash_paise,
  ROUND(COALESCE(SUM(o.total) FILTER (WHERE o.payment_method = 'cash'), 0) * 100)::bigint
    - lc.cash_expected AS variance_paise
FROM last_close lc
LEFT JOIN orders o
       ON o.business_id = lc.business_id
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = lc.closing_date
      AND o.status <> 'cancelled'
GROUP BY lc.business_id, lc.closing_date, lc.cash_expected, lc.cash_counted;
```

**Pass: `variance_paise = 0`.**

Three things that make this query correct — change any of them and it will lie:

1. **The business day is IST, not UTC.** Every closing query buckets on
   `(created_at AT TIME ZONE 'Asia/Kolkata')::date`. A UTC-bucketed query
   disagrees by every order between 18:30 and midnight IST.
2. **Units differ.** `daily_closings.cash_expected` is **paise** (INTEGER);
   `orders.total` is **rupees** `NUMERIC(10,2)`. Hence the `* 100`.
3. **Cancelled orders are excluded**, and only `payment_method = 'cash'` counts —
   mirroring `dailyClosingService.preview()`.

> Known imprecision to *not* chase: on a split-tender order,
> `payment_method` holds the **largest leg**, so a cash+UPI order where cash was
> larger books its *entire* total as cash. The closing was computed the same way,
> so the tie-out still nets to zero. It is a pre-existing reporting quirk, not a
> restore defect.

### 4.5 Nothing is silently broken

```sql
-- NULL = healthy for both. Non-zero means orders committed without a kitchen
-- ticket or without their inventory deduction.
SELECT count(*) FILTER (WHERE kot_error       IS NOT NULL) AS kot_failures,
       count(*) FILTER (WHERE inventory_error IS NOT NULL) AS inventory_failures
  FROM orders
 WHERE created_at > now() - interval '7 days';

-- Subscription webhooks must still be advancing.
SELECT count(*) AS unprocessed
  FROM webhook_events
 WHERE processed_at IS NULL;
```

### 4.6 Use the integrity sweep that already exists

The highest-value single check is already written. `revenueIntegrityService`
exports `checkPlanPriceDrift`, `checkStuckRefunds`, `checkDeadWebhookEvents`,
`checkUnbilledDeliveries`, `checkOrdersMissingKot`, `checkStuckInventoryEffects`,
`checkDeadPrintJobs` and `checkUsageDrift`. Point it at the branch:

```bash
cd namastepos_backend
DATABASE_URL="$DR_URL" DATABASE_SSL=1 JWT_SECRET='<vault>' \
NODE_ENV=development PLATFORM_ALERT_EMAIL='you@example.com' \
  node -e "require('./src/services/revenueIntegrityService').runDaily().then(r=>console.log(JSON.stringify(r,null,2)))"
```

### 4.7 Tenant isolation still holds

A restore that merges or mis-scopes tenants is worse than no restore.
`scripts/idor-audit.js` logs two owners in and asserts neither can read the
other's data across every business-scoped GET. Run it against the local API from
Step 4 with `OWNER_A_EMAIL` / `OWNER_B_EMAIL` set.

---

## 5. Runbook A — "Render is down, the database is fine"

**Diagnose first.** These two answers separate the cases:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.namastepos.in/health     # liveness
curl -s https://api.namastepos.in/v1/health                                    # DB-aware
```

| `/health` | `/v1/health` | Meaning | Action |
| --- | --- | --- | --- |
| 200 | `db:"ok"` | Healthy. The problem is elsewhere (DNS, Cloudflare, an SPA build) | §6 |
| 200 | 503 `db:"degraded"` | **API is up, database is not.** Do not redeploy — it will not help | Runbook B |
| timeout / 502 | timeout | API process is down | below |

**If the API is down and the DB is fine — do NOT restore anything.**
The database is not the problem and a restore can only lose data.

1. Render dashboard → `namastepos-api` → **Logs**. A crash loop is almost always
   a missing/blank env var: `CORS_ORIGINS` and `DATABASE_URL` **fail closed** in
   production by design, and `JWT_SECRET` is required at boot.
2. **Manual Deploy → Deploy last successful commit.** Not "latest" — last
   *successful*.
3. Still down? Suspect cold start, not outage: the free tier sleeps, and the
   keep-alive Worker (`ops/keepalive-worker/`, every 5 min) is what normally
   masks it. Check the Worker is still deployed — if it was deleted, first-hit
   latency of 30–50 s reads exactly like an outage.
4. If Render itself is the outage, you have a working `Dockerfile`
   (`node:22-alpine`, `EXPOSE 4000`, non-root, does **not** run migrations). Any
   container host will run it. The cost is re-entering the env surface from
   `src/config/env.js` — budget 45–90 min, and mind that
   **`CORS_ORIGINS` must list the Pages origins** or both SPAs will load and then
   fail every request.

**Customer-facing note:** the POS keeps taking orders offline. Orders are
client-UUID-keyed (`orders.client_id` with `uq_orders_client`) and drain through
the outbox on reconnect, so an API outage is a degradation, not lost revenue.
Tell customers to keep billing.

---

## 6. Runbook B — "the database is corrupt or has lost data"

Stop and read §1 before touching anything. **Establish the restore point before
you start**, because every option below is judged against it.

### B1 — Decide the mechanism

```
Is the damage inside the Neon history retention window?
├─ YES → Neon branch at a point in time.  ← always prefer this
└─ NO  → hourly pg_dump from ~/namastepos-backups/. RPO up to 60 min.
```

### B2 — Restore into somewhere that is not production

**Never restore over the live database.** Both paths deliberately land elsewhere.

**Neon PITR:** create a branch as in §3 Step 2, verify it with §4, and only then
promote it / repoint `DATABASE_URL`.

**From an hourly dump:** `scripts/restore-db.sh` defaults its target to
`namastepos_restore` (never live) and requires you to type the target DB name
verbatim *and* `yes`. It validates the archive with `gzip -t` first.

```bash
cd "/path/to/PetPooja Clone"
./scripts/restore-db.sh              # lists available backups
./scripts/restore-db.sh ~/namastepos-backups/namastepos-<ts>-<sha>.sql.gz
```

> ⚠️ **`restore-db.sh` only handles `.sql.gz`, not `.sql.gz.enc`.** If
> `FF_BACKUP_ENC_PASSPHRASE` is ever set, the resulting encrypted dumps
> **cannot be restored by this script as written** — and its "available backups"
> listing globs only `*.sql.gz`, so encrypted archives are invisible to it. Today
> that means dumps are unencrypted (restorable, but also an exposure). Decrypt
> manually:
> ```bash
> openssl enc -d -aes-256-cbc -pbkdf2 -in backup.sql.gz.enc | gunzip -c | psql "$TARGET"
> ```
> Fixing the script is on the §8 list.

### B3 — Deal with migrations that ran after the restore point

This is the step people forget, and it is genuinely easy here because migrations
are **forward-only, additive and idempotent** (CI re-applies every file twice to
prove it).

First, see what the restored database thinks it has:

```sql
SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC LIMIT 15;
```

Then let the runner reconcile the delta. `migrate.js` records by **filename**,
skips anything already in `_migrations`, and applies the rest in lexical order:

```bash
cd namastepos_backend
DATABASE_URL="$DR_URL" DATABASE_SSL=1 JWT_SECRET='<vault>' npm run migrate
```

Notes that matter:

- It takes `pg_advisory_lock(421199002)` for the whole run and **blocks** rather
  than failing, so it is safe if a Render deploy is racing you — the loser waits
  and then finds nothing to do.
- Each file plus its `_migrations` insert is **one transaction**, so a partial
  failure rolls back and stays unrecorded. Re-run after fixing.
- **Never rename an applied migration file** — the ledger is keyed on filename,
  so a rename re-applies it.
- **Never backfill 063, 064 or 067.** They are retired; a stray dev database may
  still carry ledger rows for them.
- There is **no rollback**. `npm run migrate:rollback` deliberately just prints
  an error. Forward-only means the restore *is* the rollback.
- A migration that ran after the restore point and did a **data backfill** will
  re-run its backfill against restored data. Re-read that migration before
  assuming it is a no-op.

### B4 — Cut over

1. Verify with **all** of §4 — especially the §4.4 tie-out.
2. Repoint `DATABASE_URL` in Render → Environment (and rotate nothing else).
3. Redeploy. Watch `GET /v1/health` for `db:"ok"`.
4. If the API **hostname** changed, both SPAs need a **rebuild**, not an env
   change: `VITE_API_URL` is baked into the bundle at build time.
5. **Flush Redis (Upstash).** Safe — see §7 — and it clears any feature-cache
   entries that reference pre-restore plan state.
6. Re-run `scripts/rotate-super-admin.js` **only if** you need to reset the admin
   credential. The bootstrap path only ever INSERTs on a first boot with an empty
   table; on a restored DB it does nothing.

### B5 — The replay hazard nobody warns you about

⚠️ **After restoring to an earlier point, the cron worker will re-run jobs whose
side effects already happened.** Cron state is **in-process memory only** — there
is no cron-run table, and it resets on every deploy. So the restored database has
no memory of what already fired.

The `pg_try_advisory_lock(421199001)` guard prevents two *instances* colliding.
It does **not** prevent replaying already-completed work.

Highest-risk jobs, in order:

| Job | Replay consequence |
| --- | --- |
| `recurring-invoices` | **Double-charges a customer.** |
| `referral-award` | Pays a referral twice. |
| `refund-reconciler` | Re-issues a refund. |
| `scheduled-messages`, `wa-outbound`, `nps`, `digest-daily` | Duplicate customer messages. |

**Before the first post-restore cron tick**, either take the API down while you
reconcile, or check `invoices` / `refunds` / `email_dispatch_log` for rows dated
after your restore point and reconcile by hand. Budget 15 minutes for this — it
is the most expensive mistake available in this document.

---

## 7. What is NOT backed up today — be honest

| Thing | Backed up? | What to do about it |
| --- | --- | --- |
| **Postgres** | ✅ Neon history (window unconfirmed) + hourly local dump | Confirm the retention window. Get the dumps off the Mac (`FF_BACKUP_S3_BUCKET`). |
| **R2 `namastepos-uploads`** (menu photos, logos) | ❌ **No backup. No versioning. No lifecycle rule.** | Postgres stores only the **URL** (`menu_items.image_url`, `businesses.logo_url`) — a DB restore restores *dangling references*. Enable R2 versioning, or add these keys to a weekly `rclone`/`wrangler` sync. Restaurants notice missing food photos within a day. |
| **R2 `namastepos-downloads/NamastePOS.apk`** | ❌ **R2 is the only copy.** The local `build/` dir is the only other, and it is wiped by `flutter clean` | **Corrected 2026-09-04** — this row previously claimed a fallback copy of the APK lived "in-tree… (it already is)". It does not and cannot: `.gitignore:51` explicitly excludes `/NamastePOS.apk`, so no release APK has ever been committed. A DR plan that names a backup which does not exist is worse than one that admits the gap. Losing the R2 object 404s every download link on the landing page (both buttons hardcode that URL). Recovery is a **rebuild**: `flutter build apk --release` then `wrangler r2 object put` — ~25 min, and it needs `android/key.properties` plus the upload keystore, **neither of which is in the repo either**, so back those up separately or the rebuilt APK cannot update an installed app. To close the gap properly, attach each release APK to a GitHub Release (or drop the `.gitignore` line for tagged releases). |
| **Local `uploads/` on Render** | ❌ Ephemeral — wiped on every deploy/restart | Already effectively lost. `uploads.routes.js` writes to local disk *only when R2 is not configured*; **all five `R2_*` vars must be set** or uploads silently fall back to that ephemeral disk. Verify all five are present in Render. |
| **Redis (Upstash)** | ✅ Nothing to back up | **Genuinely safe to flush.** It carries only the feature-cache pub/sub invalidation channel (`featureService.js`); unset `REDIS_URL` degrades to a per-process cache. Idempotency keys — the classic "only in Redis" trap — correctly live in Postgres (`idempotency_keys`, migration 085). |
| **Application logs** | ❌ Console transport only (`src/config/logger.js`); `logs/` holds just a `.gitignore` | Render's stream (short retention) + Sentry are your only forensic trail. Set `SENTRY_DSN` — absent, it soft no-ops and the restore *looks* healthy while you are blind. |
| **Cron run history** | ❌ In-process memory, resets on deploy | See §B5. A cron-runs table is the fix; it is also what would make §B5 safe. |
| **Generated PDFs / Excel** | ✅ Nothing to back up | Streamed on demand (pdfkit/exceljs); nothing is written to disk. But `invoices.pdf_url` can point at externally-hosted files outside the dump. |
| **QR codes** | ✅ Nothing to back up | Derived from tokens in Postgres, not stored as PNGs. |
| **Secrets** | ❌ Render env + your password manager only | Losing the Render account loses `JWT_SECRET`, which is **also the 2FA KEK** — irrecoverable 2FA for every admin. Export the env surface to the vault today. |
| **Infra config** | ❌ No `render.yaml`, no Pages config in git | The dominant RTO term. See §8. |

---

## 8. The five things worth fixing before the next drill

Ordered by how much RTO/RPO they buy per hour of work.

1. **Confirm and write down the Neon retention window.** Ten minutes. Until this
   is known, your stated RPO is a guess.
2. **Commit infrastructure-as-code** — a `render.yaml` and the Pages build
   config. This converts a 45–90 minute manual re-entry into a redeploy, and it
   is the single largest RTO win available.
3. **Get backups off the founder's Mac.** Set `FF_BACKUP_S3_BUCKET` (+
   `FF_BACKUP_ENC_PASSPHRASE`). Today, if the Mac is the disaster, the backups
   are too.
4. **Teach `restore-db.sh` to read `.sql.gz.enc`** — otherwise step 3 creates
   backups you cannot restore with the tooling you have.
5. **Give R2 `namastepos-uploads` a backup or versioning.** It is the only
   customer-visible data with *zero* recovery path.

Also worth noting: `namastepos_backend/package.json`'s `migrate:rollback` message
points readers at **`BACKUPS.md`**, which does not exist at the repo root or in
the backend — the only copy is `docs/archive/BACKUPS.md`, and it is stale
(FoodFlow-era paths, and it claims encrypted backups are not implemented, which
`backup-db.sh` gained on 2026-08-31). Repoint that message at this file.

---

## 9. Drill log

Copy this block, fill it in, commit it. A drill you cannot prove you ran did not
happen.

```
DR DRILL LOG
════════════════════════════════════════════════════════════════════════
Date / time started (IST) : ____________________
Run by                    : ____________________
Deployed commit at drill   : ____________________  (git log -1 --oneline origin/main)

── Facts established ────────────────────────────────────────────────────
Neon history retention window     : ______ hours/days   (§1 — LOOK THIS UP)
Newest local dump available        : ____________________
Dumps encrypted? (y/n)             : ______
Dumps replicated off the Mac? (y/n): ______

── Restore ──────────────────────────────────────────────────────────────
Mechanism used            : [ ] Neon branch PITR   [ ] hourly pg_dump
Restore point targeted    : ____________________
Branch / target DB name   : ____________________
Time to first query       : ______ min

── Verification (§4) ────────────────────────────────────────────────────
§4.1  _migrations count / highest   : ______ / ____________________   [ ] pass
§4.1  health_db_ping() returns      : ____________________            [ ] pass
§4.2  orders / order_items counts   : ______ / ______                 [ ] pass
§4.2  newest_order timestamp        : ____________________            [ ] pass
§4.3  worst order_no gap            : ______                          [ ] pass
§4.4  MONEY TIE-OUT variance_paise  : ______   (MUST BE 0)            [ ] pass
§4.5  kot / inventory failures      : ______ / ______                 [ ] pass
§4.5  unprocessed webhook_events    : ______                          [ ] pass
§4.6  revenueIntegrityService       : ____________________            [ ] pass
§4.7  idor-audit (tenant isolation) : ____________________            [ ] pass

── Boot check (§3 step 4) ───────────────────────────────────────────────
/v1/health against restore : [ ] db:"ok"   [ ] degraded   [ ] did not boot
Migrations re-applied      : ______ files   (§B3)

── Outcome ──────────────────────────────────────────────────────────────
Total elapsed              : ______ min
Estimated real-world RTO   : ______ min      (be pessimistic)
Estimated real-world RPO   : ______ min
Branch deleted afterwards  : [ ] yes

── What broke or surprised me ───────────────────────────────────────────
1. ____________________________________________________________________
2. ____________________________________________________________________
3. ____________________________________________________________________

── Actions raised (with owner + date) ──────────────────────────────────
1. ____________________________________________________________________
2. ____________________________________________________________________
════════════════════════════════════════════════════════════════════════
```

### Drill history

| Date | Run by | Mechanism | Tie-out | Elapsed | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | *first drill not yet run* |
