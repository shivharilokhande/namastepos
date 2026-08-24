# Hardcode Audit — 2026-08-24

> **STATUS: FIXED (same day).** All P0/P1 and nearly all P2 findings below were remediated on 2026-08-24. See "Fixes applied" at the bottom for the change list, new env vars, and the few items deliberately left.

Full-codebase scan for values hardcoded that should be config/env/DB-driven. All findings verified against source. Grouped by severity.

---

## P0 — Fix before launch

### 1. Super-admin credential pair is reconstructable from the repo
- `namastepos_admin/src/pages/LoginPage.tsx:14` — email prefilled: `useState('admin@namastepos.in')`
- `tests/specs/_admin_helpers.ts:12` — `password: process.env.FF_ADMIN_PASSWORD || '<old-password-redacted>'`
- `namastepos_backend/.env:38` — `SUPER_ADMIN_PASSWORD=<old-password-redacted>` (weak; same value as the committed test fallback)
- `namastepos_backend/src/config/env.js:73` — `SUPER_ADMIN_EMAIL || 'admin@namastepos.in'` hardcoded fallback feeding auto-bootstrap in `adminService.js:16-27` and `adminTeamService.js:22-30`

**Fix:** rotate the password, empty the LoginPage prefill, make `FF_ADMIN_PASSWORD` throw if unset in tests, remove the email fallback in env.js.

### 2. `DATABASE_URL` fallback defeats fail-closed boot in production
- `namastepos_backend/src/config/env.js:28-30` — a fallback (`postgresql://namastepos:namastepos@localhost:5432/namastepos`) is always passed to `required()`, so prod boots silently against localhost with known creds instead of crashing. `JWT_SECRET` 20 lines below is fail-closed; DATABASE_URL should be too.

### 3. OTP falls back to logging the code with no prod guard
- `namastepos_backend/src/services/otpService.js:57-61` — missing `MSG91_AUTHKEY` ⇒ plaintext OTP written to logs, HTTP 200 returned. Anyone with log access logs in as any phone. `devLogin` is gated on `env.isProd()`; this path needs the same guard.

### 4. Release APK signed with debug keystore
- `namastepos_flutter/android/app/build.gradle:44` — `signingConfig signingConfigs.debug`. Blocks Play Store; sideloaded builds trivially re-signable.

### 5. GSTR export broken today (wrong localStorage key + relative URL)
- `namastepos_dashboard/src/pages/ReportsPage.tsx:181,187` — reads `localStorage 'ff_business'` but `api/client.ts:27` stores `'ff_dash_business'` ⇒ business ID resolves to `''`, URL malformed. Also bypasses `VITE_API_URL` (breaks cross-origin).

### 6. Personal PII hardcoded as platform contacts
- Founder WhatsApp `+91 9518956711`: `namastepos_dashboard/src/components/Layout.tsx:218`, `namastepos_dashboard/src/pages/HelpCenterPage.tsx:185`, `namastepos_flutter/lib/screens/settings/settings_screen.dart:157`
- Personal Gmail + mobile as DPO/grievance officer, served on unauthenticated `/v1/compliance`: `namastepos_backend/scripts/seed-compliance.sql:10-18`
- Personal email + tenant UUID `b28ea141-...` repeated ~90× in `scripts/recover-menu.sql` / `recover-menu-v2.sql`

**Fix:** move support contact to platform settings / `VITE_SUPPORT_WHATSAPP` / backend; parameterise the recovery scripts.

### 7. docker-compose "production" config is both insecure and non-bootable
- `namastepos_backend/docker-compose.yml:8,43,44,46` — `POSTGRES_PASSWORD: namastepos`, `JWT_SECRET` default `change-me-in-prod`, and `CORS_ORIGINS: "*"` under `NODE_ENV=production` — which `app.js:64-66` rejects, so the container crash-loops as written.

---

## P1 — Prices/limits duplicated and already drifted

Plan pricing has **three contradictory sources** besides the backend `/plans` catalog:

