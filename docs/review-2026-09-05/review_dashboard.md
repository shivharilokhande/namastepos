# Review — tenant web dashboard (`namastepos_dashboard/`, app.namastepos.in)

Reviewer scope: entitlement plumbing, page/route feature matrix, tier-code trap, auth security, functional bugs, tsc/eslint.
Method: read code (all of `src/App.tsx`, `Layout.tsx`, `hooks/usePlan.ts`, `useAddons.ts`, `api/client.ts`, sampled every page), scripted cross-check of 243 dashboard API calls vs 474 backend routes (Node script, param-aware regex), scripted cross-check of `featureGate.js` rules vs real backend paths, `tsc --noEmit`, `eslint`. Live plan feed taken from `namastepos_backend/tests/fixtures/plan-feed.json` (Sep 5 snapshot, 15/24/34/45/51 — matches the brief; sandbox has no outbound network). READ-ONLY, nothing edited.

## Answers to the founder's four questions (dashboard view)

1. **Working or bugs?** Mostly working; `tsc` clean. But: Gift-cards tab is entirely broken (wrong request body, wrong response key, wrong columns), B2B-invoice-template page silently corrupts the receipt template and cannot be saved below Enterprise, Recurring-invoices page is a placeholder that tells owners to "use the API" (and no API exists), Ingredients is unusable on Pro/Advanced/Enterprise without buying an add-on the plan already includes.
2. **All features present in admin?** Not my area, but the dashboard sells 7 registry keys with no/placeholder UI: `recurring_invoices` (placeholder), `multi_currency_fx`, `tds_tcs`, `dead_stock` (no dashboard page at all), `api_access`, `white_label` (registry-documented), `b2b_invoice` (page broken).
3. **Working in dashboard?** See findings table; 3× P0, 8× P1.
4. **Activate/deactivate per plan?** **Sidebar only.** `usePlan().has(key)` is consulted in exactly three places (Layout nav, MenuPage variants, StaffPage permission checkboxes). No route is guarded, no page hides on a missing key; a locked feature is reachable by URL and the page renders normally until the server 402s — and most gated pages swallow that 402 into an empty list with no upgrade prompt. For the 8 `clients: ['dashboard']` keys the nav lock **is the entire gate**, so removing e.g. `reports_basic` from a plan in admin changes a lock icon and nothing else.

---

## 1. Entitlement plumbing (how the dashboard learns features)

| Aspect | Finding | Evidence |
|---|---|---|
| Source | `GET /auth/me` → `plan.features[]`, `plan.tierKind` | `hooks/usePlan.ts:40-50`; backend `controllers/authController.js:511-560` |
| Helper | `usePlan().has(key)` (Set lookup) — exists | `usePlan.ts:56` |
| Fail-closed before load? | **No — fail-open to a hardcoded 10-key Starter list.** While `/auth/me` is loading, or when `plan` is `null` (backend `planSummary` threw), `has()` answers from `STARTER_DEFAULT = ['pos','orders','token_generation','tables_single_floor','menu_basic','reports_basic','expenses','invoice_basic','staff_lite','customers_basic']`. Unknown keys deny, but those 10 are granted without proof. Also a hardcoded feature list (violates the no-hardcoding constraint; already drifted — live Starter also has kds/captain_mode/daily_closing/qr_ordering/menu_variants_modifiers). | `usePlan.ts:13-18, 49-50` |
| Refresh | React-Query poll: `staleTime 30s`, `refetchInterval 60s`, `refetchOnWindowFocus`. Invalidated explicitly on outlet switch. **`X-Plan-Version` header is never read** (grep `plan-version|planVersion` in `src` = 0 hits); `plan.planVersion` in the /auth/me body is ignored. Propagation ≤60s, acceptable but the 2026-09-05 header work is unused on web. | `usePlan.ts:45-47`, `client.ts:244-369` |
| Duplicate fetch | `Layout.tsx:197` queries `['me']` and `usePlan` queries `['plan-summary']` — both call `ffApi.me()`; two identical `/auth/me` requests on every mount and every poll. | P3 |
| Where `has()` is used | `Layout.tsx:284` (nav lock), `MenuPage.tsx:584-585` (variants section), `StaffPage.tsx:328,413` (perm checkboxes). That is all. The grep in the task brief was right to be suspicious: `OutletSwitcher`, `useOutletSwitch`, `DeliveryBoardPage`, `OutletsPage`, `CustomersPage`, `IngredientsPage`, `ModifierGroupsPage`, `CustomerDetailDrawer`, `NewOrderDialog`, `TablesPage` do not check keys — they react to a **402 after the fact** (some gracefully, see matrix). | grep |
| Global 402 handling | **None.** `api/client.ts` response interceptor handles 401 (refresh) and `PLAN_LIMIT` analytics only; `FEATURE_LOCKED` is not intercepted. `apiError()` renders it as `"FEATURE_LOCKED: Upgrade to Pro to unlock this feature."` in a red toast wherever a mutation has `onError`. List queries mostly have no error UI → silent empty page. | `client.ts:278-368`, `client.ts:373-381` |
| Addon dimension | `useAddons()` — optimistic **unlock while loading** (`addons.isLoading` ⇒ treated as owned) — fail-open by design, cosmetic only. | `useAddons.ts`, `Layout.tsx:288` |

