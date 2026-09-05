# fix_BE-A — entitlements / featureGate / registry / admin write paths (2026-09-05)

Repo: `/Users/shiv/AI Development/Java Projects/PetPooja Clone/namastepos_backend`. No commits, no migrations, no prod. All paths below are relative to that folder unless absolute.

## Files changed (all within my ownership)
- `src/middleware/featureGate.js` — rules repaired/removed (B2 B3 B5 B6 B7 B8 B9 B1), header comment, `FEATURE_RULES` exported read-only for the coverage test
- `src/config/featureRegistry.js` — captain_mode → client(dashboard,mobile); voice_pos clients += dashboard; marketplace_addons → ungated (why); recurring_invoices → client(dashboard) with a "no implementation exists" note (see B1 deviation below)
- `scripts/feature-registry-audit.js` — `UNENFORCED_DEBT` += `marketplace_addons` (deliberate, commented); documented the dead-rule blind spot and pointed at the new coverage test
- `docs/feature-catalog.json` — **regenerated** by `node scripts/feature-registry-audit.js --write` (generated artefact of my script; the drift test fails if it is stale — not hand-edited)
- `src/services/featureService.js` — E1 fallback guard (`_fallbackKindIsSafe`), A7 addon period-end filter + cache cap, new `assertKnownFeatureKeys()` (F1)
- `src/services/featureFlagsService.js` — F1 in `override()` and `replaceAll()`
- `src/services/customPlanService.js` — F1 on `extraFeatureKeys`/`featureKeys` before any row is written
- `src/controllers/adminController.js` — setTierFeatures uses the shared helper + F2 (plan code must exist, `pos` cannot be removed); F3 `planLimitsSchema` shared by create/update plan and custom-plan bodies
- `src/controllers/addonController.js` — F1 on `grants_features`/`grantsFeatures` (create + update)
- `src/routes/ingredients.routes.js` — D1 `requireAddon('recipe-costing', { orFeature: 'recipe_costing' })`
- `src/services/aggregatorService.js` + `src/routes/aggregatorWebhooks.routes.js` — B12 park (202) new orders when plan lacks `aggregators`
- `tests/integration/featureRegistryDrift.test.js` — replaced the dead `/outlets` sample path with `/retail/skus`
- NEW `tests/integration/featureRuleCoverage2026.test.js` (B10) and NEW `tests/integration/entitlementGates2026.test.js` (everything else)

## Items

