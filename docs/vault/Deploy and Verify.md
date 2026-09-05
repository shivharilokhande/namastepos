---
tags: [namastepos, ops]
---
# Deploy and Verify

- Push to `main` → Render builds and runs `npm run migrate && npm start`. Migrations are forward-only, idempotent, auto-applied. Rollback = DB restore, not a down-migration.
- **Verify a deploy with one command:** `curl -s https://api.namastepos.in/v1/health | jq -r .commit` (also `db`, `uptimeSeconds`). `/health` and `/v1/health` differ; a Cloudflare Worker pings `/v1/health` every 5 min to beat Render's free-tier cold start.
- Dashboard/admin/landing deploy via Cloudflare Pages on push.
- **Android release:** bump `namastepos_flutter/pubspec.yaml` version (`1.0.22+23` as of 2026-09-06), `flutter build apk --release`, then `npx wrangler r2 object put namastepos-downloads/NamastePOS.apk --file build/app/outputs/flutter-apk/app-release.apk --content-type application/vnd.android.package-archive`. Verify with `wrangler r2 object get` + `shasum` — the public `r2.dev` URL is edge-cached and may serve the old bytes for a while. Signing needs `android/key.properties` + keystore (not in repo — back them up).
- iOS: the founder installs on his iPhone himself.
- Env on Render worth remembering: `ORDER_TAX_ENFORCE` (`log` today → `enforce` later), `TRIAL_DAYS=7`, `REDIS_URL`, `R2_*` ×5 (else uploads fall to ephemeral disk), `DB_SSL_VERIFY`/`PG_CA_CERT` (unverified TLS if unset), Sentry DSN.