---

## 2. Findings

Severity legend per brief: P0 data loss/security/money/fake feature sold · P1 feature broken or gate wrong for some plan · P2 bug with workaround · P3 quality.

| # | Sev | Where | Evidence (what the code does) | Why wrong | Fix | Verified by |
|---|---|---|---|---|---|---|
| D-01 | **P0** | `pages/RecurringInvoicesPage.tsx:9-11, 29-33`; backend: no route; `services/cronWorker.js:535-557` | Page is a static card: "Use the API to set up a template (the dashboard form for this is the next UI sprint). Send a POST to `/v1/businesses/:id/retail/quotations`…". Backend has **no** create/list route for recurring invoices (grep `recurring` in `src/routes` = 0); the cron `dueRecurringInvoices()` only `logger.info`s and bumps `next_run_at` — it generates no invoice. featureGate rule `/recurring-invoice` matches **zero** routes. | `recurring_invoices` is sold on Advanced (₹999) and Enterprise and is listed on the plan cards; the customer gets a page telling them to call an API that doesn't exist. Fake feature sold. | Either build it (routes + form) or remove the key from live plans and the plan cards until built; delete the misleading placeholder text now. | read code + route scan |
| D-02 | **P0** | backend `routes/ingredients.routes.js:11` `requireAddon('recipe-costing')` (no `orFeature`); dashboard `Layout.tsx:80` gates nav on `recipe_costing`; `pages/IngredientsPage.tsx:82-96` | `/ingredients/*` requires the paid `recipe-costing` add-on. `requireAddon` only falls back to a plan feature when `orFeature` is passed (`middleware/requireAddon.js`), and it is not. Pro/Advanced/Enterprise plans grant `recipe_costing`; the sidebar therefore shows Ingredients **unlocked**, the page loads, gets 402 `ADDON_REQUIRED`, and renders "Recipe & Food Cost is a paid add-on … Open Marketplace". | A Pro (₹799) owner has paid for recipe costing and is told to buy it again. Same bug class the 2026-09-03 audit fixed for `/customers` (`requireAddon('loyalty', { orFeature: 'loyalty' })`). Cross-area (backend fix), reported here because the dashboard is where the customer sees it. | `requireAddon('recipe-costing', { orFeature: 'recipe_costing' })`. Also the featureGate `/ingredients → recipe_costing` rule already runs before it, so the addon check is redundant for plan holders. | read both sides |
| D-03 | **P0** | `pages/MembershipsPage.tsx:20, 120-125, 230-235`; `api/namastepos.ts:536-538`; backend `routes/payments.routes.js:83-99` | (a) `listGiftCards` reads `r.data.giftCards`; backend returns `{ cards }` → list is always empty. (b) Table renders `c.initial_paise`, `c.remaining_paise`, `c.purchaser_phone`; backend rows are `face_value_paise`, `balance_paise`, `issued_to_phone`. (c) `NewGiftDialog` posts `{ amountInr, purchaserPhone, recipientPhone }`; backend Joi requires `faceValueInr` → **400 on every issue**. (d) `issueGiftCard` reads `r.data.giftCard` but backend returns the raw row → `g.code` would throw if (c) ever passed. (e) `redeemGiftCard` targets `POST /gift-cards/:code/redeem`, which does not exist (the only redeem path is the retired `/memberships/gift-cards/:code/redeem` → 410). | Gift cards (part of the `memberships` feature sold on Pro+) cannot be issued, listed or redeemed from the web. The dashboard was written against the retired "dual ledger" API. Money feature that does nothing. | Align to `payments.routes.js`: body `{ faceValueInr, issuedToPhone, expiresAt }`, read `r.data.cards`, columns `face_value_paise/balance_paise/issued_to_phone`, return row directly; remove or re-point `redeemGiftCard` (redemption is via wallet legs in the order flow). | read code, shape script |
| D-04 | **P1** | `pages/B2BInvoiceTemplatePage.tsx:22-50`; backend `routes/sprint1Extras.routes.js:97-100` | Page reads and **writes the receipt `bill-template`** (`PUT /bill-template` with `logoUrl` ← letterhead, `footerText` ← terms). `signatureUrl`, `bankDetails`, `showHsn`, `showEway` are never sent. The PUT is `requireFeature('custom_branding')` (Enterprise-only + addon). Nav gates the page on `b2b_invoice` (Pro+). | Pro/Advanced owners see an unlocked page, fill bank details and signature, Save → 402 "Upgrade to Enterprise". Enterprise owners "succeed" and silently overwrite their receipt footer/logo with B2B terms/letterhead, and lose the fields they typed. `b2b_invoice` is a `clients:['dashboard']` key whose only dashboard surface is this page. | Give B2B its own storage (`business_settings.b2b_template` or a KV row) and gate the write on `b2b_invoice`; or remove the page and the key from plan cards. | read code |
| D-05 | **P1** | `components/Layout.tsx:114` (`/customers`: `feature: null, addon: 'loyalty'`), `:119` (`/memberships`: `feature:'memberships', addon:'loyalty'`); backend `routes/customers.routes.js:26` `requireAddon('loyalty', { orFeature: 'loyalty' })`, `routes/growth.routes.js:63-66` (memberships: featureGate `memberships` only, no addon) | Nav requires the **paid loyalty add-on** for Customers and Memberships. Backend accepts plan feature `loyalty` for `/customers` and requires only plan feature `memberships` for `/memberships`. Growth/Pro/Advanced/Enterprise all include `loyalty`; Pro+ include `memberships`. | Every paid-plan owner without the add-on sees Customers and Memberships **locked**, and the lock routes them to `/marketplace` to buy an add-on they already have as a plan feature. The comment at `Layout.tsx:104-113` documents the pre-2026-09-03 backend and is now stale. | `/customers`: `feature: 'loyalty'` with addon as OR (`unlocked = featureOk || addonOk`) — or simplest: `feature:'loyalty', addon: undefined` since the addon grants the key via `grants_features`. `/memberships`: drop `addon`. | read both sides |
| D-06 | **P1** | dashboard `components/NewOrderDialog.tsx:525` `<VoiceCommand onText={onVoice} />`; registry `voice_pos` `clients: ['mobile']` | "Take new order" shows the mic button to **every plan** in any browser with `SpeechRecognition`; no `plan.has('voice_pos')`. Registry says only mobile gates it — so the web ships voice ordering ungated. | Exactly the 2026-09-05 bug on a second client: removing `voice_pos` from Enterprise today changed nothing on the web POS; Starter gets it free. | Render `VoiceCommand` only when `plan.has('voice_pos')`, add `'dashboard'` to `clients` in the registry (drift test then guards it). | read code |
| D-07 | **P1** | dashboard `pages/TablesPage.tsx:1388` (Split button, ungated) + `components/BillSplitDialog.tsx:73-94`; backend `routes/finalSprint.routes.js:55` `POST /sessions/:sessionId/split`; featureGate rule `{ match: '/bill-split', key: 'bill_split' }` | The split-creation path `/sessions/:id/split` does **not** contain `/bill-split`; only `PUT /bill-split-invoices/:id/pay` does. Starter (no `bill_split`) can create a split (rows in `bill_splits`/`bill_split_invoices`) and is then 402'd when paying each split invoice. Dashboard shows the Split button regardless of plan. | Gate is on the wrong half of the flow: the paid feature is given away, and Starter tables end up with unpayable split invoices (stuck session). | Backend: add `{ match: '/split', key: 'bill_split' }` (or `requireFeature('bill_split')` on the route). Dashboard: hide/lock the Split button when `!plan.has('bill_split')`. | read both sides, rule scan |
| D-08 | **P1** | dashboard `Layout.tsx:122` (`/campaigns` nav → `whatsapp_marketing`), `pages/CampaignsPage.tsx`; backend `routes/growth.routes.js:178-193` `/wa/campaigns*` (role check only); featureGate rule `/whatsapp` | No backend route path contains `/whatsapp` (rule scan: **0 matches**). `/wa/campaigns` list/create/run are ungated on plan. The dashboard's only gate is the sidebar lock. | `whatsapp_marketing` (Growth+) is free to Starter via `/campaigns` typed in the URL — and campaign runs cost real messages. Registry claims `enforcement: 'route'`; that is drift. | Backend: rule `{ match: '/wa/', key: 'whatsapp_marketing' }`. Dashboard: route guard (see D-10). | read both sides |
| D-09 | **P1** | `components/Layout.tsx` (no `permissions`/`role` use), `App.tsx:129-183`; backend `/auth/me` returns `permissions[]` for staff (`authController.js:527-555`) | A staffer signed in via phone+PIN (`LoginPage.tsx:87-130`) gets the **full owner sidebar**: Reports, P&L, Expenses, Staff, Plans & Billing, Settings, Bank reconcile, Outlets… `permissions` from `/auth/me` is never read anywhere (grep = 0 outside StaffPage where the owner edits them). Backend enforces via `requireStaffPerm`/`requireRole`, so the result is 403 toasts / silently empty pages (e.g. Overview's `/reports/daily` needs perm `reports`). | Same "kitchen staff saw owner UI" bug that was fixed on mobile on 2026-09-03, still open on web. Not a data leak (server denies), but a kitchen PC shows Billing/Staff/Settings to every employee. | In `renderNavItem`, hide items whose perm key (reuse `StaffPage.PERMISSION_FEATURE` keys) is absent from `me.permissions` when `role !== 'business_owner'`; land staff on the first permitted page. | read code |
| D-10 | **P1** | `App.tsx:129-183` (no per-route gate), every gated page (e.g. `KdsPage.tsx:13-17`, `CaptainPage.tsx:14`, `HeatMapPage.tsx:17` `.catch(() => rows: [])`, `ForecastPage.tsx:13`, `ReservationsPage`, `WastagePage`, `SurgePage`, `AccountingPage`, `BankReconcilePage`, `DailyClosingPage`, `ReviewsPage`, `CampaignsPage`, `DriversPage`, `RetailPage`, `CouponsPage`, `AggregatorsPage`) | Routes render for every plan. On a 402 the list query errors; none of these pages read `error`/`isError`, so the page shows an empty table plus an "Add …" button; mutations then toast `FEATURE_LOCKED: Upgrade to …`. Graceful 402 handling exists only in Ingredients, ModifierGroups, Customers, Outlets, DeliveryBoard, CustomerDetailDrawer, NewOrderDialog, TablesPage (loyalty). | For the 8 `clients:['dashboard']` keys this means the nav lock is the whole gate and it is bypassable by URL; for route-enforced keys the UX on downgrade/deep-link/stale-tab is a blank page. Q4 "deactivate correctly" is therefore only true for the sidebar. | Add a `<RequireFeature key>` route wrapper in `App.tsx` that renders the existing upsell card (reuse `OutletsPage` locked card) when `!plan.has(key)`, and intercept `402 FEATURE_LOCKED` once in `client.ts` (toast with "View plans" action). | read code |
| D-11 | **P2** | `pages/BillTemplatePage.tsx:43-50`; nav `Layout.tsx:154` `feature: null`; backend `sprint1Extras.routes.js:97-100` | Receipt template page is always-on and fully editable; Save is `requireFeature('custom_branding')` (Enterprise/add-on only). Starter–Advanced owners edit GSTIN/FSSAI/footer and get a red `FEATURE_LOCKED` toast. | Same "editable form whose save is a 402" class as the founder-reported variants bug fixed in `MenuPage.tsx:575-600`. Workaround: business GSTIN/FSSAI also live in Settings. | Lock the form (not the nav) when `!plan.has('custom_branding')`, with the upsell card. | read both sides |
| D-12 | **P2** | `pages/OrdersPage.tsx:175-185, 477-486`; `pages/InvoicesPage.tsx:238-245` | "Generate e-invoice (demo)" button on every collected order for every plan; `GET /einvoice` fires on the Orders "collected" tab and on the Invoices page for all plans. `einvoice_gst` is Advanced+, so Starter/Growth/Pro get a 402 (+1 retry) on every visit and a `FEATURE_LOCKED` toast on click. | Ungated paid-feature button; wasted 402 pairs on every Orders/Invoices load for 3 of 5 plans. | `enabled: plan.has('einvoice_gst')` on both queries; hide the button otherwise. | read code |
| D-13 | **P2** | `components/Layout.tsx:79` `/inventory` → `feature: 'menu_basic'` | Inventory is unlocked for Starter on web; on mobile the same tile is gated on `inventory_tracking` (Pro+, registry `clients:['mobile']`). | Web and mobile disagree on which plan includes Inventory; the Pro differentiator is free on web. Decide deliberately (registry note says stock endpoints are intentionally open). | Gate on `inventory_tracking` and add `'dashboard'` to its `clients`, or document that web Inventory is Starter. | read code + registry |
| D-14 | **P2** | `components/Layout.tsx:121` `/food-coupons` → `loyalty`; `:128` `/online-site` → `qr_ordering`; `:63` `/captain` → `captain_mode` | Backend: `/food-coupons` has no gate rule; `/site` has none; `/captain/` rule matches **0 routes** and `CaptainPage` only calls `/ops/tables`. Nav shows locks the API does not enforce (coupons for Starter) or gates on keys the server ignores. | Nav ≠ API mismatches of the kind the Layout comments say were already "sync-fixed". Low impact today (Starter has qr_ordering/captain_mode) but wrong the moment admin toggles a key. | Align nav keys with the server (`/food-coupons` → `null` or add a backend rule; `/online-site` → `null` or add a rule). Backend: fix/remove dead `/captain/`, `/qr-codes`, `/whatsapp`, `/recurring-invoice`, `/marketplace`, `/fx-rates`, `/recipes`, `/heat-map` rules (rule scan below). | rule scan |
| D-15 | **P3** | `hooks/usePlan.ts:13-18` | Hardcoded `STARTER_DEFAULT` feature list used as the pre-load / error fallback (fail-open for 10 keys). | Violates no-hardcoding; drifts from live Starter; brief asks for fail-closed. Impact today is a brief lock/unlock flicker. | `features: []` default + `isLoading` flag; render nav skeleton until loaded. | read code |
| D-16 | **P3** | `src/i18n/index.ts`, `en.json`, `hi.json` | `t()` is never called (`grep "t('"` in src = 0), `setLocale`/`LANGS` never imported. 50 keys × 2 locales are dead. No missing keys (en==hi key sets). | Dead Hindi i18n scaffold; no i18n bug because nothing uses it. | Remove or wire up. | grep |
| D-17 | **P3** | `package.json:10` `"lint": "eslint . --max-warnings 0"`; no `.eslintrc*`/`eslint.config.*` in `namastepos_dashboard/`; `.github/workflows/ci.yml` dashboard job runs only `tsc --noEmit` + `build` | `npx eslint src` → "ESLint couldn't find a configuration file" (exit 2). `npm run lint` has never worked for this package. | No lint gate on the dashboard at all (react-hooks rules etc. unenforced). | Add `.eslintrc.cjs` mirroring the admin package; add `npm run lint` to the CI job. | ran eslint |
| D-18 | **P3** | `pages/BillingPage.tsx:135-190` `FEATURE_LABELS` | Local 45-entry label map; registry has 51 keys. Missing: `auto_whatsapp_order, custom_branding, dashboard_access, inventory_tracking, pnl_statement, registers, tax_invoices` → plan cards fall back to `k.replace(/_/g,' ')` ("pnl statement"). Backend `/plans` sends `featureKeys` but not labels. | Second hand-maintained label list — the drift the registry was created to end. | Have `/plans` (and `/public/plans`) emit `featureLabels` from `featureRegistry.labelOf`; drop the local map. | diff script |
| D-19 | **P3** | `Layout.tsx:197` + `usePlan.ts:40` | Two React-Query keys (`['me']`, `['plan-summary']`) for the same `/auth/me`. | 2× requests per mount and per 60s poll. | Share one key. | read code |
| D-20 | **P3** | `api/namastepos.ts:225` `MeResponse` | Type omits `permissions`, `tierLabel`, `nextTierKind`, `planVersion` that the server sends. | Blocks D-09 fix and X-Plan-Version adoption. | Extend the type. | read code |

Cross-area facts surfaced by the featureGate rule scan (backend owner should own the fix; listed so the matrix below is honest about "who really gates it"). Rules matching **no** backend route: `captain_mode:/captain/`, `qr_ordering:/qr-codes`, `whatsapp_marketing:/whatsapp`, `recipe_costing:/recipes` (harmless, `/ingredients` covers it), `recurring_invoices:/recurring-invoice`, `multi_outlet:/outlets` & `/multi-outlet` (covered separately by `multiOutlet.routes.js`), `heat_map:/heat-map` (covered by `/orders-by-hour`), `marketplace_addons:/marketplace`, `multi_currency_fx:/fx-rates`. Registry marks all of these `enforcement: 'route'`; `qr_ordering`, `captain_mode`, `whatsapp_marketing`, `marketplace_addons`, `multi_currency_fx`, `recurring_invoices` are in fact **ungated** (no `hasFeature` call anywhere for them either — grep confirmed). Also `bulk_import` gates only `/retail/bulk-import`; menu/customers/expenses/sales-history imports (`/menu/bulk`, `/imports/*`) are open to all plans while the registry label says "Bulk menu import" — the plan card claim and the gate disagree.

---

## 3. Dashboard feature matrix

Legend — **Nav**: key checked in `Layout.tsx` (lock icon + redirect to /billing or /marketplace). **Route**: guard in `App.tsx` (none exist). **Page**: in-page `plan.has()` or graceful 402 handling. **Server**: what actually 402s (featureGate rule / requireFeature / requireAddon / staff perm / none). Plans column = lowest live plan holding the key (S=Starter, G=Growth, P=Pro, A=Advanced, E=Enterprise, — = not a plan key).

| Route (`App.tsx`) | Nav label / group | Nav key | Route guard | Page gate / 402 handling | Server gate (real) | Plan | Notes |
|---|---|---|---|---|---|---|---|
| `/` | Overview (top) | none | none | none | perm `reports` on `/reports/daily` | S | staff without `reports` perm see empty KPIs (D-09) |
| `/action-center` | Action Center (top) | none | none | none | none | S | |
| `/orders` | Orders / Sales | `orders` (client:dashboard) | none | none | none | S | client key → nav lock is the only gate (D-10). Voice mic in NewOrderDialog ungated (D-06). E-invoice button ungated (D-12) |
| `/delivery` | Delivery board | none | none | 402→upsell (`featureLockedInfo`) | `/delivery-assignments`→`driver_mode` for driver leg only; `/fulfilment` open | S | consistent |
| `/tables` | Tables | `tables_single_floor` (client:dashboard) | none | loyalty 402 hidden; **Split button ungated** | `/ops/tables` open; `/sessions/:id/split` **open** (D-07) | S | |
| `/kot` | Kitchen (KOT) | `kds` | none | none | `/ops/kot/`→`kds` | S | Starter has kds; nav==server |
| `/kds` | KDS | `kds` | none | none (silent empty on 402) | `/kds/`→`kds` | S | |
| `/captain` | Captain | `captain_mode` | none | none | **none** — page only calls `/ops/tables`; `/captain/` rule matches no route | S | nav-only gate (D-14) |
| `/reservations` | Reservations | `reservations` | none | none (silent empty) | `/reservations`,`/wait-list`→`reservations` | G | |
| `/reservation-widget` | Booking widget | `reservations` | none | static embed code, no API | n/a | G | |
| `/qr-codes` | QR codes | `qr_ordering` | none | none | **none** — `/qr-codes` rule matches no route; page uses `/ops/tables/:id/qr`, `/ops/qr/settings` | S | nav-only (D-14) |
| `/menu` | Menu / Catalog | `menu_basic` (client:dashboard) | none | **yes**: `plan.has('menu_variants_modifiers')` locks variants section + skips 402 calls (`MenuPage.tsx:584-712`) | `/variants`,`/modifier-groups`→`menu_variants_modifiers`; `/menu` open | S | best-practice example in the codebase |
| `/modifier-groups` | Modifier groups | `menu_variants_modifiers` | none | 402→lock card (`:234-262`) | `/modifier-groups` rule | S | |
| `/inventory` | Inventory | `menu_basic` | none | none | none | S | mobile gates on `inventory_tracking` (P) — D-13 |
| `/ingredients` | Ingredients | `recipe_costing` | none | 402→"paid add-on" card | featureGate `recipe_costing` **AND** `requireAddon('recipe-costing')` without orFeature | P | **D-02** — Pro/Adv/Ent blocked |
| `/wastage` | Wastage | `wastage` | none | none (silent empty) | `/wastage` rule | G | |
| `/reports` | Reports / Money | `reports_basic` (client:dashboard) | none | none | staff perms only | S | client key, nav-only |
| `/leakage` | Revenue leakage | `reports_basic` | none | none | perm | S | |
| `/invoices` | Tax invoices | `invoice_basic` (client:dashboard) | none | none; `GET /einvoice` fires for all plans (D-12) | perm `tax_invoices`; `/einvoice`→`einvoice_gst` | S | client key, nav-only |
| `/refunds` | Refunds | `orders` | none | none | none | S | |
| `/expenses` | Expenses | `expenses` (client:dashboard) | none | none | perm | S | client key, nav-only |
| `/daily-closing` | Daily closing | `daily_closing` | none | 403 (manager) handled; 402 silent | `/daily-closing` rule | S | |
| `/accounting` | Accounting | `accounting_pnl_bs` | none | none (silent) | `/accounting/` rule | A | |
| `/accounting-reports` | P&L reports | `accounting_pnl_bs` | none | none | `/accounting/` rule (P&L, BS, TB, seed-coa) | A | |
| `/bank-reconcile` | Bank reconcile | `bank_reconcile` | none | none | `/bank/` rule | E | |
| `/recurring-invoices` | Recurring inv | `recurring_invoices` | none | **placeholder page, no API** | rule matches nothing; no routes | A | **D-01 P0** |
| `/b2b-invoice-template` | B2B template | `b2b_invoice` (client:dashboard) | none | none; writes receipt template | `PUT /bill-template`→`requireFeature('custom_branding')` | P (page) / E (save) | **D-04** |
| `/surge` | Surge pricing | `surge_pricing` | none | none (silent) | `/surge/` rule | A | |
| `/customers` | Customers / Customers | `null` + **addon `loyalty`** | none | 402→addon upsell | `requireAddon('loyalty',{orFeature:'loyalty'})` | G (feature) | **D-05** nav stricter than API |
| `/memberships` | Memberships | `memberships` + **addon `loyalty`** | none | none; **gift-card tab broken** | `/memberships` rule only | P | **D-03, D-05** |
| `/reviews` | Reviews | `reviews` | none | none (silent) | `/reviews` rule | P | |
| `/food-coupons` | Coupons | `loyalty` | none | none | **none** (`/food-coupons` unruled) | G (nav) / S (API) | D-14 |
| `/campaigns` | Campaigns | `whatsapp_marketing` | none | none | **none** — `/wa/campaigns` unruled, `/whatsapp` rule dead | G (nav) / S (API) | **D-08** |
| `/online-site` | Online site / Growth | `qr_ordering` | none | none | none (`/site` open) | S | D-14 |
| `/marketplace` | Marketplace | none | none | n/a | `/addons` always open | S | `marketplace_addons` key gates nothing (registry drift, backend) |
| `/aggregators` | Aggregators | `aggregators` | none | error rendered | `/aggregator` rule | P | |
| `/drivers` | In-house delivery | `driver_mode` | none | none (silent) | `/drivers`,`/delivery-assignments` | P | |
| `/forecast` | Forecast | `forecast` | none | none (silent) | `/forecast`,`/upsell` | A | |
| `/heat-map` | Heat map | `heat_map` | none | `.catch(() => [])` swallows 402 → empty chart | `/orders-by-hour` rule | A | |
| `/retail` | Retail | `multi_outlet` | none | none (silent) | `/retail/`→`multi_outlet` | E | key name ≠ label but consistent |
| `/outlets` | Outlets / Team & setup | `multi_outlet` | none | 402→upsell, owner-only UI | `multiOutlet.routes.js` direct check | E | good |
| `/staff` | Staff | `staff_lite` (client:dashboard) | none | **yes**: perm checkboxes disabled when `!plan.has(featKey)` (`StaffPage.tsx:245-267,413`) | none (limits via enforceLimit) | S | client key, nav-only for the page itself |
| `/printers` | Printers | none | none | none | none | S | |
| `/bill-template` | Receipt template | none | none | none — editable form, save 402s | `PUT`→`custom_branding` | S (page) / E (save) | D-11 |
| `/bulk-import` | Bulk import | none | none | error rendered | `/retail/bulk-import`→`bulk_import`; `/menu/bulk`, `/imports/*` open | S | registry label "Bulk menu import" (A) ≠ reality |
| `/migrate` | Switch to NamastePOS | none | none | — | open | S | |
| `/privacy` | Privacy | none | none | — | open (DPDP) | S | |
| `/settings` | Settings | none | none | — | role checks | S | staff see it (D-09) |
| `/help` | Help | none | none | static | — | S | |
| `/billing` | Plans & Billing (bottom) | none | none | uses `p.tier === 'free'` for downgrade (plan code, not a gate) | owner role | S | staff see it (D-09) |
| `/refer` | Refer & earn | none | none | — | open | S | |
| `/support` | Support | none | none | — | open | S | |
| `/onboarding` | (no nav) | — | RequireAuth | — | — | S | |
| `/login`, `/register`, `/qr/:token`, `/track/:token`, `/legal/*` | public | — | — | — | — | — | `/register?plan=` looks up plan by `tier` code for display only — fine |

**Registry `clients: ['dashboard']` keys — is each actually checked?**

| Key | Checked where | Verdict |
|---|---|---|
| `orders` | `Layout.tsx:52,90` nav only | nav lock only; `/orders` route + API open → bypassable (D-10) |
| `expenses` | `Layout.tsx:91` nav only | same |
| `staff_lite` | `Layout.tsx:152` nav; `StaffPage` uses `has()` for perm keys (not for the page) | nav lock only for the page |
| `menu_basic` | `Layout.tsx:72,79` nav only | same |
| `tables_single_floor` | `Layout.tsx:60` nav only | same |
| `reports_basic` | `Layout.tsx:87,88` nav; `StaffPage` perm map | nav lock only |
| `invoice_basic` | `Layout.tsx:89` nav; `StaffPage` perm map | nav lock only |
| `b2b_invoice` | `Layout.tsx:97` nav only | nav lock only, and the page behind it is broken (D-04) |

All 8 are "checked" in the sense the registry audit wants (a string match exists), but because no route/page enforces them the check is a lock icon — the registry's own definition of a fake gate ("a key nothing enforces at all is a promise the product does not keep"). Registry note for `customers_basic` ("dashboard does NOT gate its customers page on this key") is accurate.

Keys with a dashboard page but **no dashboard key check anywhere** (nav or page): `bill_split` (Split button), `voice_pos` (mic), `einvoice_gst` (button + list fetch), `custom_branding` (receipt template form), `inventory_tracking`, `auto_whatsapp_order`, `dead_stock` (no page), `tds_tcs` (no page), `multi_currency_fx` (no page).

---

## 4. Tier-code trap

Grep `'pro'|'free'|'basic'|'pro_plan'|'advanced'|tier|isEnterprise|isPro|isStarter|atLeast(` across `src`:

- `lib/planTiers.ts` — display-only mirror of the ladder with the correct `pro`=Growth-kind / `pro`=Enterprise-code warning. OK.
- `Layout.tsx:345-349` — `tierLabel`, `isStarter` ("→ upgrade" hint), `isEnterprise` (hide "View plans"). Display only. OK.
- `BillingPage.tsx:296,405` — `tier === 'free'` / `changePlan('free')`: selects the Starter **plan code** for downgrade and to skip the Razorpay consent popup; not an entitlement decision, and the consent skip is also guarded by `res.manual || !res.subscriptionId`. Acceptable; it does hardcode Starter's code `'free'` (P3 nit, would break if the Starter row's tier code ever changed).
- `BillingPage.tsx:804,917` — `sub.plan.tier === p.tier` "Current" badge. Display. OK.
- `lib/activation.ts:278-294` — analytics only. OK.
- `RegisterPage.tsx:96` — `p.tier === planTier` for the trial reassurance strip. Display. OK.
- `CustomersPage.tsx:148-162`, `CustomerDetailDrawer.tsx:274` — `c.tier` is the **customer loyalty tier** (gold/silver), unrelated. OK.
- `usePlan.isPro = tierAtLeast(kind,'pro')` is exported but **unused** anywhere. No UI decision is made on a tier code. **No tier-trap findings.**

