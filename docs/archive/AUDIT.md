# FoodFlow — Comprehensive Audit & Test Build-out

Owner: Shiv · Started: 2026-05-25 · Status: **Phase 1 in progress**

This is the master tracking document for the complete-coverage testing + security & code-quality pass across all four FoodFlow codebases. Every finding lands here with severity, code ref, and status. Fix-as-I-find policy — security issues at P0/P1 are diffed in the same session they're discovered.

## Phase plan

| # | Phase | Status | Notes |
|---|---|---|---|
| 1 | Backend security audit + fixes | 🟡 In progress | SQLi, auth bypass, RBAC, secrets, validation, CSRF/CORS, IDOR |
| 2 | Backend integration tests (Jest+Supertest) | ⬜ Pending | All 23 route files × auth/RBAC/happy/error matrix |
| 3 | Admin Playwright gap fill (11 more pages) | ⬜ Pending | Currently 5/16 covered |
| 4 | Dashboard Playwright gap fill (~35 flows) | ⬜ Pending | Currently 9/43 covered |
| 5 | Flutter widget + integration tests | ⬜ Pending | Currently 1 stub for 46 screens |
| 6 | Code quality (lint/types/perf/DB) | ⬜ Pending | ESLint, TS strict, flutter analyze, dep audit |

## Coverage snapshot (start of Phase 1)

| Surface | Files | Currently tested | % |
|---|---:|---:|---:|
| Super-admin pages | 16 | 5 | 31% |
| Owner dashboard pages | 43 | 9 | 21% |
| Backend route files | 23 | 0 direct | 0% |
| Flutter screens | 46 | 0 real | 0% |

## Severity scale

- **P0 — Critical**: auth bypass, SQLi, secret leak, RCE, data exfiltration. Fix on sight, do not defer.
- **P1 — High**: privilege escalation, IDOR, missing input validation on write paths, broken access control, vulnerable dep with known exploit.
- **P2 — Medium**: information disclosure, weak crypto, CSRF on non-critical endpoints, unsafe redirects, missing rate limits on sensitive endpoints.
- **P3 — Low**: code quality, missing indexes, ESLint warnings, tech debt, missing comments on tricky code.

---

## Phase 1 — Security findings (open)

| ID | Severity | File:line | Title | Status |
|----|---|---|---|---|
| _(none open — all P0/P1 found so far have been fixed)_ | | | | |

## Phase 1 — Security findings (fixed this session)

| ID | Severity | File | Title | Fix |
|----|---|---|---|---|
| AUDIT-S001 | P0 | foodflow_backend/src/routes/uploads.routes.js | Upload endpoint had no auth — anyone could POST files to any business folder | Added `router.use(requireAuth, requireBusinessOwnership)` |
| AUDIT-S002 | P0 | foodflow_backend/src/routes/uploads.routes.js | `:businessId` taken verbatim into `path.join` — `..` segments would escape UPLOAD_ROOT (classic path traversal) | UUID regex validation + `path.resolve` containment check |
| AUDIT-S003 | P2 | foodflow_backend/src/routes/uploads.routes.js | Filename extension derived from client-supplied `originalname` (`evil.exe.jpg` etc.) | Map MIME → canonical extension, ignore client filename |
| AUDIT-S004 | P0 | foodflow_backend/src/routes/whatsappWebhook.routes.js | Webhook had NO signature verification — anyone could inject fake inbound WhatsApp messages, triggering loyalty/status events and polluting DB | Added Twilio HMAC-SHA1 signature verification with constant-time compare; rejects on bad signature in prod, warns loudly in dev |
| AUDIT-S005 | P2 | foodflow_backend/src/routes/whatsappWebhook.routes.js | `:businessId` not validated before DB writes | UUID regex check, returns benign 400 with TwiML `<Response/>` shell |

## Verified-safe spot checks

- `query(\`...${var}...\`)` patterns audited — all `${where.join(' AND ')}` uses populate `where` from hardcoded SQL fragments with $N placeholders, never user values. Safe.
- `orderBy` in `customerService.js:50` — whitelisted to 3 hardcoded strings, no user-controlled ORDER BY. Safe.
- Aggregator webhooks — signature verified via `aggregator.verifySignature(provider, secret, rawBody, sig)`. Raw body captured by `express.json({ verify })`. Safe.
- No `eval` / `new Function` / `child_process` / `exec` / `spawn` calls anywhere in `foodflow_backend/src`. Safe.
- `publicSite.routes.js` — read-only, parameterized queries only. Safe.
- `helmet`, `cors`, body-size limits (`1mb`), and global `rateLimit` are all on the app. Safe defaults.

## Pending checks (P1 sweep)