| ID | Status | What changed | Test |
|---|---|---|---|
| B2 whatsapp_marketing | FIXED | rule `/whatsapp` → `{ match: '/wa/', key: 'whatsapp_marketing' }` (trailing slash so `/wastage`, `/wait-list`, `/wallet` are untouched). Verified `/v1/wa-webhooks` + `/v1/meta-wa-webhooks` are mounted outside the `/businesses/:id` prefix (app.js:305-306). | entitlementGates2026 "B2 get/post /wa/campaigns → 402"; featureRuleCoverage2026 pins `/wa/campaigns`, `/wa/campaigns/:id/run` |
| B3 bill_split | FIXED | grepped every route string containing `split` in `src/routes`: only `/sessions/:sessionId/split`, `/sessions/:sessionId/splits`, `/bill-split-invoices/:id/pay` (settle tender path has no `split`). Added `{ match: '/split', key: 'bill_split' }` and KEPT `/bill-split` — the invoice path is `-split`, not `/split`, so one rule cannot cover both. Check documented in the rule comment. | B3 tests (POST split / GET splits → 402 on Starter); coverage test pins all three paths |
| B5 qr_ordering | FIXED | rule `/qr-codes` (dead) → `{ match: '/qr', key: 'qr_ordering' }`. Grep of `qr` in route strings: only `/ops/qr/settings` (GET/PUT), `/ops/tables/:tableId/qr`, `/ops/tables/:tableId/qr/rotate`; `/v1/guest/*` is outside the prefix and intentionally open. Documented in comment. | B5 test flips the key via override and asserts the routes follow it; coverage test pins the 3 paths |
| B7 multi_currency_fx | FIXED | `/fx-rates` (dead) → `{ match: '/fx/', key: 'multi_currency_fx' }` | B7 test `/fx/INR/USD` → 402; coverage pins `/fx/:base/:quote` |
| B9 driver_mode | FIXED | added `{ match: '/assign-driver', key: 'driver_mode' }` | B9 test → 402; coverage pins `/orders/:orderId/assign-driver` |
| B6 captain_mode | FIXED | registry `enforcement: 'client', clients: ['dashboard','mobile']` + note; dead `/captain/` rule deleted. Audit already sees `feature: 'captain_mode'` in dashboard (now `lib/navConfig.ts`) and `MobileSurface.gated` in `feature_keys.dart`. | drift test + audit exit 0 |
| B8 marketplace_addons | FIXED | registry `ungated` with honest `why`; dead `/marketplace` rule deleted; `UNENFORCED_DEBT` gains `marketplace_addons` with a dated comment (the frozen set changed deliberately). | audit exit 0 (9 declared unenforced, was 8) |
| B1 recurring_invoices | FIXED (with a deviation) | dead `/recurring-invoice` rule deleted. **Declared `client, clients: ['dashboard']` instead of `ungated`**: the dashboard nav entry (`navConfig.ts:106`, formerly Layout.tsx:96) checks `feature: 'recurring_invoices'`, so the audit's rule 3 (`debt-now-enforced`) would reject an `ungated` declaration. The registry note says plainly: NO implementation exists, the only surface is a nav tile to a placeholder page, sold on Advanced/Enterprise, founder decision pending. If the dashboard fixer removes the nav entry, flip to `ungated` + add to `UNENFORCED_DEBT`. | drift test + coverage test (b) — recurring_invoices is no longer a `route` key |
| voice_pos | FIXED | `clients: ['mobile','dashboard']`. Dependency: the dashboard fixer's `plan.has('voice_pos')` in `components/NewOrderDialog.tsx:531` has landed in the working tree — audit passes (33 dashboard-gated). If that edit is reverted the drift test fails with `declared-client-gate-missing` for voice_pos. | audit exit 0 |
| B10 audit fooled by dead rules | FIXED | `tests/integration/featureRuleCoverage2026.test.js` builds the app via `buildApp()`, walks `app._router.stack` (decodes Express 4 mount regexps incl. `:businessId`), enumerates every path under `/v1/businesses/:businessId` (>150), and asserts (a) every `FEATURE_RULES` row is the *effective* `requiredFeature()` result for ≥1 path (dead or fully-shadowed rules fail), (b) every registry `enforcement:'route'` key is returned for ≥1 path, (c) the ten historical dead strings (`/captain/`, `/qr-codes`, `/whatsapp`, `/recurring-invoice`, `/marketplace`, `/fx-rates`, `/recipes`, `/heat-map`, `/outlets`, `/multi-outlet`) still match nothing — re-adding any fails (a). Also removed those extra dead rules (`/recipes` → covered by `/ingredients`; `/heat-map` → `/orders-by-hour`; `/outlets`,`/multi-outlet` → outlet API is at `/v1/outlet-groups` and self-gates). The audit script comment now points at this test as the second half of the gate (it cannot build the app without env/DB). | 7/7 in that file |
| D1 (my half) | FIXED | `ingredients.routes.js` → `requireAddon('recipe-costing', { orFeature: 'recipe_costing' })` (option name confirmed in `middleware/requireAddon.js:22`). `hasAddon` calls in orderService/orderDurabilityService untouched (BE-C). | D1 test: Starter 402; with only the plan feature (override) → 200 `{ ingredients }` |
| E1 tier_kind fallback = Enterprise | FIXED | `featuresFor`/`listTierFeatures` fall back to kind rows only when `_fallbackKindIsSafe()`: kind ≠ code, kind not in `planTiers.LIVE_PLAN_CODE_TO_KIND`, and no `plans.tier = kind` row (covers minted codes). Otherwise an unconfigured plan resolves to the EMPTY set. | E1 tests: plan `e1_growth_empty` kind `pro`, zero rows → `listTierFeatures` `[]`, tenant on it has `features: []` and none of Enterprise's 47 keys; legacy kind that is not a code still falls back; minted code `platinum` blocks fallback. `plan_tier_ladder`, `plans_addons_2026`, `trialPlanTier2026` pass |
| A7 expired addon still grants | FIXED | `_load` addon query `AND (ba.current_period_end IS NULL OR ba.current_period_end > NOW())`; selects `current_period_end` and caps the cache entry at the nearest addon end (same mechanism as trial/grace). | A7 tests: active row with past period → `hasFeature` false, `/wa/campaigns` 402; running period → true; 1.5 s period → true then false after 1.7 s without clearCache |
| F1 one key validator | FIXED | `featureService.assertKnownFeatureKeys(keys, { what })` (allowed = catalog = registry ∪ existing plan_features, same as the plan editor) → `BadRequest` 400 with `details.unknownFeatureKeys`. Used by: setTierFeatures controller, `featureFlagsService.override/replaceAll` (so the admin PUT route gets it too), `customPlanService.upsertForBusiness` (before any INSERT), `addonController._normalizeGrants` (create + update). | F1 tests: helper contract; overrides PUT 400 + nothing written; custom-plan 400 + no plan row; addon POST 400 + no row, PUT 400 + grants untouched, valid camelCase save 200; tier-features 400 |
| F3 limits Joi | FIXED | `PLAN_LIMIT_KEYS = staff, floors, tables, menu_items, monthly_orders, businesses` (exactly the metrics `enforceLimit` reads + live plan feed); each `Joi.number().integer().min(-1)`, `.unknown(false)` with a message naming the known limits. Applied to `createPlanBody`, `updatePlanBody`, `putCustomPlanBody` (custom plans can now cap `businesses`, admin review F-06). | F3 tests: `staff:'ten'` 400, `staf:5` 400, `2.5`/`-2` 400, full valid set incl. `businesses` 200/201, custom-plan typo 400 |
| F2 | FIXED | `PUT /admin/tier-features/:code`: 400 if no `plans.tier = code`; 400 `details.missingFeatureKeys:['pos']` if `pos` absent. Controller-level only, so `customPlanService` (which writes the plan row first) is unaffected. | F2 tests: unknown code 400; removing pos 400 and matrix unchanged; same set with pos 200 |
| B12 aggregator ingestion | FIXED | `handleWebhookEvent` new-order branch: `hasFeature(businessId,'aggregators')` false → returns `{ parked:true, reason:'FEATURE_LOCKED', feature:'aggregators' }`, logs a warn line, does NOT mark the inbound event `handled` (payload stays replayable; a provider retry after upgrade is processed). Route answers **202** and records `recordWebhookOutcome(ok:false, "Order parked: your plan does not include 'aggregators'…")` so the owner's sync badge says why. Lifecycle events (cancel/rider/picked/delivered) for existing orders are deliberately NOT gated. | B12 tests: 202 + no order row + `aggregator_health.last_error` + inbound event `handled=false`; cancel for an existing order still applies; after override the SAME payload → 200 `created:true` |

