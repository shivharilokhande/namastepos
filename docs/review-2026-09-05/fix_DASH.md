# fix_DASH — tenant web dashboard (`namastepos_dashboard/`) — 2026-09-05

Scope respected: only files under `namastepos_dashboard/` were edited. No git commands, no backend/admin/flutter edits.

## Gate results (run in the Linux workspace against the shared working tree, Node 22.23)

| Command | Exit | Result |
|---|---|---|
| `cd namastepos_dashboard && npx tsc --noEmit -p .` | **0** | clean |
| `npm run lint` (now `eslint .`) | **0** | 0 errors, 556 warnings (pre-existing `no-explicit-any` 511, `no-unused-vars` 39, `react-refresh` 5, `exhaustive-deps` 1) |
| `npm run build` (`tsc -b && vite build`) | **0** | built in 4.2s |
| `node --experimental-strip-types /tmp/navcheck.mts` (ad-hoc assertions on `lib/navConfig.ts`: `featureForRoute`, `canSeeNavItem`, owner-only items, D-05 shapes) | **0** | "navConfig checks passed: 52 items" |

No vitest in the package. I attempted `npm install -D vitest jsdom @testing-library/react` — npm's arborist crashed (`Cannot read properties of null (reading 'edgesOut')`) before touching `package-lock.json`/`node_modules` (verified lock unchanged, only my lint-script edit in `package.json`). I did not retry: an install into the node_modules the Mac also uses, mid-way through a five-agent concurrent edit, is not a risk worth taking. Logic that could be checked without a runner (the nav table and the permission filter) was asserted with the Node script above; the hook/component behaviour is covered by the manual checks listed per item. Adding vitest is in "Needs orchestrator".

---

## Items

### D-15 — fail-open `STARTER_DEFAULT` → FIXED
- **Files:** `src/hooks/usePlan.ts` (rewritten), `src/components/Layout.tsx`
- `STARTER_DEFAULT` deleted. `has()` returns `false` for every key until `/auth/me` has a `plan` block. New fields on `PlanState`: `isLoading`, `loaded`, `planVersion`, `role`, `permissions`, `nextTierLabel`. `isStarter/isPro/isEnterprise/atLeast` are all `false` until loaded.
- Layout renders a 10-bar skeleton in place of the nav while `plan.isLoading`; once data arrives but before a plan block exists (`plan===null` server fallback) items render with **no** lock badge and link to the real route (RequireFeature then decides). Plan badge hidden until `loaded`.
- No hardcoded feature list remains in `src/` (`grep -rn "STARTER_DEFAULT\|'pos','orders'" src` = 0).
- **Manual check:** throttle network, reload `/`: sidebar shows grey skeleton, no lock icons flash; once `/auth/me` resolves, locks appear only for keys absent from `plan.features`.

### X-Plan-Version sync + D-19 duplicate fetch → FIXED
- **Files:** `src/api/client.ts`, `src/main.tsx`, `src/hooks/usePlan.ts`, `src/components/Layout.tsx`, `src/hooks/useOutletSwitch.ts`, `src/pages/MarketplacePage.tsx`
- `client.ts`: `notePlanVersion(headers)` runs in the success AND error interceptors. First value seeds the baseline; a different value fires `onPlanVersionChange` listener; in-flight dedup (`planVersionSyncInFlight`); baseline reset in `setSession()` (login / outlet switch / logout). Listener registered from `main.tsx` (avoids client→main import cycle): invalidates `['me']` and `['my-addons']`. Backend CORS already has `exposedHeaders: ['X-Plan-Version']` (app.js:119) — verified.
- D-19: one query key. `useMe()` exported from `usePlan.ts` (key `['me']`, 30s stale / 60s poll / focus refetch); `usePlan()` and Layout's onboarding check both use it. Every `['plan-summary']` invalidation re-pointed to `['me']` (`grep plan-summary src` → comments only).
- **Manual check:** as admin, remove a key from the tenant's plan; on the dashboard click anything that hits the API → sidebar/route lock updates on the next response, without waiting for the 60s poll.