- [ ] JWT secret strength + rotation policy
- [ ] CORS allowlist vs `*`
- [ ] Session cookie flags (HttpOnly / Secure / SameSite)
- [ ] Bcrypt cost factor on password / PIN hashes
- [ ] IDOR — verify every `:businessId` / `:resourceId` route checks ownership beyond the router-level `requireBusinessOwnership`
- [ ] Mass-assignment in patch endpoints (writable column allowlist)
- [ ] Refresh-token rotation + revocation
- [ ] `req.user.role` trust boundary (does the middleware re-fetch role on every request or trust JWT claims?)
- [ ] Sub-routes mounted via `sprintsAll`, `sprint1Extras`, `finalSprint`, `multiOutlet` — auth applied per-route?
- [ ] `requireAddon` middleware — does failure of the addon check leak data or just deny?
- [ ] Webhook idempotency (replay-attack resistance)
- [ ] Razorpay payment-webhook signature verification
- [ ] File-upload MIME sniffing (multer trusts client `mimetype` — should it sniff?)

---

## Running test counts

- Admin Playwright: **18 existing + 27 new (this batch)** = ~45 admin tests
- Dashboard Playwright: **23 existing + 25 new (this batch)** = ~48 dashboard tests
- Backend integration tests: **25 existing + 22 new (this batch)** = ~47 integration tests
- Backend unit tests: **42 existing**
- Flutter widget tests: **0** (Phase 5)
- Flutter integration tests: **0** (Phase 5)

**Running total: ~180 tests. Goal: 800–2000+, full coverage.**

## Batch log

### Batch 4 (2026-05-25, login-limiter fix)

After E2E runs hammered the rate limiters (20/min admin, 30/min owner), every retry tripped 429 → login form stayed on /login.

- `foodflow_backend/src/routes/admin.routes.js` — `loginLimiter` is now a no-op when `!env.isProd()` (still enforced in production)
- `foodflow_backend/src/routes/auth.routes.js` — same treatment for owner login limiter

Prod safety untouched. Tests can now retry freely.

### Batch 3 (2026-05-25, density push)

22 new files, ~120 new tests, covering:

**Admin Playwright** (6 files):
- `18-admin-metrics.spec.ts`, `19-admin-refunds.spec.ts`, `30-admin-gst.spec.ts`, `31-admin-settings.spec.ts`, `32-admin-webhooks.spec.ts`, `33-admin-team.spec.ts`

**Dashboard Playwright** (9 files):
- `23-kds.spec.ts`, `24-kot.spec.ts`, `25-captain.spec.ts`, `26-reservations.spec.ts`, `27-expenses.spec.ts`, `28-ingredients.spec.ts`, `29-aggregators.spec.ts`, `34-marketplace.spec.ts`, `35-accounting.spec.ts` (covers 10 smaller pages)

**Backend Jest** (6 files):
- `staff.test.js`, `billing.test.js`, `customers.test.js`, `tax-invoices.test.js`, `ops.test.js`, `admin-customers.test.js`

These are smoke + structure assertions. Many will fail on first run because I haven't verified selectors against the running UI. That's expected — failures inform the next batch.

Plus updated `playwright.config.ts` to use prefix-based project matching (any `NN-admin-*.spec.ts` → admin, anything else `NN-*.spec.ts` → dashboard). Allows arbitrary numbering for future specs.

### Batch 2 (2026-05-25, fixes pass)

Triage after first big run:

- **Backend** `src/app.js` — Skip global rate limiter when `NODE_ENV=test` (fixes 4 auth.test 401 false-positives)
- **Backend** `tests/setup.js` — `makeBusiness()` now also creates the owner user + `business_users` membership row + tries `owner_user_id` on the business. Fixes 14 cascading 403s in menu/orders/expenses tests.
- **Backend** `package.json` jest config — `maxWorkers: 1` to prevent DB-reset races between suites.
- **Backend** `tests/integration/whatsapp-webhook.test.js` — `withProd()` spy helper instead of `process.env.NODE_ENV` mutation (env is frozen at module load).
- **Playwright** `_helpers.ts` — Email `.test` TLD → `.com` (Joi rejects `.test`); switched to dedicated `playwright-owner@foodflow-test.com` provisioned via `/auth/register` in setup.

### Batch 1 (2026-05-25)
- Backend `tests/integration/uploads.test.js` — 12 tests for AUDIT-S001/S002/S003 P0 fixes (auth, path traversal, MIME normalization)
- Backend `tests/integration/whatsapp-webhook.test.js` — 10 tests for AUDIT-S004/S005 (Twilio signature, UUID validation, TwiML response shape)
- Admin Playwright `15-admin-addons.spec.ts` — 10 tests (list, create dialog, search, row click, runtime errors)
- Admin Playwright `16-admin-coupons.spec.ts` — 9 tests (CRUD, plan dropdown from /plans, runtime errors)
- Admin Playwright `17-admin-plans.spec.ts` — 9 tests (CRUD, tier_kind selector, feature picker, limit inputs, /plans API contract)
- Dashboard Playwright `20-tables.spec.ts` — 9 tests (Add Table dialog, plan-gated tables, QR link, runtime errors)
- Dashboard Playwright `21-settings.spec.ts` — 8 tests (business name, feature-gated toggles, GST field, save button)
- Dashboard Playwright `22-customers.spec.ts` — 8 tests (CRM list, search, add dialog, row click, tier badges)

**Batch 1 total: 75 new tests.**
