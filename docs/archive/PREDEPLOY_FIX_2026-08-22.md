# Pre-deploy fix sweep — 22 Aug 2026 (evening session)

Full-project audit (4 parallel deep audits: backend, Flutter, web frontends, migrations/env) followed by targeted fixes. **41 issues found, 38 fixed.** All verification green:

- Backend: 17/17 suites, 72/72 unit tests passing; every `src/**/*.js` passes `node --check`; app boots clean.
- Migrations: all **54** applied on a real Postgres instance, **twice** (idempotency proven). New migration: `054_predeploy_schema_fixes.sql`.
- Dashboard + Admin: `tsc -b && vite build` both succeed.
- Flutter: no Dart SDK in this environment — all edited files passed a structural parse check, but **run `flutter analyze` + a real device test before shipping** (see "Needs your machine" below).

---

## P0 — would have failed in production (fixed)

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | `refundService.refundOrder` | `'succeeded'` isn't in the `refund_status` enum → **every owner refund 500'd** | removed; also wrapped whole flow in a transaction with `FOR UPDATE` (concurrent refunds could exceed order total) |
| 2 | `orderService.create` splits | `payments.order_id` column didn't exist → **any split-tender order rolled back entirely** (also hit guest checkout) | column added in migration 054 |
| 3 | `discountApprovalService` | `business_users.discount_pin_hash` never created → discount-approval PIN 500'd on first use | migration 054 |
| 4 | `forceCloseSessionService` | referenced `orders.cancelled_at`, `table_sessions.closed_by_type`, `revenue_leakage_events` — none existed; also never freed the table | migration 054 + service now closes session, frees table; walkouts now surface in the leakage report |
| 5 | `staffService.verifyPin` | brute-force lockout **never engaged** — the "probe" call wiped the failure counter before every attempt | probe removed; counter only touched after the real compare |
| 6 | Aggregator webhooks | one unmapped Zomato/Swiggy SKU → whole order dropped (validation required `menuItemId`; column was NOT NULL) | validation allows null for aggregator sources; `order_items.menu_item_id` made nullable (054); stock loop skips null items |
| 7 | Flutter `home_screen.dart` | `ApiService` used without import — **compile error** | import added |
| 8 | Flutter `api_service.listOrders` | sent `limit=1000`, backend Joi max is 500 → **every orders fetch 400'd** | default now 500 |
| 9 | `env.js` | prod boot silently used `JWT_SECRET='dev-only-please-change'` if unset | production now **fails at boot** without a real secret (verified) |
| 10 | Landing page | every CTA/login/pricing URL hardcoded to `localhost` | URLs now derived at runtime from the page hostname (`app.<apex>` / `api.<apex>` convention, overridable) — works after rename with zero edits |

## P1 — broken features / money (fixed)

- **Gift-card/wallet redemption never fired** — `_pendingRedeem` was lost in serialization; customer got food, card never debited. Fixed.
- **`orders.channel` didn't exist** — aggregator channel silently dropped AND the auto-WhatsApp order query errored (silently) for everyone. Column added (054) + inserted.
- **Aggregator link sessions stuck at `verified` forever** — pasting outlet-id in `upsertCredentials` now flips the session to `linked`; HMAC verify no longer throws on a null webhook secret (fails closed).
- **IST timezone sweep** — monthly report excluded 00:00–05:30 IST orders on the 1st; "today" cache check, daily-closing default day, leakage default range + voids filter, menu-engineering range, takeaway token rollover: all now IST.
- **`devLogin` now hard-disabled in production** regardless of `FF_DEV_LOGIN`.
- **Driver flow**: `assignOrder` now tenant-checks order+driver; `liveAssignments` joins scoped by business; delivered→collected now routes through the transitions matrix (loyalty earn + tax invoice fire).
- **Flutter Google sign-in** didn't hydrate plan/role/permissions → paid features looked locked until refresh. Fixed (email path too).
- **Split-tender UI**: validated against the wrong total when loyalty points redeemed; stale splits survived discount/points edits; <2 non-zero legs no longer saved as a "split".
- **Dashboard menu images** broke in prod (localhost fallback in `fullImageUrl`) — now same-origin in prod.

## P2 — polish (fixed)

Backend: dead-stock `?days=` NaN clamp; force-close audit used wrong request field; cron heavy jobs now run at 02:00 **IST** (was server-local) and one failing job can't starve the others; `TIER_STAFF_CAPS` comment corrected (staff cap **excludes** owner); migration 006 FK made idempotent; broken `npm run migrate:rollback`/`seed` scripts now fail loudly with correct instructions; missing env vars centralised in `env.js`; `.env.production.example` gained FCM/MSG91 keys; `db/seeds/plans_seed.sql` created (was referenced by docs but missing); DEPLOY_READY.md corrected (env list, migrations 001-054).
Flutter: mounted-guards after awaits (confirm order, customers, menu editor image upload); setup-wizard removed-row controllers disposed; reviews empty-state secondary CTA now shows real link-steps dialog (was a dead end); drawer "Reports & invoices" header uses the same gate as its tiles; driver-picker 403 shows a human message.
Web: `.env.example` added to dashboard + admin (incl. required `VITE_GOOGLE_CLIENT_ID`); real favicons (were 404ing `/vite.svg`); WhatsApp share button now actually opens WhatsApp (`wa.me`); grievance link fixed to `/legal/privacy`.

## Not fixed — needs your call (3)

1. **GST computed on undiscounted prices** — item-level GST ignores pre-tax discount/service charge, slightly overstating tax on discounted bills. Fixing changes receipt amounts you've already tested, so I left it. Say the word and it's a small change in `orderService`.
2. **`og:image` missing on landing** — WhatsApp shares have no preview image. Needs a real 1200×630 brand image; pointless before the rename.
3. **APK at `/downloads/foodflow-latest.apk`** — the link is correct but the file must be placed there by your release build/deploy step (only debug APKs exist in-repo).

## Verify on your machine (no Flutter/device here)

```
cd foodflow_flutter && flutter analyze && flutter build apk --debug
```
Then on a device: orders list loads (limit fix), split payment with loyalty points, Google sign-in shows correct plan, driver picker from drawer, captain bottom-nav (the §5 handover item — still needs real-device confirmation).
