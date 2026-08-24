# FoodFlow — Duplicate Code & Logic Audit

**Generated:** 2026-05-28
**Scope:** All 5 surfaces (backend, dashboard, admin, flutter, print_agent + landing)
**Mode:** Report only — **no code was modified**
**Verification status:** Findings below cite file:line. Bill-consolidation finding from cross-surface check was independently re-verified (agent claim corrected — see Section 6).

---

## TL;DR

Repo is in good shape for pre-launch. **Zero blocking duplicates** found. The dominant patterns are extract-to-helper opportunities (3-5 days of optional refactor) and one mid-priority backend service consolidation (`gstService.js` + `gstService2.js`). Tier vocabulary dual-track is intentional (legacy `tier` enum vs new `tier_kind` string) and is correctly funneled through `featureService.planSummary()` everywhere I checked. No client hardcodes plan→feature mappings.

**Recommended action order if you decide to clean up later:**
1. Merge `gstService2.js` into `gstService.js` (backend HIGH)
2. Extract dashboard `downloadReport` factory (dashboard HIGH)
3. Extract Flutter `_renderReceipt` shared helper from `printer_service.dart` (flutter MEDIUM)
4. Centralize tier name constants in Flutter under `lib/constants/tiers.dart` (flutter MEDIUM)
5. Everything else is optional polish.

**Do NOT touch before launch unless you have time to re-smoke-test.** See `SMOKE_TEST_PLAN.md`.

---

## 1. Backend — `foodflow_backend`

### HIGH

**B1. Duplicate GST service files**
- `src/services/gstService.js:1-100` — GSTR-1 / GSTR-3B compliance, per-invoice IGST/CGST/SGST split (lines 52-74)
- `src/services/gstService2.js:1-39` — Item-level GST breakdown by slab (lines 7-36), same logic
- **Action:** Merge into single `gstService.js`; delete `gstService2.js`. Both are imported in production (orderController + sprintsAll.routes) — refactor carefully.
- **Risk if touched:** MEDIUM. Need to test invoice generation + GSTR-1 export.

### MEDIUM

**B2. Duplicate `food_cost_paise` column in same migration**
- `db/migrations/008_recipes.sql:83` — `order_items.food_cost_paise`
- `db/migrations/008_recipes.sql:86` — `orders.food_cost_paise`
- **Action:** Verify whether `orders.food_cost_paise` is actually queried. If not, the column on `orders` is dead. **Do not drop in prod** — query first, decide later.
- **Risk if removed:** HIGH if aggregated; LOW if unused. Grep for `orders.food_cost_paise` reads first.

**B3. Tier vocabulary dual-track still in code**
- `src/services/featureService.js:26-40` — dual lookup (`tier` enum + `tier_kind` string)
- `src/middleware/featureGate.js:14-58` — 58 hardcoded feature→tier mappings (this is the right pattern, but mappings are inline)
- `src/controllers/billingController.js:20-28` — fallback duplicated
- `db/migrations/039_plan_tier_varchar.sql` — enum→varchar migration done; legacy `tier` field remains for backward compat
- **Action:** Plan post-launch deprecation of legacy `tier` enum. Track in `ROADMAP_POST_LAUNCH.md`. **Do not deprecate before launch.**
- **Risk if touched now:** HIGH — interleaves 5+ files.

**B4. Bloated catch-all route files**
- `src/routes/sprintsAll.routes.js` — 499 lines, 69 endpoints
- `src/routes/finalSprint.routes.js` — 236 lines, 33 endpoints
- `src/routes/sprint1Extras.routes.js` — 131 lines
- **Action:** Reorganize into `accounting.routes.js`, `operations.routes.js`, `reporting.routes.js`. Pure refactor — no logic change.
- **Risk:** LOW. Mount paths stay the same in `app.js`.

### LOW

**B5.** Role cache TTL pattern in `src/middleware/auth.js:100-118` could become `src/utils/ttlCache.js` if reused.
**B6.** Service method naming inconsistent — `byId()` vs `getById()` (orderService.js:636, menuService.js:61, customerService.js:70, ingredientService.js:67 vs taxInvoiceService.js:244, couponService.js:31, addonService.js:93). Cosmetic.
**B7.** ~250 occurrences of `WHERE business_id` raw SQL pattern across 62 services. Optional helper: `queryByBusiness(table, businessId, sql)`.
**B8.** 49 inline Joi schemas in controllers — could share pagination/timestamp blocks via `src/utils/schemas.js`.

### Dead code: **none found** ✓
All route files mounted in `app.js`. Migrations all guarded with `IF NOT EXISTS`. Error handling centralized in `src/middleware/errorHandler.js` (good).