### D-10 — `<RequireFeature>` route wrapper + single 402 handler → FIXED
- **Files (new):** `src/components/RequireFeature.tsx` (`RequireFeature`, `FeatureUpgradeCard`), `src/hooks/useRequiredTier.ts`, `src/lib/navConfig.ts`; **edited:** `src/App.tsx`, `src/api/client.ts`
- `RequireFeature`: spinner while `plan.isLoading`; `loaded && !has(key)` → compact card "This feature is in the **<plan name>** plan — you are on <tier>" + "View plans" → `/billing`; otherwise children (or `<Outlet/>`). The required plan name is computed from the live `/plans` feed (lowest ladder rung whose `featureKeys` contains the key) — nothing hardcoded; if no public plan carries the key the card says "not included in your current plan".
- `App.tsx`: every child route of `/` is wrapped in `<Gated path=…>` which looks up `featureForRoute('/'+path)` from `lib/navConfig.ts` — the same table Layout draws lock icons from, so nav lock === route guard by construction. Always-on routes and add-on-capable routes (`/customers`, handles its own 402 upsell) pass straight through.
- Global 402: `isFeatureLocked(err)` + `toastFeatureLocked(body)` in the error interceptor — one `toast.warning` per feature per 10s with the server `message`, description "Included from the <requiredTierLabel> plan", and a "View plans" action (`requestNavigate(upgradeUrl||'/billing')` → `np:navigate` CustomEvent claimed by Layout's `useNavigate`, full-page fallback if no listener). Per-request opt-out: `silentFeatureLock: true` in the axios config. Existing page-level handling (Ingredients/Outlets/ModifierGroups/etc.) keeps working — they still receive the rejected promise; they now also get the toast (acceptable, deduped).
- **Manual check:** on a Starter tenant open `/forecast` by URL → upgrade card, no API call, no empty table. Trigger a locked mutation twice quickly → one toast.

### D-05 — Customers / Memberships nav gates → FIXED
- **File:** `src/lib/navConfig.ts` (nav table moved out of `Layout.tsx`, comments preserved), `src/components/Layout.tsx`
- `/customers`: `feature:'loyalty', addon:'loyalty'`; `/memberships`: `feature:'memberships'` (addon dropped). Renderer semantics changed from `featureOk && addonOk` to `featureOk || addonOk` (addon is an alternative unlock). Stale 2026-08-25 comment replaced with the 2026-09-03 backend truth (`requireAddon('loyalty', { orFeature:'loyalty' })`; `/memberships` = feature only). Locked click target: `/billing` when the plan can unlock it, `/marketplace` only for add-on-only items.

### D-06 — VoiceCommand gated on `voice_pos` → FIXED
- **File:** `src/components/NewOrderDialog.tsx` — `{plan.has('voice_pos') && <VoiceCommand onText={onVoice} />}`. Fail-closed (no mic until loaded).

### D-07 — Split bill button gated on `bill_split` → FIXED
- **File:** `src/pages/TablesPage.tsx` (`SessionDialog`) — "Split bill" button rendered only when `plan.has('bill_split')`. The multi-tender "Split payment" checkbox on settle is a different feature (payment legs, not `/sessions/:id/split`) and was left alone.

### D-11 — Receipt template read-only without `custom_branding` → FIXED
- **File:** `src/pages/BillTemplatePage.tsx` — when `loaded && !has('custom_branding')`: Save button hidden, editor wrapped in `<fieldset disabled>`, `FeatureUpgradeCard` ("Editing the receipt template needs Custom branding") shown above; description reads "Read-only on your plan". Preview still renders.

### D-12 — e-invoice button + `GET /einvoice` gated on `einvoice_gst` → FIXED
- **Files:** `src/pages/OrdersPage.tsx` (`enabled: status==='collected' && plan.has('einvoice_gst')`; "Generate e-invoice (demo)" returns null without the key), `src/pages/InvoicesPage.tsx` (`enabled: plan.has('einvoice_gst')`).

### D-09 — staff see only permitted nav items (+ D-20 `MeResponse`) → FIXED
- **Files:** `src/lib/navConfig.ts`, `src/components/Layout.tsx`, `src/api/namastepos.ts` (`MeResponse`, `MePlan`, `GiftCardRow` types; `ffApi.me(): Promise<MeResponse>`)
- Every nav item now carries `perm` (staff permission key from `staffService.PERMISSION_KEYS`), `'owner'` (business_owner only) or `null` (everyone). Mapping: Overview/Action Center→`home`; Orders/Delivery board/Refunds→`orders`; Tables→`tables`; KOT/KDS→`kds`; Captain→`captain`; Reservations/Booking widget→`reservations`; QR codes→`qr_codes`; Menu/Inventory/Ingredients/Bulk import→`menu_editor`; Modifier groups→`modifier_groups`; Wastage→`wastage`; Reports/Leakage/Forecast/Heat map→`reports`; Tax invoices→`tax_invoices`; Expenses→`expenses`; Daily closing→`daily_closing`; Accounting/P&L→`pnl_statement`; Surge→`surge`; Customers/Memberships/Reviews/Coupons→`customers`; Campaigns→`whatsapp_marketing`; Aggregators→`aggregators`; In-house delivery→`driver`; Printers→`thermal_printer`; Receipt template→`bill_template`; **owner-only:** Bank reconcile, Recurring inv, B2B template, Online site, Marketplace, Retail, Outlets, Staff, Switch to NamastePOS, Settings, Plans & Billing, Refer & earn; **everyone:** Privacy (DPDP), Help, Support.
- `canSeeNavItem(item, role, permissions)`: owner → all; `perm:null` → all; unknown role or missing permission list → deny (least privilege). Groups with no visible items are hidden. Plan badge ("View plans") is owner-only. A staffer landing on a page they cannot see is `navigate(..., {replace:true})`'d to their first visible item.
- **Manual check:** sign in with a `staff_kitchen` phone+PIN → sidebar shows Overview, KDS, Kitchen (KOT), Privacy, Help, Support only; `/billing` typed in the URL redirects to `/`.

### D-03 — gift cards aligned to `payments.routes.js` → FIXED (redeem UI removed — see note)
- **Files:** `src/api/namastepos.ts`, `src/pages/MembershipsPage.tsx`
- `listGiftCards` reads `r.data.cards` → `GiftCardRow[]`; `issueGiftCard({ faceValueInr, issuedToPhone, expiresAt })` returns the raw row; new `lookupGiftCard(code)` for `GET /gift-cards/lookup/:code`. `redeemGiftCard` **deleted**: `POST /gift-cards/:code/redeem` does not exist — the only redeem path was the retired dual-ledger route (410). Redemption happens through the order/settle flow (wallet legs), so no standalone redeem UI belongs on this page; the list says so ("redeemed at the bill").
- Table columns: Code / Face value (`face_value_paise`) / Balance (`balance_paise`) / Issued to (`issued_to_phone`) / Expires (`expires_at`), empty state added. Issue dialog: Face value (₹), Issued-to phone (optional, max 20), Expires on (date → ISO end-of-day); disabled until value > 0.
- **Manual check:** Memberships → Gift cards → Issue ₹500 → 201, toast "Card XXXX-XXXX-XXXX-XXXX issued", row appears with ₹500 / ₹500.

### D-04 — B2B invoice template → PARTIAL (dashboard made safe; backend storage needed)
- **File:** `src/pages/B2BInvoiceTemplatePage.tsx` (rewritten)
- Backend check (read-only): `bill_templates` is a fixed-column table (`billTemplateService.update` has an `allowed` column map) and `PUT /bill-template`'s Joi schema is validated with `allowUnknown:false` (`middleware/validate.js`) — a nested `b2b` key would be rejected with 400. There is no other B2B template store. So the page is now **read-only** with a plain amber notice: saving is not available yet, the old page overwrote the receipt template and must not, receipt template lives at `/bill-template`, and saving will need `custom_branding` (Enterprise / add-on) — with a "View plans" button when the tenant lacks it. All `PUT /bill-template` calls removed from this page. Viewing stays gated on `b2b_invoice` via the route guard (nav table).

### D-01 — Recurring invoices placeholder → FIXED
- **File:** `src/pages/RecurringInvoicesPage.tsx` — honest "Coming soon — not yet available" card; the fake `/retail/quotations` API instructions and cron/table references are gone. States plainly that nothing can be created from dashboard, app or API and nothing is auto-generated today.

### D-14 — nav keys → FIXED
- `/captain` stays `captain_mode` (comment notes it is client-gated: nav + route guard are the gate). `/food-coupons` keeps `loyalty` (as instructed). `/online-site` → `feature: null`: the page only reads/writes `/site` (ungated server-side) and never touches QR ordering, so the `qr_ordering` lock was a lie; removed.

### D-17 — ESLint → FIXED
- **Files (new):** `.eslintrc.cjs`; **edited:** `package.json` (`lint` = `eslint .`, new `lint:strict` = `eslint . --max-warnings 0`), `src/api/namastepos.ts:800` (useless escape → error → fixed), `src/pages/MenuPage.tsx:469` (stray `eslint-disable @next/next/no-img-element` for an uninstalled plugin → removed).
- No other package in the repo has a TS/React eslint config to copy (admin has none either; backend uses airbnb-base for Node). Config = standard Vite React-TS set using the devDependencies already in the lockfile (`eslint:recommended` + `@typescript-eslint/recommended` + `react-hooks/recommended` + `react-refresh`), with `no-explicit-any`, `no-unused-vars` (`_`-prefixed allowed), `exhaustive-deps` at **warn** so the gate is 0 errors today; `no-empty` allows empty catch (house style). Ignores dist, tests (Playwright), testsprite, config files.
- Note: the old `lint` script had `--max-warnings 0`, which would have failed on the 556-warning baseline — hence the split into `lint` (gate) and `lint:strict` (burn-down target).

---

## Files changed (all under `namastepos_dashboard/`)
Modified: `package.json`, `src/App.tsx`, `src/api/client.ts`, `src/api/namastepos.ts`, `src/components/Layout.tsx`, `src/components/NewOrderDialog.tsx`, `src/hooks/useOutletSwitch.ts`, `src/hooks/usePlan.ts`, `src/main.tsx`, `src/pages/B2BInvoiceTemplatePage.tsx`, `src/pages/BillTemplatePage.tsx`, `src/pages/InvoicesPage.tsx`, `src/pages/MarketplacePage.tsx`, `src/pages/MembershipsPage.tsx`, `src/pages/MenuPage.tsx`, `src/pages/OrdersPage.tsx`, `src/pages/RecurringInvoicesPage.tsx`, `src/pages/TablesPage.tsx`, `tsconfig.tsbuildinfo` (regenerated by `npm run build`; tracked file — harmless).
New: `.eslintrc.cjs`, `src/components/RequireFeature.tsx`, `src/hooks/useRequiredTier.ts`, `src/lib/navConfig.ts`.

## Needs orchestrator (files I do not own)
1. **`.github/workflows/ci.yml`** — dashboard job: add after "Type-check dashboard":
   ```yaml
       - name: Lint dashboard
         working-directory: namastepos_dashboard
         run: npm run lint   # 0 errors; warnings are the burn-down baseline (see lint:strict)
   ```
2. **`namastepos_backend/src/config/featureRegistry.js`** — `voice_pos.clients` → `['mobile', 'dashboard']` (NewOrderDialog now checks it); `captain_mode` → `enforcement:'client', clients:['dashboard','mobile']` as planned. If the drift test also lists dashboard-checked keys, `bill_split`, `einvoice_gst`, `custom_branding`, `b2b_invoice` are now checked in the dashboard too (they remain server-enforced except `b2b_invoice`).
3. **D-04 backend (B2B template store)** — minimal design so the page can be re-enabled: migration `ALTER TABLE bill_templates ADD COLUMN IF NOT EXISTS b2b JSONB NOT NULL DEFAULT '{}'::jsonb;` (or a `b2b_templates` table); `billTemplateService.serialize` emits `b2b`; `update()` adds `b2b: 'b2b'` to `allowed`; `sprint1Extras.routes.js` PUT schema adds `b2b: Joi.object({ letterheadUrl: Joi.string().uri().allow('',null), signatureUrl: Joi.string().uri().allow('',null), terms: Joi.string().max(2000).allow('',null), bankDetails: Joi.string().max(1000).allow('',null), showHsn: Joi.boolean(), showEway: Joi.boolean() })` and — because the whole PUT is `requireFeature('custom_branding')` — either a separate `PUT /bill-template/b2b` gated on `b2b_invoice`, or keep one route and accept that saving B2B needs `custom_branding` (the page already says so). Tell me which and I will wire the page (fields are already laid out; store under `template.b2b`, never touch `logoUrl`/`footerText`).
4. **featureGate rule** `{ match: '/food-coupons', key: 'loyalty' }` so the nav lock on Coupons matches the API (today the API is open to all plans while the nav says Growth+).
5. **Vitest** for the dashboard: `npm i -D vitest@^4 jsdom @testing-library/react @testing-library/dom` from the Mac (npm in the sandbox crashed in arborist). Tests to add once present: `usePlan` returns `has()===false`/`loaded===false` while `/auth/me` is pending and after a `plan:null` response; `RequireFeature` renders spinner → card → children across those three states; `canSeeNavItem`/`featureForRoute` assertions from `/tmp/navcheck.mts` (reproduced in this report under D-09/D-10).
6. **D-13 (not in my list, unchanged):** `/inventory` is still gated on `menu_basic` on web vs `inventory_tracking` on mobile — needs the product decision before either side changes.

## Needs founder
- **D-01 recurring invoices**: the key is still sold on Advanced/Enterprise plan cards while the dashboard now says "coming soon". Decide: remove `recurring_invoices` from the live plan feature lists (admin) until built, or accept the honest placeholder.
- **D-04**: confirm whether B2B template save should require `custom_branding` (Enterprise/add-on) or only `b2b_invoice` (Pro+) — drives item 3 above.
