# NamastePOS — Session Handover

_Last updated: 2026-09-01 · paste or point a new chat at this file to resume._

## What this is
**NamastePOS** — a **live, multi-tenant Indian restaurant POS SaaS** (namastepos.in), built and run solo by Shivhari. Internal codename/repo folder is still "PetPooja Clone"; product name is NamastePOS (rebranded from FoodFlow on 2026-08-24).

Deep context lives in the Obsidian vault at `/Users/shiv/SecondBrain` → start at `index.md`, then `Projects/NamastePOS.md` and the 5 `Knowledge/NamastePOS - *` notes.

## Repo & components
Local repo: `/Users/shiv/AI Development/Java Projects/PetPooja Clone` (git; push to `main` auto-deploys web).

| Folder | Component | Stack |
|---|---|---|
| `namastepos_backend` | API | Node/Express, PostgreSQL (raw SQL, no ORM) |
| `namastepos_dashboard` | Tenant dashboard | React + Vite + TS |
| `namastepos_admin` | Super-admin console | React + Vite + TS |
| `namastepos_flutter` | Mobile app (`in.namastepos.app`) | Flutter/Dart |
| `namastepos_landing` | Marketing + `/blog` | Static HTML/CSS |

Live: `namastepos.in` (landing), `app.` (dashboard), `admin.` (admin), `api.` (backend, routes `/v1/...`). APK on Cloudflare R2 `namastepos-downloads/NamastePOS.apk`.

## Current state (2026-09-01)
- Full stack live and auto-deploying. Backend tests green (267/41 suites).
- Latest commit `b68dbcd` on `main`.
- Mobile app **v1.0.12 (build 13)** — installed on iPhone 17 (`00008150-00123C5026F8401C`) and published as APK on the site.
- **Just shipped:** loyalty **points redemption at table settle** (web `TablesPage` + mobile `captain_screen`) and a **tender/collections breakdown** — cash-in-drawer vs wallet (prepaid) vs points (discount) — on the web dashboard Payments card and the mobile home "Collections today" card. Backend `reportService.dailyReport` returns `tenders`/`tendersTotal`/`walletCollected`/`cashCollectedToday`/`discountBreakdown`.

## Open items / next steps
- **Meta WhatsApp** (biggest open thread): app/WABA/number built; number was `Pending` after adding a payment method. Remaining: submit OTP Authentication template, configure webhook once number is `Connected`, set the 6 env vars on Render + redeploy. **Rotate** the App Secret + permanent token (were exposed in plaintext during setup).
- Directory backlink submissions (SEO) — in progress.
- Render env to set: `DB_SSL_VERIFY=true`, `FF_BACKUP_ENC_PASSPHRASE`, Firebase key restriction, `VITE_DASHBOARD_URL` on admin (impersonation).
- Reticle: instrument + verify admin live (dashboard done).

## Key rules (don't relearn the hard way)
- **Be concise.** Report outcomes, not steps.
- **Verify against live code/schema/deploy** before declaring a bug or "done" — do NOT trust mock/backend tests alone.
- **No DB drops** (migrations additive only); **no hardcoded secrets** (env, fail loudly).
- Money → paise; `orders.total` is **net of points**; revenue = SUM(orders.total); wallet is deferred revenue (recognised on spend, no double-count).
- **Tenant-scope every id lookup.**
- **Never name competitors** publicly — use "legacy POS" framing.
- Founder does all password/2FA/card/secret entry himself; agent never types those or solves CAPTCHAs.

## Build / deploy cheatsheet
- Web: `git push origin main` (Render + Cloudflare Pages auto-deploy).
- Backend tests: `NODE_ENV=test npx jest --runInBand --forceExit` (in `namastepos_backend`).
- APK: `flutter build apk --release` → `npx wrangler r2 object put namastepos-downloads/NamastePOS.apk --file build/app/outputs/flutter-apk/app-release.apk --content-type application/vnd.android.package-archive --remote`.
- iOS on-device: `flutter build ios --release` **first**, then `flutter install --device-id 00008150-00123C5026F8401C`; verify with `xcrun devicectl device info apps --device <id> | grep in.namastepos`. Retry on transient NWError 54.
- Bump `namastepos_flutter/pubspec.yaml` `version:` before each mobile release.
- Don't test the API from a browser tab on the `api.` origin (CORS rejects it → false 500); use the `app.`/`admin.` origin.

## Secrets
Not in this file or the vault. They live in Render env / the founder's password manager. WhatsApp App Secret + permanent token need rotation (see above).