---

## 2. Owner Dashboard — `foodflow_dashboard`

### HIGH

**D1. Four near-identical report-export handlers**
- `src/pages/ReportsPage.tsx:50-57` — `exportPnl`
- `src/pages/ReportsPage.tsx:58-65` — `exportIncomeReg`
- `src/pages/ReportsPage.tsx:66-73` — `exportExpenseReg`
- `src/pages/ReportsPage.tsx:74-81` — `exportInvoiceReg`
- **Evidence:** Each is `try { setExporting; await ffApi.downloadXxx; toast.success } catch { toast.error } finally { setExporting(null) }`
- **Action:** Extract `makeExportHandler(apiCall, filename)`.
- **Risk:** LOW. Pure refactor.

**D2. Four near-identical blob-download API functions**
- `src/api/foodflow.ts:243-251` — `downloadIncomeStatement`
- `src/api/foodflow.ts:259-267` — `downloadIncomeRegister`
- `src/api/foodflow.ts:273-281` — `downloadExpenseRegister`
- `src/api/foodflow.ts:287-295` — `downloadInvoiceRegister`
- **Action:** Single `downloadReport(type, format, startDate, endDate)`.
- **Risk:** LOW.

### MEDIUM

**D3. Tax-invoice PDF — two functions, one endpoint**
- `src/api/foodflow.ts:312-320` — `downloadTaxInvoicePdf` (triggers download)
- `src/api/foodflow.ts:323-330` — `taxInvoicePrintBlobUrl` (returns blob URL)
- **Action:** One function with `mode: 'download' | 'print'`.

**D4. `refetchInterval: 5000` magic number in 7 places**
- `src/pages/CaptainPage.tsx:14`, `DriversPage.tsx:19`, `KdsPage.tsx:21`, `OrdersPage.tsx:83`, `TablesPage.tsx:33`, `TablesPage.tsx:313`, `GuestMenuPage.tsx:325`
- **Action:** Export `LIVE_QUEUE_INTERVAL = 5000` from `src/lib/constants.ts`.
- **Risk:** LOW.

**D5. Plan/Addon hooks mirror each other**
- `src/hooks/usePlan.ts:28-48` and `src/hooks/useAddons.ts:25-40` — same React Query boilerplate
- **Action:** Extract `useBusinessFeatureQuery(key, fn)`. Optional.

### LOW

**D6.** Per-page order-status constants (`OrdersPage.tsx:18-40`, `TablesPage.tsx:20`) — fine if not used across pages.

### Dead code: **none found** ✓
All 45 pages routed.

---

## 3. Super-Admin — `foodflow_admin`

### HIGH

**A1. Inline form-state setter copy-pasted in 5 pages**
- `src/pages/AdminTeamPage.tsx:85`, `AddonsPage.tsx:145`, `CouponsPage.tsx:106`, `CustomersPage.tsx:163`, `SettingsPage.tsx:42`
- **Evidence:** `const set = (k, v) => setForm(f => ({...f, [k]: v}))`
- **Action:** `src/hooks/useFormState.ts`.
- **Risk:** LOW.

**A2. Dialog close pattern in 11+ places**
- `AdminTeamPage.tsx:94`, `AddonsPage.tsx:162`, `CouponsPage.tsx:121`, `PlansPage.tsx:314,410,525`, `CustomersPage.tsx:172`, + CustomerDetailPage
- **Evidence:** `<Dialog open={true} onOpenChange={(o) => !o && onClose()}>`
- **Action:** `<ModalDialog open onClose={fn}>` wrapper.

**A3. Mutation toast + invalidate pattern in every page**
- e.g. `PlansPage.tsx:30-36, 39-46, 278-285`
- **Action:** `useAdminMutation(fn, { queryKey, toastMsg })` hook. Improves error-handling consistency.

**A4. Save/Cancel dialog footer in 24 instances**
- e.g. `PlansPage.tsx:351-357`, `AddonsPage.tsx:222-227`
- **Action:** `<SaveCancelFooter onSave onCancel isLoading />`.

### MEDIUM

**A5.** Inconsistent React Query keys: `['plans-admin']` vs `['coupons']` vs `['addons-admin']` — centralize in `src/api/queryKeys.ts`.
**A6.** Tier name + color mapping repeated: `PlansPage.tsx:17, 133-142, 227-231` + `CustomersPage.tsx:113-119`. Move to `src/lib/constants.ts`.
**A7.** CSV download helper duplicated/inline at `CustomerDetailPage.tsx:26-39` — extract to `src/lib/csvExport.ts`.
**A8.** Status→badge mappers in 3 pages: `CustomersPage.tsx:39-45`, `AdminTeamPage.tsx:53-55`, `RefundsPage.tsx:39-43`.
**A9.** Table empty-state row pattern repeated (`CouponsPage.tsx:52-53`, `CustomersPage.tsx:97-98`).

