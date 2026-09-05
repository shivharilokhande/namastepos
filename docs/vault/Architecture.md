---
tags: [namastepos, architecture]
---
# Architecture

**Product:** multi-tenant restaurant POS for India (Indian-POS UX, Android-first). Brand `namastepos.in`; folders still carry `namastepos_*` and legacy `foodflow_*` stubs.

| Piece | Folder | Stack | Live |
|---|---|---|---|
| API | `namastepos_backend/` | Node 20, Express, Postgres (Neon), Redis (Upstash, optional) | `api.namastepos.in` on Render, auto-deploys `main` |
| Tenant web dashboard | `namastepos_dashboard/` | React + Vite + TS | `app.namastepos.in` (Cloudflare Pages) |
| Super-admin console | `namastepos_admin/` | React + Vite + TS, cookie auth | `admin.namastepos.in` |
| Mobile app | `namastepos_flutter/` | Flutter 3.44.0 | APK on R2 `namastepos-downloads/NamastePOS.apk`; iOS side-loaded |
| Landing | `namastepos_landing/` | hand-built HTML, live pricing from `/v1/public/plans` | `namastepos.in` |
| Print agent | `namastepos_print_agent/` | local ESC/POS bridge | — |

## Request flow (business API)
`/v1/businesses/:businessId/*` → `src/app.js` mounts: rate limits → auth (`middleware/auth.js`) → **[[Feature Registry and Gating|featureGate]]** (402 `FEATURE_LOCKED`) → `noPlatformStaff` (platform staff denied tenant data) → per-router `requireStaffPerm` → controller (Joi `validate`) → service → Postgres. Audit rows commit **before** the response (`auditDurability`).

Tenancy: every lookup is `WHERE business_id = $1`. Ids from the client (`tableId`, `tableSessionId`, `userId`…) are re-checked against the tenant — see [[Code Review 2026-09-05]] #4/#5 for what happened when they were not.

## Key backend files
- `src/config/featureRegistry.js` — THE feature list · `src/config/planTiers.js` — tier codes ([[Tier Code Trap]])
- `src/middleware/featureGate.js` · `requireFeature.js` · `requireAddon.js`
- `src/services/featureService.js` (entitlement cache, `X-Plan-Version`) · `subscriptionService.js` · `churnService.js` · `addonService.js` · `razorpayService.js`
- `src/services/orderService.js` (order txn, GST, stock, loyalty) · `taxInvoiceService.js` · `gstService2.js`
- `db/migrations/NNN_*.sql` forward-only, idempotent, auto-run by Render start command (`npm run migrate && npm start`) — **never add a boot-time run**

## Clients learn entitlements from `/auth/me`
`plan.features[]`, `plan.tierKind`, `permissions[]`, `role`, `business.gstScheme`. Both clients fail **closed** until loaded, re-fetch on login/resume/purchase, and re-fetch when the `X-Plan-Version` response header changes (seconds on an active till; 5-min poll backstop).