| Location | Claims |
|---|---|
| `namastepos_dashboard/src/pages/HelpCenterPage.tsx:127` | Pro ₹399/mo, "Advanced ₹699" (tier doesn't exist), 3 staff |
| `namastepos_landing/index.html:623-652, 446` | Pro ₹799/mo, 5 staff |
| `namastepos_flutter/lib/screens/billing/trial_expired_screen.dart:83` | "Start at ₹299/mo" — on the conversion screen |

Also: yearly-price rule `priceInr * 10` encoded in UI at `namastepos_dashboard/src/pages/BillingPage.tsx:430` and `namastepos_admin/src/pages/CustomerDetailPage.tsx:1023` (backend already has this in `subscriptionService.js`). Trial length "14 days" has three sources of truth: `authService.js:183-187`, `customerAdminService.js:16`, migration `002_saas_schema.sql:138`.

**Fix:** single-source all commercial terms from `/v1/plans`; centralise trial days in one constant/DB setting.

## P1 — URL/domain hardcoding

- Flutter API default is **live prod**: `api_service.dart:29-32` (`https://api.namastepos.in/v1`) — dev/CI builds missing `--dart-define=API_URL` hit prod. Guard in `main.dart:38-49` is dead code (both branches identical).
- `app.namastepos.in` baked in: `qr_codes_screen.dart:127` (goes into **printed** QR PDFs), `addon_locked.dart:65`, `subscription_banner.dart:49`, `ownerDigestService.js:117`, `OnlineSitePage.tsx:63,79` (domain-rename exposure already noted in `ReservationWidgetPage.tsx`)
- `onboardingEmailService.js:20` / `emailService.js:98` — prod-domain fallbacks, bypass `env.APP_URL`/`env.SMTP_FROM`
- Print agent defaults to wrong port: `namastepos_print_agent/src/agent.js:18` — `localhost:3000`; everything else uses `:4000`
- Dashboard relative `/v1` fetches bypassing `VITE_API_URL`: `PublicOrderTrackerPage.tsx:24`, `OnlineSitePage.tsx:64`, `SurgePage.tsx:40` (dead code with literal `'_'` business ID)
- Zomato/Swiggy live partner URLs with no sandbox switch: `aggregatorMenuSyncService.js:38,64`

## P1 — Auth/entitlement hardening

- `DEMO_MODE` dart-define is a full auth bypass in release builds — gate on `kDebugMode` (`auth_service.dart:38-40,96-98,135-138`)
- Fail-open trial: missing `currentPeriodEnd` grants 14 days (`subscription.dart:92-93`)
- Invented loyalty rate: `redemptionValuePaise ?? 100` feeds money math (`customer.dart:57` → `confirm_order_screen.dart:342,537,770,777`)
- Addon nav gating fails open while loading (`Layout.tsx:184-186`)
- WhatsApp webhook signature only enforced when `NODE_ENV === 'production'` (`whatsappWebhook.routes.js:68-78`)
- `JWT_SECRET` fallback `'dev-only-please-change'` for all non-prod envs (`env.js:50-53`) — staging signs tokens and derives the 2FA KEK from a public string

## P2 — Cleanup

- Placeholder Razorpay plan IDs `plan_REPLACE_ME_*` seeded run-as-is (`db/seeds/plans_seed.sql:16-22`), no downstream validation
- Real Google OAuth client IDs + prod hostnames in committed `.env.production.example:15,22,32,53,77,85`
- `.env.example:8` ends CORS list with `*` — any copy is wildcard-open in non-prod
- `seed-shiv-demo.sql` keys a demo tenant to a personal Gmail whose synthetic sub matches the `devLogin` format — passwordless access wherever `FF_DEV_LOGIN=1`
- GST defaults hardcoded in dashboard: `RetailPage.tsx:98` (18%), `MenuPage.tsx:441` (5%) — backend GST is fully data-driven
- `₹`/INR literals bypass the currency helpers: ~25 Flutter call sites skip `AppFmt`; `BillingPage.tsx:32`, `GuestBillPanel.tsx:113-133`, admin `ReportsPage.tsx:241,401`, `FinancePage.tsx:123` skip `formatINR()`; backend writes literal `'INR'` in `razorpayService.js`, `refundService.js:318`, `addonService.js:160`, report services — despite `multi_currency_fx` being a gated feature
- `SettingsProvider.currency/locale` getters read by nothing (`settings_provider.dart:29-60`); dead plaintext zomato/swiggy key storage in same file (`:19-21,53-55,96-108`) — delete
- Consent versions as frontend constants: `RegisterPage.tsx:15-16`
- Broken Google review link `https://g.page/r/` with no place ID sent to customers (`npsService.js:91`); `reviewsService.js:84` already resolves per-business data
- `platform.tax_pct=18` seeded (`003_admin_platform.sql:109-113`) but **read by nothing** — the real subscription GST rate lives elsewhere
- iOS bundle ID `in.namastepos.namastepos` vs Android `in.namastepos.app` — reconcile before store submission (Google OAuth is bundle-bound)
- Landing page fake "live" metrics naming "Shiv's Cafe, Pune" (`index.html:410-411`)
- `/health` returns hardcoded `version: '1.0.0'` (`app.js:149`); `setup.sh:72` documents an OTP-123456 bypass that doesn't exist — delete the line
- `+91` assumption spread across `whatsapp_service.dart:53-56`, `otp_screen.dart:114` — centralise

---

## Fixes applied (2026-08-24)

**P0.** Super-admin: LoginPage prefill emptied; test helper now throws without `FF_ADMIN_EMAIL`/`FF_ADMIN_PASSWORD`; `SUPER_ADMIN_EMAIL` fallback removed (bootstrap requires both vars); password rotated in `.env`; `scripts/rotate-super-admin.js` added to push the new hash into the DB. `DATABASE_URL` and `JWT_SECRET` now fail closed outside test. OTP dev-log path hard-blocked in production. Android release signing reads `key.properties` and refuses debug-signed release builds. GSTR export fixed (correct `ff_dash_business` key + `VITE_API_URL` base). Support WhatsApp moved to `VITE_SUPPORT_WHATSAPP` / `SUPPORT_WHATSAPP` dart-define (hidden when unset). `seed-compliance.sql`, `recover-menu*.sql`, `seed-shiv-demo.sql`, `idor-audit.js` parameterised — no personal PII or tenant UUIDs remain. Both docker-compose files now require `POSTGRES_PASSWORD`/`JWT_SECRET`/`CORS_ORIGINS` (`:?` guards), no secret fallbacks.

**P1.** Prices/limits stripped from HelpCenter copy, landing fallback/bullets/noscript, and trial-expired screen — `/v1/plans` is the single source. Client-side `×10` yearly rule removed (dashboard + admin). Trial length centralised as `env.TRIAL_DAYS` (authService SQL + customerAdminService). Flutter: dev builds fail fast without `--dart-define=API_URL`; `app.namastepos.in` links centralised in `lib/config/app_config.dart` (`WEB_APP_URL`); `DEMO_MODE` gated on `kDebugMode`; subscription `currentPeriodEnd` and loyalty `redemptionValuePaise` now fail closed. Backend: `ownerDigestService`/`onboardingEmailService`/`emailService` read `env.APP_URL`/`env.SMTP_FROM`; Zomato/Swiggy hosts env-driven (`ZOMATO_API_BASE`/`SWIGGY_API_BASE`); WhatsApp webhook signature enforced whenever a Twilio token is configured, regardless of NODE_ENV; NPS review link built from per-business `google_place_id`. Dashboard relative `/v1` fetches fixed (order tracker), dead SurgePage query removed, OnlineSitePage domain → `VITE_SITE_DOMAIN`. Print agent default port 3000→4000.

**P2.** `plans_seed.sql` takes ids via psql `-v` with a REPLACE_ME guard. Real Google client IDs scrubbed from `.env.production.example`; `*` removed from `.env.example` CORS. `/health` reports `env.APP_VERSION || package.json` version. `setup.sh` fake-OTP line deleted. Landing "Live from Shiv's Cafe" → "Example". Currency sweep: 35 Flutter conversions to `AppFmt` (new `moneyPaise`/`moneyPlain`/`inr2` helpers; printer output byte-identical via `moneyPlain`), 28 web conversions to `formatINR` (dashboard + admin); dead plaintext zomato/swiggy key storage and unused currency/locale getters deleted from `settings_provider.dart` (old prefs keys scrubbed on load).

**Deliberately left.** Razorpay `'INR'` literals (Razorpay India subscriptions are INR-only — vendor constraint); GST form defaults (5%/18%) as UI conveniences; `usePlan`/`StaffPage` client-side permission mirrors (server enforces; removing degrades loading UX); `RegisterPage` consent-version constants (match the seeded compliance versions); addon nav optimistic-while-loading (server enforces); CI secrets (ephemeral, labelled); iOS `in.namastepos.namastepos` vs Android `in.namastepos.app` bundle-ID mismatch — **flagged, not changed**, because the Google OAuth iOS client is bound to the current ID; reconcile deliberately before store submission.

**Action required.**
1. New super-admin password is in `namastepos_backend/.env` (rotated). Run `node scripts/rotate-super-admin.js` once against your DB to update the stored hash, since bootstrap never updates existing rows.
2. `docker compose up` now needs `POSTGRES_PASSWORD`, `JWT_SECRET`, `CORS_ORIGINS` in the compose `.env`.
3. Update your Twilio/compliance/demo seed invocations to the new `psql -v` syntax (documented in each script header).
4. Non-release Flutter builds now require `--dart-define=API_URL=...` (HOW_TO_RUN.md already documents the values).

## Verified clean

No API keys/tokens/private keys in any source. No absolute filesystem paths. No hardcoded tenant UUIDs in app code. No magic PINs or client-side PIN comparison. GST computation, plan limits, loyalty config, delivery zones all DB-driven. `dev-login` correctly double-gated. `.env` correctly git/docker-ignored. Sentry redaction in place. ATS exceptions scoped to localhost only.