## Verification (exact commands, Mac shell, local test DB)

```
node scripts/feature-registry-audit.js --write   # regenerated docs/feature-catalog.json
node scripts/feature-registry-audit.js
  → feature-registry-audit: OK — 52 registered keys; 27 server-gated, 26 mobile-gated, 33 dashboard-gated, 9 declared unenforced.   AUDIT_EXIT=0

npx eslint <my 14 files>   → ✖ 20 problems (0 errors, 20 warnings)   EXIT=0
npx eslint src tests       → 13 errors, ALL in tests/integration/lifecycleBilling2026.test.js (another fixer's in-progress file); 0 in any file I own.

DATABASE_URL=postgresql://namastepos:namastepos@localhost:5432/namastepos_test NODE_ENV=test npx jest --runInBand \
  tests/integration/featureRuleCoverage2026.test.js tests/integration/entitlementGates2026.test.js \
  tests/integration/featureRegistryDrift.test.js tests/integration/plan_tier_ladder.test.js \
  tests/integration/plans_addons_2026.test.js tests/integration/addon_tier_outlets2026.test.js \
  tests/integration/rbac.matrix.test.js tests/integration/trialPlanTier2026.test.js \
  tests/integration/fulfilment2026.test.js tests/integration/proStaffClaim2026.test.js > /tmp/bea2.log 2>&1; echo EXIT=$?
  → EXIT=0   Test Suites: 10 passed, 10 total   Tests: 182 passed, 182 total
```

Second sweep of suites that touch my surfaces (`securityBatch2026 guest_benefit2026 ops expenses-reports crossTenant durability2026 money_regressions2026 admin-customers admin_saas_ops2026 billing menuBulkCap2026 trialGraceLimits2026 marketingClaims customers`): EXIT=1 — 11 pass, 3 fail; the 3 are pre-existing fixtures that depended on the bugs being fixed (details + exact patches below). 174/182.