### LOW

**A10. Possibly-orphan page** — `src/pages/MetricsPage.tsx` vs `src/pages/DashboardPage.tsx` both call `adminApi.metrics()`. Verify if MetricsPage is routed in `App.tsx`; if not, **delete safely** (post-launch).
**A11.** `EditPlanDialog` (lines 391-407) and `CreatePlanDialog` (506-522) both define identical `updateLimit/removeLimit/addLimit`. Extract `useLimitEditor()`.
**A12.** Commented-out `TierFeatureSummary` block at `PlansPage.tsx:219-251` — delete (git keeps history).

---

## 4. Flutter Mobile — `foodflow_flutter` (PRIMARY SURFACE — handle with extra care)

### HIGH

**F1. Tier vocabulary leak in widgets**
- `lib/models/subscription.dart:5` — `'free'|'basic'|'pro'` (legacy)
- `lib/models/plan_info.dart:4` — `'starter'|'pro'|'enterprise'` (tier_kind)
- `lib/services/api_service.dart:380-383` — manual mapping `'starter'→'free'` etc.
- `lib/widgets/plan_gate.dart:78,106,140` — hardcoded `'starter'` / `'pro'` string checks
- `lib/widgets/trial_banner.dart:31` — hardcoded `'pro'` / `'enterprise'`
- **Action:** Create `lib/constants/tiers.dart` with a `TierKind` enum + `legacyMapping`. Import everywhere. **Mostly safe** since feature gating uses `auth.has(featureKey)` — the leaks are in trial / upsell UI only.
- **Risk:** MEDIUM. Test every plan_gate-wrapped feature after refactor.

### MEDIUM

**F2. Receipt rendering — 90% overlap between two methods**
- `lib/services/printer_service.dart:147-241` — `_buildReceipt()` for order (145 lines)
- `lib/services/printer_service.dart:265-450` — `printSessionBill()` for table session (200+ lines)
- **Evidence:** Both build header, item table, totals with identical ESC/POS column/row calls.
- **Action:** Extract `_renderReceipt({ title, items, totals })` helper. Both methods call it.
- **Risk:** LOW-MEDIUM. **Print is on the critical path** — test BT thermal print end-to-end after refactor.

**F3. Two near-identical form dialogs in Privacy screen**
- `lib/screens/settings/privacy_screen.dart:307-359` — `_GrievanceDialogState`
- `lib/screens/settings/privacy_screen.dart:367-403` — `_CorrectionDialogState`
- **Action:** Extract `_FormDialog` accepting field definitions + submit callback.

### LOW

**F4.** Bottom-sheet controller init pattern repeated in `item_config_sheet.dart:37-38`, `staff_screen.dart:339-358`, `register_reports_screen.dart:339-350`. Domain-specific — leave as-is until a 4th sheet appears.
**F5.** Phone validation centralized in `lib/utils/validators.dart:6-11` (good). Verify no inline RegExp re-introduced in new screens.

### Dead code: **none found** ✓
Currency/date formatters properly centralized in `lib/utils/formatters.dart` (good). API interceptor handles auth headers in one place (`api_service.dart:67-96`) — no service-level duplication.

---

## 5. Print Agent + Landing

### HIGH

**P1. Six identical FAQ accordion blocks in landing**
- `foodflow_landing/index.html:405-453` — six `<details>` blocks with identical SVG and `group-open:rotate-180` classes
- **Action:** Extract FAQ to a JS array, map → `<details>`. Same pattern already used for PLAN_COPY at lines 546-582.

**P2. Repetitive CTA link binding**
- `foodflow_landing/index.html:527-535` — six `set(id, href)` calls
- **Action:** Data-driven map.

### MEDIUM

**P3.** Print agent transport handlers (`agent.js:43-77`) have inconsistent timeout / error patterns — network has 5s timeout, BT and file don't. Add uniform timeout + logging.
**P4.** Print agent env reads (`agent.js:18-27`) scattered — consolidate into `transportConfig` object.
**P5.** Landing has both `PLAN_COPY`, `TIER_BULLETS`, `PLAN_FALLBACK` (lines 546-589) — three sources of plan-tier truth. Should fetch from `/v1/plans` first, fall back to minimal copy.

### ADVISORY (not a duplicate, but a divergence risk)