---

## 5. Auth security

| Check | Result |
|---|---|
| Access token not in localStorage | ✅ In-memory `accessToken` (`client.ts:60`); `setSession` purges legacy `ff_dash_token`/`ff_dash_refresh`; `bootstrapAuth()` mints from httpOnly `ff_refresh` cookie (`client.ts:105-165`); `App.tsx:104-106` holds routes until bootstrap resolves. `window.__ffGetToken` is DEV-only. |
| Impersonation handoff | ✅ `#impc=` one-time code exchanged server-side, hash stripped before the network call; legacy `#imp=<jwt>` path still accepted (`client.ts:130-142`) — consider removing once admin is on NP-126 (P3). |
| CSRF | ✅ Not needed for the dashboard: every mutation carries `Authorization: Bearer` and `middleware/csrf.js:44-50` exempts Bearer requests; `/auth/refresh` and `/auth/logout` (Bearer) are exempt/covered. `X-Auth-Mode: cookie` set. Sentry scrubs `x-csrf-token`/cookies. |
| Logout clears state | ✅ `Layout.tsx:220-235`: server revoke first (while Bearer present), `setSession(null)`, `setBusinessCache(null)`, `queryClient.clear()`. `exitImpersonation` same order. |
| Outlet switch isolation | ✅ `useOutletSwitch.ts`: token swap + `clearBusinessScopedStorage(prevId)` + `queryClient.clear()`. |
| Staff-permission UI hiding | ❌ **D-09** — none on web. |
| Super-admin read-only in impersonation | Server-enforced (`requireStaffPerm` GET-only for impersonators). Dashboard shows `ImpersonationBanner` but does not disable mutation buttons — acceptable (server 403s). |
| Secrets in repo | `.env.local` is git-ignored (`.gitignore:6`), only `VITE_GOOGLE_CLIENT_ID` (public). OK. |