## Needs orchestrator (files I do not own)

1. **`tests/integration/trialGraceLimits2026.test.js:353-360` (4 failures, caused by E1 being fixed — the fixture relied on the trap).** The `custom-grace` plan is inserted with `tier_kind 'pro'` and NO `plan_features` rows; its comment even says "feature set (tier_kind 'pro') includes wastage" — i.e. it was reading Enterprise's rows through the bug. Add after the plan INSERT:
   ```js
   await query("INSERT INTO plan_features (tier_kind, feature_key) VALUES ('custom-grace', 'wastage'), ('custom-grace', 'pos') ON CONFLICT DO NOTHING");
   ```
   (and fix the comment: "the plan's OWN rows include wastage").
2. **`tests/integration/ops.test.js:82-85` (1 failure).** Test seed Starter lacks `qr_ordering` (live Starter has it), so `/ops/tables/:id/qr` now 402s as designed. Match the file's existing convention for reservations: `expect([200, 402, 404, 400, 403]).toContain(r.status); // 402 = FEATURE_LOCKED (qr_ordering is plan-gated since 2026-09-05)`.
3. **`tests/integration/durability2026.test.js` NP-302 (3 failures) — BE-C's area.** BE-C switched `orderService`/`orderDurabilityService` from `addons.hasAddon()` (uncached DB read) to `featureService.hasFeature()` (60 s cache). The fixture inserts the `business_addons` row at line 265 AFTER earlier tests in the file have already loaded the tenant's feature cache, so the deduction branch sees no entitlement. Add `featureService.clearCache(biz.id);` right after that INSERT (require featureService at the top). Not caused by A7 (period end is +30 days).
4. **`src/services/subscriptionService.js:749-750` (F3 NaN fail-open, suggested one-liner):**
   ```js
   const limit = Number(raw);
   if (!Number.isFinite(limit)) { logger.warn(`enforceLimit(${metric}): non-numeric limit ${JSON.stringify(raw)} for business ${businessId} — treating as uncapped`); return next(); }
   if (limit < 0) return next(); // -1 = unlimited
   ```
   Joi now prevents bad values reaching the DB via admin; this only makes a legacy bad row visible.
5. **`tests/integration/lifecycleBilling2026.test.js`** — 13 eslint errors (all auto-fixable: `npx eslint --fix` on that file). Another fixer's file; backend lint gate is not 0 until they fix it.
6. **Admin console follow-ups (not blocking):** `PlansPage.tsx` "Add limit" free-text field will now get a 400 for anything outside the six known metrics — consider a dropdown of `staff, floors, tables, menu_items, monthly_orders, businesses`. `CustomerDetailPage.tsx` `CUSTOM_PLAN_LIMIT_KEYS` can add `businesses` (backend accepts it now). Any picker that lets an admin untick `pos` on a plan will get a 400 with `details.missingFeatureKeys`.
7. **Dependency note:** the registry now declares `recurring_invoices` and `captain_mode` as dashboard-gated because `namastepos_dashboard/src/lib/navConfig.ts` checks them, and `voice_pos` because `NewOrderDialog.tsx:531` does. If the dashboard fixer removes any of those checks, run `node scripts/feature-registry-audit.js` — it will name the key; for recurring_invoices the right move is then `ungated` + add to `UNENFORCED_DEBT`.

## Needs founder
- **recurring_invoices** is sold on Advanced and Enterprise with no implementation (B1/D-01). Decide: build it or pull it from the two plans and the landing/plan cards. Until then it is honestly labelled in the registry note.
- **marketplace_addons** now declared ungated: it differentiates plan cards only (`/addons` is deliberately open to every plan so tenants can buy in). Decide whether to keep granting it.
- **qr_ordering** is now actually enforced on `/ops/qr/*` and `/ops/tables/:id/qr*`. Live Starter carries the key so nothing changes for customers today; removing it from Starter in admin will now really lock QR self-ordering for Starter tenants (that is the fix, but it is a lever that did nothing before).
- Aggregator orders for a tenant whose plan lacks `aggregators` are now parked (202, replayable) instead of ingested. Any live tenant with credentials configured but no `aggregators` key would stop receiving orders — check `aggregator_credentials` vs plan features in prod before deploy (`SELECT c.business_id, c.provider FROM aggregator_credentials c WHERE c.is_active` cross-checked against `/auth/me` features; read-only query).
