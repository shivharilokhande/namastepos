# FoodFlow → Handover doc

**Date:** 22 Aug 2026 · **Founder:** Shivhari Lokhande (with Aakanksha)
**Purpose:** Everything a fresh Claude session needs to pick up this project without repeating the last one's mistakes.

---

## 1. What this project is

Multi-tenant restaurant POS SaaS targeting Indian cafés/restaurants. Three frontends:

- **`foodflow_backend/`** — Node.js + Express + Postgres 15, ~150 endpoints, 17 unit-test suites (72 tests, all passing)
- **`foodflow_dashboard/`** — Owner React/Vite (port 5173) — restaurant control panel
- **`foodflow_admin/`** — Super-admin React/Vite panel
- **`foodflow_flutter/`** — Flutter Android app (owner + captain + kitchen + driver views)
- **`foodflow_landing/`** — Static HTML landing page with APK download CTA

Solo founder, budget-conscious, launching Android beta via APK direct-download in ~2 days, then Play Store submission. iOS is deferred.

---

## 2. Product name — **STILL UNDECIDED**

The name **FoodFlow** is **taken** by an existing Indian POS company at [foodflow.in](https://foodflow.in/) (Guwahati-based). Cannot ship under FoodFlow.

**Company registration name:** `Lokhande Ventures Private Limited` (decided). Holding-company pattern, product name goes as a brand under it.

**Product-name candidates explored** (all rejected by founder as either taken, "too local," or "AI-generic"):
- FoodFlow (taken)
- Adda, Chaska, Tapri, Nukkad (rejected as too local)
- QORE, ORDO, SIVORA, AASHIV, AKSH (proposed but not confirmed)

**Latest state:** Founder mentioned "combo with our names + cafe/restaurant." SIVORA (Shiv + Ora) was my top pick for that direction. **Not yet locked.** Next chat should either accept a candidate and do a full rename, or spend one more turn helping the founder pick a name and *stop* — don't keep spinning on this.

**Rename workflow when locked** (do in one commit):
- Find/replace `FoodFlow` → `<Name>` across all .md, .dart, .html, .json, .yaml files
- Android package `in.foodflow.app` → `in.<name>.app` in `foodflow_flutter/android/app/build.gradle` and `AndroidManifest.xml`
- Landing page title, meta tags, OG tags
- README, DEPLOYMENT.md, DEPLOY_READY.md, CTO_VIKRAM_72H.md
- KOT print header, receipt template
- Backend `service_config` seed if any hard-coded brand string

---

## 3. What's *known to be working*

- Backend: 17 unit suites, 72 tests passing (`cd foodflow_backend && npx jest --testPathIgnorePatterns=integration --forceExit`)
- Integration tests need Postgres — deferred to real infra
- Order lifecycle (POS create → KOT → status transitions matrix → collected/cancelled)
- Refund lifecycle: cash-book instant, gateway pending → reconciler cron drains every 5 min
- Multi-tenancy: middleware `requireBusinessOwnership` + cross-tenant guards on billSplit, discount, FX
- PIN-based staff auth with brute-force lockout
- Aggregator webhooks with signature verify + outcome recording
- Sentry wired all 4 surfaces
- KOT ticket generation with advisory-lock (no duplicate ticket_no under concurrency)
- Order transition state machine with unit test
- Landing page with APK download + WhatsApp share button

---

## 4. What was done in *this session* (Aug 22)

### 4a. P0/P1/P2 bug sweep — 17 fixes shipped
Full log in `CTO_VIKRAM_72H.md` + `DAY1_STATUS.md`. Highlights:

**P0 fixes (backend):**
- `orderService.js` — `const tax` → `let tax` (was crashing on order create)
- `revenueLeakageService.js` — removed invalid `payment_method='comp'` filter
- IST timezone applied across 4 report services (dailyClosing, incomeStatement, report, revenueLeakage)
- `billSplitService.paySplit` — cross-tenant IDOR fix
- `discountApprovalService` — per-tenant threshold key
- `finalSprint.routes` — FX write restricted to superadmin (403)
- `aggregatorService.processIncomingOrder` — placeholder UUID → null + unmapped-batch recording
- `staffService.verifyPin` — brute-force lockout (5 tries / 15 min)

**P0 fixes (mobile):**
- POS confirm screen spinner-lock (try/catch/finally wrap)
- FCM client wire-up (soft, activates when Firebase project provisioned)
- Mobile split-tender UI in POS

**P1 fixes:**
- `refundService.refundOrder` prior-refund cap + cash-book auto-processed status
- `orderService.ORDER_TRANSITIONS` matrix + enforcement (with new unit test)
- `driverService.markStatus('delivered')` → auto-flip parent order to `collected`
- `aggregatorWebhooks.routes` — `recordWebhookOutcome` now firing (FF-245 badges work)
- `kotService.nextTicketNo` — `pg_advisory_xact_lock` for concurrency safety
- `setup_wizard_screen` — TextEditingController hoisted out of build() (fixed caret loss)
- POS printer errors — humanised snackbars + dialog surfacing
- `api_service.listOrders` — bumped default limit from 100 to 1000

**P2 fixes:**
- KDS card LATE/HOT/SOON/OK text label next to colour (colour-blind + printed KDS support)
- New shared `widgets/empty_state.dart` — CTA-driven empty states, Semantics baked in
- Wired into Inventory / Customers / Reviews screens
- Semantics wrappers on PlanGate lock badge + KDS ticket card
- New `services/forceCloseSessionService.js` — super-admin walkout closure (`POST /admin/customers/:businessId/sessions/:sessionId/force-close-unpaid`)

### 4b. Gateway refund reconciler
- New `services/refundReconcileService.js`
- Wired into `cronWorker` every 5 min
- Drains pending gateway refunds via Razorpay `/v1/payments/{pid}/refund`
- Transient (5xx / network) → keep pending with `attempt_count`; flag at 12 attempts
- Permanent (4xx) → mark failed with reason

### 4c. OTP infra (partially built, then paused)
- New `services/otpService.js` (MSG91 with DEV mode fallback)
- New `services/aggregatorLinkService.js` (OTP-based Zomato/Swiggy phone linking, with honest ToS caveats)
- New migration `053_otp_and_aggregator_link.sql`
- New routes: `POST /aggregators/link/start`, `POST /aggregators/link/verify`, `GET /aggregators/link/sessions`
- New env vars: `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID`, `OTP_DEV_MODE`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`
- **Founder decided to pause OTP owner-signin.** Aggregator OTP link stays. Phone sign-in for owners is deferred (requires `users.phone` migration + `authController.otpLogin` helper — not built).

### 4d. Firebase decision
- India news (21 Aug 2026) about India ordering Google to shut Firebase accounts was **targeted anti-scam takedowns, not a platform ban**. Verified via WebSearch.
- Founder confirmed: **Stick with Firebase for OTP + FCM push.** Free for our scale (10k verifications/month).
- Client wiring is in place; owner needs to (a) create Firebase project, (b) drop `google-services.json` into `android/app/`, (c) uncomment two lines in `pubspec.yaml` + three lines in `notification_service.dart`.

### 4e. Nav bar + hamburger cleanup (**introduced regressions, then reverted**)
- User reported Captain screen missing bottom nav + hamburger.
- I bulk-added `leading: const HomeDrawerButton()` to 33+ AppBars.
- **Bug I introduced:** unconditional `HomeDrawerButton` overrode the automatic back arrow on pushed detail screens (Edit item, Add expense, etc.) — users tapped what they thought was "back," it called `popUntil((r) => r.isFirst)`, losing their in-progress edits.
- **Fix applied:** all 37 insertions rewritten to `leading: Navigator.of(context).canPop() ? null : const HomeDrawerButton()` — pushed screens get automatic back arrow, root screens get hamburger.
- Also added `HomeBottomNav` to Orders / Menu / Expenses / Tables / Monthly report screens (they were missing it).
- **Lesson for next Claude:** DON'T do bulk regex edits across many Dart files. Use targeted `Edit` tool calls, one file at a time, and re-read the file after each change.

### 4f. UX bugs from screenshots (last turn)
- **Drawer font consistency:** `PlanGate.tile()` now uses `dense: true` to match direct `ListTile(dense: true)` entries. Removed the `subtitle:` from P&L statement and Registers so all drawer rows have the same height.
- **Driver / delivery flow rewrite:** replaced "paste driver UUID" text-input dialog with a bottom-sheet driver picker fetched from `/businesses/:id/drivers`. Empty state has clear instructions.
- **Menu editor Cancel button:** _MenuItemEditScreen's AppBar now has an explicit **X (close)** leading icon + a "Cancel" text button in actions. Save button relabeled to **Update** when editing an existing item.

---

## 5. What's known to be broken / needs verification

- **Integration tests, IDOR audit, Playwright, Flutter widget tests** — sandbox has no Postgres/Flutter SDK. These must run on real infra before shipping.
- **FCM client** — activated but firebase_messaging is not yet in pubspec.yaml (commented). Owner action needed.
- **Razorpay live mode** — still in test-mode keys. KYC pending. See `DEPLOY_READY.md` §4.
- **Aggregator Partner API** — 2-6 week vendor approval; until then OTP + manual outlet-id paste is the flow.
- **OTP owner sign-in** — infra in code, no route wired, deferred.
- **HomeBottomNav visibility on pushed captain view** — the screenshot the founder shared showed no bottom nav on "Floor — Captain view." My best guess: user was on HomeScreen with Captain as tab (canPop=false → inner nav hides by design; outer HomeScreen nav should show but screenshot suggested not). Add real device testing before launch.
- **Nav sweep collateral** — 33+ AppBars now have `Navigator.of(context).canPop() ? null : const HomeDrawerButton()`. Next Claude should sanity-check that no `context` reference is out of scope (e.g., inside static methods or inside `Builder(builder: (ctx) {...})` where `context` might be the wrong one).

---

## 6. Deployment status

### Decided
- Domain: `foodflow.me` was reserved earlier but must change once product name is locked
- Backend host: **Oracle Cloud Mumbai (Always Free)** — 4-core ARM 24GB, India-region for DPDP
- Frontends host: **Cloudflare Pages** (landing + dashboard + admin builds)
- APK distribution: direct download from landing page `/downloads/<name>-latest.apk`
- Company: **Lokhande Ventures Private Limited** (Pvt Ltd via MCA v3 RUN)
- Payment: Razorpay (test mode now → live after KYC)
- Push: Firebase Cloud Messaging (free)
- OTP: Firebase Phone Auth (free, up to 10k/month) — but not yet client-wired

### Pending founder actions
1. Register `.me` domain via Namecheap Student Pack (~₹0)
2. Create Firebase project `foodflow-prod` (or new name)
3. Create Google Cloud Console project + OAuth Web + Android client IDs
4. Complete Razorpay KYC → get live keys + create live subscription plans → update `plans_seed.sql`
5. Generate Android signing keystore (`keytool -genkey -v -keystore <name>-release.jks …`)
6. Provision Oracle Cloud Mumbai VM
7. Sentry project + DSN
8. File MCA RUN application: "Lokhande Ventures Private Limited"

### Env vars the backend needs at launch
See `DEPLOY_READY.md` §"The 12 env vars you need before deploy" for the full list. Twelve total: NODE_ENV, PORT, API_PREFIX, CORS_ORIGINS, DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_IDS, RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET, FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON, SENTRY_DSN, SUPER_ADMIN_EMAIL/PASSWORD.

---

## 7. Known founder preferences and *hard* constraints

**Constraints (don't break these):**
- "don't hard code anything" — no magic strings or values that should be config
- "do not break current project code, it should be working which I have tested till date"
- "idiot don't delete anything from now onwords without my permissions" — do not remove files or code without confirmation
- "not for liquor drink yet" — no alcohol-specific features
- Starter tier = trial-only (14 days), no yearly plan for Starter
- Staff cap excludes owner from count
- Concise replies preferred
- Android-first, no iOS work
- India-region hosting for DPDP compliance
- Free/cheap deployment first, upgrade path later
- App owner is a solo restaurant owner in India — treat UX as if they've never used a POS before

**Persistent memories in `.auto-memory/`:**
- `feedback_foodflow_constraints.md` — the constraints above
- `project_foodflow.md` — paths, stack, pending state
- `project_foodflow_pending_migrations.md` — migrations not yet applied
- `feedback_staff_cap_excludes_owner.md`
- `reference_google_signin_config.md`

---

## 8. Pending backlog items (post-launch)

- FF-324 Menu Engineering page + NPS report page
- FF-325 Feature-flag admin page (super-admin)
- FF-327 Bulk edit menu
- FF-337 Multi-language guest QR menu
- FF-338 Bulk edit orders
- FF-339 Admin ticket inbox (Crisp bridge)
- OTP owner phone sign-in — `users.phone` migration + `authController.otpLogin`
- Firebase Phone Auth client wiring (Flutter side)

---

## 9. Lessons from this session (for the next Claude)

1. **Founder is stressed and time-constrained.** Reduce loops. Commit to answers. Don't offer 10 options when 3 will do. Don't re-ask questions that have been answered.
2. **Don't do mass regex edits across Dart files.** I did two — both introduced regressions. Use targeted `Edit` per file.
3. **Verify with actual build before claiming "fixed."** I don't have Flutter SDK, so I can't run `flutter analyze`. If I can't verify, say so explicitly rather than claiming green.
4. **Product naming is done.** Don't keep proposing names. Founder needs to lock one and move on. Push for a decision, don't keep listing candidates.
5. **The "do not delete without permission" rule is a hard constraint.** If a file needs to go, ask first.
6. **On-screen changes affect confidence.** When the founder shares a screenshot showing something broken, they've tested it — believe them and fix, don't argue about theoretical navigation flows.
7. **The task list is heavy (118+ items).** Trust the "completed" flags. Don't re-audit finished work. Read `CTO_VIKRAM_72H.md` for the reasoning trail.

---

## 10. File index — what changed in this session

### Backend (new files)
- `foodflow_backend/src/services/refundReconcileService.js` — gateway refund cron
- `foodflow_backend/src/services/otpService.js` — MSG91 OTP (dormant)
- `foodflow_backend/src/services/aggregatorLinkService.js` — Zomato/Swiggy OTP link
- `foodflow_backend/src/services/forceCloseSessionService.js` — walkout closure
- `foodflow_backend/db/migrations/053_otp_and_aggregator_link.sql`
- `foodflow_backend/tests/unit/orderTransitions.test.js` — matrix invariants
- `foodflow_backend/tests/unit/otpNormalize.test.js` — phone normalisation

### Backend (edited)
- `src/services/orderService.js` — const→let tax, ORDER_TRANSITIONS export + enforcement
- `src/services/refundService.js` — prior-refund cap + cash-book auto-processed
- `src/services/kotService.js` — pg_advisory_xact_lock
- `src/services/driverService.js` — flip order to collected on delivered
- `src/services/staffService.js` — PIN brute-force lockout
- `src/services/aggregatorService.js` — placeholder UUID → null + unmapped batch
- `src/services/revenueLeakageService.js` — dropped comp filter, IST dates
- `src/services/dailyClosingService.js` + `incomeStatementService.js` + `reportService.js` — IST dates
- `src/services/billSplitService.js` — cross-tenant guard on paySplit
- `src/services/discountApprovalService.js` — per-tenant threshold key
- `src/services/cronWorker.js` — refund reconciler tick
- `src/routes/aggregatorWebhooks.routes.js` — recordWebhookOutcome
- `src/routes/finalSprint.routes.js` — FX write superadmin-only
- `src/routes/sprintsAll.routes.js` — aggregator/link/start, /verify, /sessions
- `src/routes/admin.routes.js` — force-close-unpaid endpoint
- `src/config/env.js` — MSG91 + FCM env vars

### Flutter (new)
- `lib/widgets/empty_state.dart` — shared empty-state widget

### Flutter (edited — significant)
- `lib/providers/auth_provider.dart` — `_postLogin()` FCM hook in all 5 sign-in paths
- `lib/services/notification_service.dart` — FCM stub with activation instructions
- `lib/services/api_service.dart` — listOrders limit bump + registerFcmToken
- `lib/services/repositories.dart` — splits param on OrderRepo.create
- `lib/providers/orders_provider.dart` — splits param on createOrderFromCart
- `lib/screens/pos/confirm_order_screen.dart` — split-tender UI, printer error surfacing
- `lib/screens/onboarding/setup_wizard_screen.dart` — controller hoist + dispose
- `lib/screens/kitchen/kds_screen.dart` — LATE/HOT/SOON/OK text + Semantics
- `lib/screens/customers/customers_screen.dart` — empty state CTA + hamburger
- `lib/screens/ops/reviews_screen.dart` — empty state CTA + hamburger
- `lib/screens/inventory/inventory_screen.dart` — empty state CTA
- `lib/widgets/plan_gate.dart` — dense:true + Semantics on lock badge
- `lib/screens/home/home_screen.dart` — driver picker bottom sheet, subtitle removal on P&L/Registers
- `lib/screens/menu/menu_editor_screen.dart` — explicit Cancel + X leading in item edit
- `lib/screens/orders/orders_screen.dart` + `lib/screens/menu/menu_screen.dart` + `lib/screens/expenses/expenses_screen.dart` + `lib/screens/tables/tables_screen.dart` + `lib/screens/reports/monthly_report.dart` — HomeBottomNav + HomeDrawerButton
- ~30 other screens with `leading: Navigator.of(context).canPop() ? null : const HomeDrawerButton()`

### Docs (new)
- `CTO_VIKRAM_72H.md` — 72-hour launch plan
- `DAY1_STATUS.md` — Day 1 status memo
- `DEPLOY_READY.md` — deploy punchlist with 6-section owner-action guide
- `HANDOVER.md` — this file

### Landing
- `foodflow_landing/index.html` — APK download block after hero, WhatsApp share button, install-instructions accordion

---

## 11. First message for the next Claude session

Paste something like:

> I'm continuing work on FoodFlow (rename pending — see HANDOVER.md §2). Read `HANDOVER.md` end-to-end first. Do NOT propose new names unless I ask — the founder will lock one when ready. Do NOT do bulk regex edits across Dart files. Do NOT delete files without asking. Start by reading `HANDOVER.md`, `CTO_VIKRAM_72H.md`, and `DEPLOY_READY.md`, then wait for my next instruction.

That's it. Good luck. Sorry for the churn this session.

— C.