---

## 6. Endpoint cross-check (dashboard → backend)

Script matched 243 `api.<method>(path)` calls in `src/**` against 474 backend routes (mounts from `app.js`, nested `router.use(require(...))` in `sprintsAll/finalSprint/sprint1Extras` expanded). Unmatched after removing false positives (dynamic `${format}`/`${report}` suffixes and the `/plans` top-level mount, all of which exist):

- `POST /businesses/:id/gift-cards/:code/redeem` — **does not exist** (D-03e; unused helper).

Response-shape check (`.then(r => r.data.<key>)` vs `res.json({<key>})` for routes defined inline): one mismatch — `listGiftCards` (D-03a). Controller-backed routes not covered by the heuristic.

---

## 7. Toolchain

- `npx tsc --noEmit -p .` → **EXIT=0**, no errors.
- `npx eslint src` → **EXIT=2**, `ESLint couldn't find a configuration file` — no `.eslintrc*`/`eslint.config.*` in the package; `npm run lint` is broken and CI does not run it for the dashboard (D-17). `grep -c " error "` = 0 only because nothing was linted.

---

## 8. Suggested order of fixes (dashboard side)

1. D-03 gift cards (wire to `payments.routes.js` shapes) — 30 min, money feature.
2. D-05 nav `/customers` & `/memberships` addon gates — 5 min, stops upselling paid customers.
3. D-06 gate `VoiceCommand` on `voice_pos` + registry `clients: ['mobile','dashboard']`.
4. D-10 `RequireFeature` route wrapper + single `402 FEATURE_LOCKED` interceptor; then D-11/D-12/D-07 button gates fall out of `plan.has()`.
5. D-09 staff nav filtering from `me.permissions`.
6. D-04 B2B template — decide: own storage or remove page + key from cards.
7. D-01 recurring invoices — product decision; at minimum pull the key from Advanced/Enterprise cards and replace the placeholder text.
8. Backend (hand to backend reviewer): D-02 `orFeature`, D-07 `/split` rule, D-08 `/wa/` rule, dead featureGate rules, `bulk_import` label/claim.