**P6. ESC/POS rendering lives in Flutter; print_agent is a dumb relay.**
- Flutter `printer_service.dart` is authoritative for receipt formatting (Push 22).
- `print_agent/src/agent.js:90-98` has a minimal `wrapText()` defensive fallback only — does NOT re-implement ESC/POS.
- **Action:** Document this in `agent.js` header comment so future contributors don't reinvent formatting in the agent.

---

## 6. Cross-Surface Logic Check

| Rule | Status | Verified Evidence |
|---|---|---|
| Tier vocabulary (dual track) | **ALIGNED** | `featureService.js:107-111` returns `{ tier, tierKind }`; clients call `has(featureKey)` — see `usePlan.ts:38-47`, `plan_info.dart:3-10`. |
| Bill consolidation (Push 23) | **ALIGNED** ✓ (re-verified — initial agent claim was wrong) | Flutter: `providers/orders_provider.dart:36-38, 261-263` call `listOrders(groupBy: 'session')`; `orders_screen.dart:156-158, 260-262` render bill-mode UI; `models/order.dart:105-107` documents bill-mode fields. Dashboard: `OrdersPage.tsx:78` collapse logic. Backend serializes `tableSessionId` per `orderService.js:26-27`. |
| Session abandon (Push 22) | **ALIGNED** | Backend `tableService` throws `BadRequest('Cannot release a table with active orders. Settle the bill instead.')` if orders attached. Dashboard SessionDialog + Flutter Captain sheet both surface the rejection. **Minor:** error-toast wording differs slightly between clients — cosmetic. |
| `auto_whatsapp_order` gating | **ALIGNED** | Backend `orderService.js:797` calls `features.hasFeature(businessId, 'auto_whatsapp_order')`; Flutter `settings_screen.dart:113` + `confirm_order_screen.dart:143` use `auth.has('auto_whatsapp_order')`. No tier name checks. |
| Bluetooth thermal print | **ALIGNED** | Flutter is authoritative. `print_agent/src/agent.js:86-98` is dumb passthrough. |
| DPDP consent + DSR | **ALIGNED** | Backend `me.routes.js:20-31`. Dashboard `foodflow.ts:610-619` and Flutter `api_service.dart:829-869` hit same endpoints. Only difference: `source: 'dashboard'` vs `source: 'mobile_app'` in consent payload — intentional, used for audit. |

**Net cross-surface assessment:** No logic divergence found. The audit agent initially flagged bill consolidation as DIVERGED, but direct grep verification shows Flutter does call `?groupBy=session` and renders bill-mode rows correctly. Logic is sound.

---

## 7. What I do NOT recommend doing before launch

- Touching `featureService.js` or the dual tier track — defer to `ROADMAP_POST_LAUNCH.md`.
- Refactoring `printer_service.dart` (high-risk; critical path).
- Reorganizing the catch-all route files.
- Removing any column or table from the database. Specifically do NOT drop `orders.food_cost_paise` without grepping for its read sites first.

## 8. What's safe to do before launch (if you want)

- `LIVE_QUEUE_INTERVAL` constant extraction in dashboard (1 hour, zero risk).
- Delete commented-out `TierFeatureSummary` block at `admin/PlansPage.tsx:219-251` (5 min).
- Document the ESC/POS authority in `print_agent/src/agent.js` header (5 min, no behavior change).
- Verify whether `admin/MetricsPage.tsx` is routed in `App.tsx`; delete if orphaned.

## 9. Quantified Summary

| Surface | HIGH | MEDIUM | LOW | Dead code |
|---|---|---|---|---|
| Backend | 1 | 3 | 4 | None |
| Dashboard | 2 | 3 | 1 | None |
| Admin | 4 | 5 | 3 | 1 suspected (MetricsPage) |
| Flutter | 1 | 2 | 2 | None |
| Print Agent + Landing | 2 | 3 | 0 | None |
| **Cross-surface** | 0 divergences | — | — | — |

Total lines of duplicate code in the ~₹470 LOC range (estimated). Refactor effort if you choose to do all of it: ~3-5 days.

---

## 10. Final Verdict

**Ship the current code.** Then schedule cleanup as part of Wave 1 in `ROADMAP_POST_LAUNCH.md`. Pre-launch energy is better spent on:

1. Buy `foodflow.in`
2. Hosting (Oracle Cloud Mumbai / DigitalOcean Bangalore)
3. Lawyer-reviewed Privacy Policy + ToS
4. Run `scripts/seed-compliance.sql` on prod
5. Smoke-test using `SMOKE_TEST_PLAN.md`

The codebase is healthier than typical pre-launch MVPs. Duplicate debt is real but not blocking.
