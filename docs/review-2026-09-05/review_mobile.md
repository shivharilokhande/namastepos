# Mobile app review — `namastepos_flutter/` (2026-09-05)

Reviewer scope: Flutter tenant app (Android-first + iOS). READ-ONLY. Verified by reading code, tracing call sites with grep, running `flutter analyze` + `flutter test` on the Mac, and comparing against backend `featureRegistry.js` / `featureGate.js` / `staffService.js` and the live `/v1/public/plans` feed.

## 0. Gates

| Gate | Result |
|---|---|
| `flutter analyze` (Flutter 3.44.0 stable) | **EXIT=0, 0 errors**, "No issues found" |
| `flutter test` | **EXIT=0, 92/92 passed** (entitlements_test, plan_version_watcher_test, voice_order_parse_test, telemetry_test, error_humanizer_test, connectivity_banner_test, widget_test) |

## 1. Entitlement model — verdict: sound, one bypass, one slug≠key regression

Verified (read code):
- `PlanInfo.unknown()` → `loaded=false`, empty set; `has()` = `loaded && contains` → **unknown / unloaded / failed-fetch / absent key all DENY** (`plan_info.dart:72,82`). `AuthProvider.has()` delegates (`auth_provider.dart:134`). `PlanGate` + `PlanGate.tile` + `PlanGate.allows` all go through it; tiles render nothing until `entitlementsKnown` (`plan_gate.dart:104`).
- `/auth/me` refresh: login paths (`_hydrateAfterLogin` + `signInWithPin` extra `refreshPlan`), cold-start `_bootstrap` when role/plan unknown, MPIN unlock, app resume (`home_screen.dart:186`), HomeScreen first frame (`:223`), Marketplace activation/pay-success/cancel (`marketplace_screen.dart:150,205,269`), Billing change-plan/pay/refresh (`billing_screen.dart:255,362,436`). Sign-out resets plan to `unknown()` and clears `UpsellHints` (NP-114).
- `X-Plan-Version`: read on **every** response AND every error in the single dio interceptor (`api_service.dart:167-176`), fed to `PlanVersionWatcher.note()` (first header seeds baseline, dedup, in-flight guard, malformed ignored, reset on `clearTokens`). Fires `AuthProvider.refreshPlan()` (not `IfStale`) — correct.
- 5-min poll backstop: `Timer.periodic(5 min)` → `refreshPlanIfStale()` (`entitlementMaxAge` 2 min) in HomeScreen, which is mounted for the whole session. `new_order_screen` also calls `refreshPlanIfStale()` on open.
- 402 handling: `_wrap` converts to `ApiException(message, 402)`; `humanizeError` maps 402 → backend message or "not in your current plan. Open Marketplace" (`error_humanizer.dart:88`). Interceptor caches `requiredTierLabel` from the 402 body (`_maybeRememberUpsell`) so PlanGate's lock screen names the server's plan, never a client guess. No crash path found; the one raw-payload leak is captain_screen (P3 #9). Note: 402 snackbars carry **no CTA** to Billing (P3 #11).
- Tier-code trap: no UI decision on a tier code. `'pro'/'starter'/...` appear only in `billing_screen.dart:66-77` (card colours/taglines keyed by **tierKind** from the server payload — display only), analytics (`tier != 'free'` for funnel event only) and comments. `Plan.isFree` (`models/subscription.dart:26`) is an unused tier-code getter — delete (P3 #13).

## 2. Findings

| # | Sev | Where | Evidence | Why wrong | Fix | Verified |
|---|---|---|---|---|---|---|
| 1 | **P1** | `lib/screens/pos/confirm_order_screen.dart:149-150` | `final hasLoyalty = context.read<SubscriptionProvider>().hasAddon('loyalty'); if (!hasLoyalty) return;` — `hasAddon` = `business_addons` row with slug `loyalty` (`subscription_provider.dart:29`). Backend `getMyAddons` returns only purchased addons. | Slug≠key regression (same class as the 2026-09-03 audit). `loyalty` is a **plan** feature on Growth/Pro/Advanced/Enterprise (live feed) — a tenant who has it via plan but never bought the marketplace addon gets **no customer attach (`customerId` line 513), no points redemption, no wallet tender, no membership offer** at Pay & Place. Captain settle path (`captain_screen.dart:811`) does the same lookup unconditionally, so the two checkouts disagree. Also Marketplace never reloads `SubscriptionProvider` after activation (`marketplace_screen.dart` has no `SubscriptionProvider` ref), so even the addon path stays stale until app resume. | Gate the lookup on `auth.has(Features.customersBasic)` (customer attach) and loyalty-only bits on `auth.has(Features.loyalty)`; remove `hasAddon('loyalty')`; call `SubscriptionProvider.load()` after addon activation. | Read code + backend `addonService.js`, migration 074 (`grants_features='{loyalty,customers_basic}' WHERE slug='loyalty'`). |
| 2 | **P1** | `lib/providers/orders_provider.dart:325,435`; `lib/services/repositories.dart:239`; `lib/models/menu_item.dart` (no gst field); `lib/screens/pos/confirm_order_screen.dart` (zero occurrences of `tax`) | POS sends `'tax': tax` where `tax` defaults `0`; items carry no `gstPct`; `MenuItem` has no GST slab; confirm screen has no tax line; receipt/thermal print `if (order.tax > 0)` never fires. Backend `orderService.js:863` — with `ORDER_TAX_ENFORCE=log` (default, still pending per memory) the client value is accepted. | Every mobile order for a regular-scheme GST restaurant is recorded **tax-free** today. When Render flips to `enforce`, the server will **add** menu GST on top (`total - clientTax + serverGst`, line 892) so the recorded total exceeds the cash the cashier actually collected, and the phone-printed receipt (built from the LOCAL order, `repositories.dart` returns `order` not the server row) will not match the server invoice. "GST calc mirrors backend" — there is no GST calc on mobile at all. | Add `gstPct` to `MenuItem.fromBackend` (menuService already serialises it), port `computeGstBreakdown` (bucket by pct, ×pct/100, CGST/SGST halves, round2) to Dart, send `gstPct` per item + `tax`, show the Tax/CGST/SGST rows on confirm + receipt; for the online path print from the server's returned order. Composition scheme: honour `business.gstScheme` (already on `Business`). | Read code (mobile + backend `orderService.js:776-905`, `gstService2.js`). |
| 3 | **P2** | `lib/screens/invoices/tax_invoices_screen.dart` (no `auth.has`/`PlanGate`); `lib/screens/reports/register_reports_screen.dart:170,378,447,709` | `tax_invoices` is a `clients:['mobile']` registry key. Only gate is the drawer tile `_can('tax_invoices') && auth.has(Features.taxInvoices)` (`home_screen.dart:663`). `RegisterReportsScreen` (gated on **`registers`**) has an "Invoices" tab that calls `listTaxInvoices` and pushes `TaxInvoiceDetailScreen` (PDF/cancel). | Second entry point under a different key. On the live ladder `registers` and `tax_invoices` travel together (Pro+), but custom plans / overrides / addon grants can split them → key not honoured by the named client. Also inconsistent with the destination-gate pattern already applied to P&L and Registers. | Destination-gate `TaxInvoicesScreen` + `TaxInvoiceDetailScreen` on `Features.taxInvoices`; hide/lock the Invoices tab on the same key. Update `kMobileSurfaces` note. | Grep + read. |
| 4 | **P2** | `lib/screens/orders/order_detail_screen.dart:240-252` | `if (order.customerPhone != null) ... ElevatedButton 'WhatsApp' → notifyOrderReady(order)` — no `order.source != OrderSource.dineIn` check (file has zero `dineIn` refs), no `auth.has(Features.autoWhatsappOrder)`. | Violates founder rule "no WhatsApp action on dine-in orders" (correctly applied in `orders_screen.dart:238` and `confirm_order_screen.dart:344`). Not plan-gated either; `kMobileSurfaces[autoWhatsappOrder]` lists 3 files, not this one. | Wrap in `order.source != OrderSource.dineIn && auth.has(Features.autoWhatsappOrder)` (or document manual wa.me as ungated-by-design and keep only the dine-in guard). | Read code. |
| 5 | **P2** | `lib/widgets/plan_gate.dart:128` vs `lib/screens/home/home_screen.dart:294-305` | `PlanGate.tile.onTap` → `Navigator.of(ctx).pop();` then `onTap()`. HomeScreen's own comment (CRASH FIX 2026-08-23): `Navigator.pop` on a drawer tile double-tap popped the ROOT route → black screen on "Driver (delivery)"; fixed there with `_closeDrawer()`. | The fix was never applied to `PlanGate.tile`, which every plan-gated drawer tile (Captain, Driver, KDS, Modifiers, Reviews, Reservations, Inventory, Wastage, Daily closing, Memberships, Coupons, Surge, QR, Bill template) uses. Callers' `_closeDrawer()` runs *after* the pop and is a no-op. | Replace with `homeScaffoldKey.currentState?.closeDrawer()` (or `Scaffold.maybeOf(ctx)?.closeDrawer()`). | Code-traced; runtime double-tap **unverified**. |
| 6 | **P2** (RBAC) | `lib/screens/home/home_screen.dart:277-283`; `lib/utils/role_permissions.dart:52-59`; backend `staffService.js:91-96` | `_screensFor`: `hasHome ? DashboardScreen` for any non-kitchen staff. `staff_captain`/`staff_waiter` default perms include `home`. DashboardScreen renders today's revenue, expenses, profit, margin %, cash-in-drawer, and Add-expense / Expenses quick actions. Backend comment: "Captain → NO reports / no invoices / no P&L". | Money KPIs leak to captains/waiters (computed client-side from `OrdersProvider`, so no server 403 stops it). NP-201 fixed the kitchen case only ("captain/waiter are unaffected"). Fail-closed intent not met for these roles. | Land non-owner users on `DashboardScreen` only when `canSeeMoney` (reports/pnl/register perms); otherwise POS or `_WelcomeFallback`. Hide Expense quick actions unless `canDo('expenses')`. | Read code. |
| 7 | P3 | `lib/screens/home/dashboard_screen.dart:283-327`; `lib/screens/menu/menu_editor_screen.dart:446-605`; `lib/screens/settings/settings_screen.dart` "Low stock alerts" | Stock / reorder-level / trackStock fields, low-stock alert list and toggle are shown on Starter/Growth, which lack `inventory_tracking`. | Registry note says stock endpoints are intentionally open, so not a gate bug — but the *product* "Inventory tracking" is partially visible on plans that do not include it. Product decision, flagging for clarity. | Either accept and note in `kMobileSurfaces`, or hide reorder-level/low-stock UI on `!has(inventoryTracking)`. | Read code. |
| 8 | P3 | `lib/utils/role_permissions.dart:41-68` vs backend `staffService.js:75-104` | Mobile fallback `_MAP`: manager lacks `pnl_statement, income_register, invoice_register, tax_invoices, aggregators, whatsapp_marketing, auto_whatsapp_order, thermal_printer`; cashier lacks `tax_invoices, invoice_register`. | Code comment says the two tables "must not disagree". Only used when server sends no list (offline first frame), so low impact. | Sync the map (or generate from a shared JSON). | Diffed. |
| 9 | P3 | `lib/screens/captain/captain_screen.dart:458-467` | `hint = 'HTTP ${e.response?.statusCode} · ${e.response?.data}'` shown in a SnackBar. | Dumps raw backend JSON to the cashier — violates the FF-220 humanizer convention every other screen follows. | `humanizeError(e)`. | Read code. |
| 10 | P3 | `lib/screens/pos/confirm_order_screen.dart:115-131` | `_loadSurge` GETs `/surge/current` on every checkout; featureGate rule `/surge/` → 402 for every plan below Advanced. Swallowed. | One guaranteed 402 per bill on Starter/Growth/Pro; also pollutes `UpsellHints` with `surge_pricing`. | `if (!auth.has(Features.surgePricing)) return;` | Read code + featureGate rule. |
| 11 | P3 | `lib/utils/error_humanizer.dart:88`, all screens | 402 renders as a plain SnackBar string. | No "View plans" action — the upgrade prompt exists only where PlanGate is used pre-emptively. | Add a SnackBarAction → `BillingScreen` for `statusCode == 402` in a shared helper. | Read code. |
| 12 | P3 | `lib/screens/reports/reports_screen.dart:154-172`, `monthly_report.dart:120-142` | KPI cards push `RegisterReportsScreen.income/expense` and `IncomeStatementScreen` with the plan gate only; no `_can('income_register')`/`_can('pnl_statement')`. | Cashier (perm `reports`, no `pnl_statement`) taps Profit → server 403 → error state instead of a hidden/locked card. Server enforces; UX only. | Mirror the drawer's `_can(...)` checks. | Read code. |
| 13 | P3 | `lib/models/subscription.dart:26`; `lib/models/plan_info.dart:83` | `bool get isFree => tier == 'free'` (unused); `PlanInfo.unknown()` reports `tierKind:'starter'`, and `main.dart:138` feeds `auth.plan.tierKind` to analytics identity. | Tier-code temptation left in the model; analytics attribute "starter" while entitlements are actually unknown. | Delete `isFree`; make `tierKind` nullable / `'unknown'` when not loaded. | Read code. |
| 14 | P3 | `lib/screens/home/home_screen.dart:284-291` | `_MinimalMoreTab` for **all** non-owner roles (comment says "for Kitchen"). | `staff_manager` cannot reach Settings (Business info, Aggregators toggle, Printing) on mobile despite having those perms server-side. | Give manager the real `SettingsScreen` (it already filters by `auth.has`). | Read code. |
| 15 | P3 | `lib/providers/orders_provider.dart:478-483` | Comment: "mobile generates the local UUID, backend mints a new one on insert". | Stale — order id = clientId since the offline-sync fix; misleading for the next reader. | Fix comment. | Read code. |

Nothing found at P0. The 14 fail-open gates fixed on 2026-09-05 have not regressed (all 14 call sites present; `entitlements_test` asserts them).

## 3. MOBILE FEATURE MATRIX (screen → entry point → key)

Legend: **Key gate** = plan key checked (`auth.has` / `PlanGate`). **Locked UI** = what a tenant without the key sees. **Server** = backend enforcement per registry. "hidden" = tile not rendered; "lock+badge" = tile with UPGRADE badge → BillingScreen; "dest-gate" = the screen itself refuses to render.

| Screen (lib/screens/…) | Entry point(s) | Staff perm | Key gate | Locked UI | Server | Notes |
|---|---|---|---|---|---|---|
| home/home_screen (drawer + tabs) | root | role/perms | per tile (below) | — | — | Only owner sees Staff, Floors&tables, Printers, Marketplace, Billing, Refer, FeatureTour |
| home/dashboard_screen | Home tab | `home` | KPI taps → `pnl_statement` (falls back to MonthlyReport); Tables quick action → `captain_mode` | fallback / hidden | `pnl` = client key | **#6**: captain/waiter see money KPIs |
| pos/pos_screen → pos/new_order_screen | POS tab, dashboard "New Order", captain add-items | `pos` | mic: `voice_pos` AND device probe (`new_order_screen.dart:43,106,118,273,522`) | mic hidden | client key | Voice: probe skipped when unentitled; re-checked on tap/long-press; IDF matching in `voice_order_service.dart` (tests pass) |
| pos/item_config_sheet | from NewOrder | — | variants/modifiers come from menu payload | — | `/variants` route-gated | data-driven, no client gate needed |
| pos/confirm_order_screen | from NewOrder | — | auto-WhatsApp: `auto_whatsapp_order` + settings toggle + not dine-in; membership offer dialog: `memberships`; loyalty lookup: **`hasAddon('loyalty')` (#1)**; surge: none (#10) | — | `/surge/` route, `/customers/lookup` role-gated | **No GST (#2)**; `_saving` re-entry guard first statement (OK) |
| orders/orders_screen | Orders tab | `orders` | auto-WhatsApp on ready: `auto_whatsapp_order`; IRN action: `einvoice_gst` (`:422`) | action hidden | `/einvoice` route | dine-in skipped (OK) |
| orders/order_detail_screen | from Orders | `orders` | refund: owner/role check `:260`; **WhatsApp button: none (#4)** | — | server | print → BT on Android / share-PDF on iOS |
| orders/refunds_screen | drawer | `orders` | none (baseline) | — | server perms | |
| captain/captain_screen | drawer tile, Tables tab (`_CaptainTab`), dashboard quick action | `captain`/`tables` | `captain_mode` at all 3 doors (`home_screen:551,1028`, `dashboard:195`) + tab filtered in `planAwareVisibleTabs` | hidden / dest-gate | `/captain/` route | Split button: `bill_split` (`:653`) |
| tables/bill_split_screen | captain Split | — | `bill_split` (caller) | hidden | `/bill-split` route | |
| tables/tables_editor_screen | drawer "Floors & tables" (owner) | owner | none — `tables_multi_floor` **ungatedByDesign** | — | ungated (registry) | Starter (single-floor key only) can add floors — documented gap |
| tables/tables_screen | Settings→Tables | owner | none | — | — | legacy |
| kitchen/kds_screen | drawer tile, Home tab for kitchen (`_KitchenTab`) | `kds` | `kds` both doors (`home_screen:565,1090`) | hidden / dest-gate | `/kds/`,`/ops/kot/` route | |
| delivery/delivery_board_screen | drawer | `orders` | none (deliberate — `/fulfilment/*` has no server rule) | — | ungated | not driver_mode/aggregators — OK |
| driver/driver_screen | drawer tile → driver picker | `driver` | `driver_mode` (`:558`) | hidden | `/drivers` route | picker sheet handles 403 |
| customers/customers_screen | drawer, Settings→Customers | `customers` | `customers_basic` **dest-gate** (`:40,66`) | in-screen message | client key | both doors covered |
| customers/customer_detail_screen | from Customers | — | wallet card: 402→hidden; memberships: `memberships` (`:598,644`) | hidden | `/memberships` route | |
| menu/menu_editor_screen (+ edit_item) | drawer, Settings→Menu, Inventory | `menu_editor` | variants block + modifier attach: `menu_variants_modifiers` (`:666,973,1005`) | hidden + hint on 402 | `/variants` route | stock fields ungated (#7); **no GST slab field (#2)** |
| menu/modifier_groups_screen | drawer | `modifier_groups` | `menu_variants_modifiers` (tile + in-screen 402 copy) | hidden | route | |
| menu/menu_template_screen, menu_paste_screen | editor, setup wizard | owner/manager | none (baseline menu) | — | `/menu/bulk` | |
| menu/menu_screen | legacy (unreferenced from drawer) | — | — | — | — | EditItemScreen only from here |
| inventory/inventory_screen → item_detail_screen | drawer tile only | `inventory` | `inventory_tracking` (`:745`, lock+badge) | lock+badge | client key | single entry point — OK |
| invoices/tax_invoices_screen (+ TaxInvoiceDetailScreen) | drawer tile; **Registers→Invoices tab (#3)** | `tax_invoices` | `tax_invoices` at drawer only (`:663`); **not at destination** | hidden | client key | **bypass #3** |
| reports/reports_screen | Reports tab | `reports` | none (baseline `reports_basic`) | — | — | KPI taps ignore staff perms (#12) |
| reports/monthly_report | Reports→Monthly | `reports` | none; KPI taps → dest-gated screens | — | — | |
| reports/income_statement_screen | drawer, dashboard, Reports, Monthly | `pnl_statement` (drawer only) | `pnl_statement` **dest-gate** (`:129`) | PlanGate lock page | client key | all 4 doors covered |
| reports/register_reports_screen | drawer, Reports, Monthly | register perms (drawer only) | `registers` **dest-gate** (`:170`) | PlanGate lock page | client key | Invoices tab → #3 |
| reports/tip_report_screen | Reports action | `reports` | none | — | — | |
| expenses/expenses_screen, add_expense_screen | drawer, Settings, dashboard | `expenses` (drawer); dashboard unchecked | none (baseline `expenses`) | — | perm-gated server | #6 |
| ops/reservations_screen | drawer | `reservations` | `reservations` (`:632`) | hidden | `/reservations` route | wait-list shares key |
| ops/reviews_screen | drawer | `customers` | `reviews` (`:623`) | lock+badge | `/reviews` route | |
| ops/wastage_screen | drawer | `wastage` | `wastage` (`:758`) | lock+badge | `/wastage` route | no `/ingredients` calls → `recipe_costing` noSurface confirmed |
| ops/daily_closing_screen | drawer | `daily_closing` | `daily_closing` (`:771`) | lock+badge | `/daily-closing` route | |
| ops/coupons_screen | drawer | `memberships` | `loyalty` (`:813`) | lock+badge | **`/food-coupons` has no server rule** | client-only gate on a server-ungated route (backend reviewer: check) |
| qr/qr_codes_screen | drawer | `qr_codes` | `qr_ordering` (`:830`) | hidden | `/qr-codes` route | |
| settings/back_office_screens: MembershipsScreen (+ members_screen) | drawer | `memberships` | `memberships` (`:797`) | lock+badge | `/memberships` route | fixed from `loyalty` today |
| settings/back_office_screens: SurgeRulesScreen | drawer | `surge` | `surge_pricing` (`:822`) | hidden | `/surge/` route | |
| settings/back_office_screens: BillTemplateScreen | drawer | `bill_template` | `custom_branding` (`:858`) | lock+badge | `requireFeature('custom_branding')` | |
| settings/back_office_screens: ImageUploadScreen | from BillTemplate/editor | — | none | — | `/uploads` | |
| settings/settings_screen | More tab (owner only; staff get `_MinimalMoreTab`) | owner | Aggregators row: `aggregators`; Auto-WhatsApp toggle: `auto_whatsapp_order` (`:119-126`) | hidden | `/aggregator` route | #14 |
| settings/aggregators_screen | Settings | owner | `aggregators` (caller) | hidden | route | |
| settings/printer_setup_screen | drawer (owner), Settings, order_detail | owner | none | — | — | BT only when `supportsBluetoothPrinting` (Android); iOS = AirPrint/share |
| settings/business_info_screen, privacy_*, support_screen, refer_screen | Settings / drawer | owner (support: all) | none | — | — | |
| staff/staff_screen | drawer (owner) | owner | permission checkboxes shown only for keys the plan has (`reportsBasic, invoiceBasic, menuVariantsModifiers, reservations, wastage, dailyClosing, kds, captainMode, driverMode, surgePricing, qrOrdering, aggregators, whatsappMarketing, autoWhatsappOrder`) | checkbox hidden | `plans.limits.staff` | |
| marketplace/marketplace_screen | drawer (owner) | owner | none — `/addons` exempt on server by design | — | exempt | refreshPlan after activate ✔; SubscriptionProvider not reloaded (#1) |
| billing/billing_screen, trial_expired_screen | drawer, PlanGate CTAs, banners | owner | none | — | — | tierKind used for colours/taglines only |
| auth/* (login, register, otp, pin_login, mpin_lock, onboarding), splash, onboarding/setup_wizard | pre-auth | — | none | — | — | MPIN: persistent fail counter; PIN login hydrates role from /auth/me before first frame |

### Registry `clients:['mobile']` keys — verdict

| Key | Checked at every entry point? | Second entry point bypass? |
|---|---|---|
| `inventory_tracking` | Yes (drawer tile; only door) | No — but stock fields/low-stock UI visible regardless (#7, product) |
| `voice_pos` | Yes (mic draw, probe, tap, long-press) | No other voice surface (grep `VoiceOrderService` = new_order_screen only) |
| `customers_basic` | Yes (destination gate covers drawer + Settings) | No |
| `registers` | Yes (destination gate covers drawer + Reports + Monthly) | No |
| `pnl_statement` | Yes (destination gate covers drawer + dashboard×3 + Reports + Monthly) | No |
| `tax_invoices` | **No** — drawer only | **Yes** — Registers→Invoices tab (#3) |

### Route-enforced features with mobile screens — hide vs rely on 402

Hidden without key (tile not drawn): captain_mode, driver_mode, kds, menu_variants_modifiers, reservations, qr_ordering, surge_pricing, aggregators, auto_whatsapp_order, einvoice_gst (IRN action), bill_split, memberships (in customer detail).
Locked tile with UPGRADE badge → Billing: reviews, inventory_tracking, wastage, daily_closing, memberships, loyalty (Coupons), custom_branding.
Rely on server 402 only: none of the drawer surfaces; incidental calls that 402 silently: `/surge/current` on checkout (#10), wallet (`walletFor` → null → hidden), `listReviews`.
No mobile surface (confirmed by grep of API paths): customers_crm, b2b_invoice, recipe_costing, multi_outlet, accounting_pnl_bs, recurring_invoices, bank_reconcile, heat_map, forecast, dead_stock, bulk_import, api_access, white_label, tds_tcs, multi_currency_fx, dashboard_access, marketplace_addons (`/marketplace` never called), whatsapp_marketing (wa.me deep link only).

## 4. RBAC (fail-closed) — verdict

- `AuthProvider.role` defaults to `''` → `RolePerms.can` denies; owner branches compare literal `'business_owner'`. `/auth/me` `permissions:null` drops the cached list (never widens). Kitchen (`home,kds`) lands on KDS board, drawer shows only Kitchen/Support/Sign out, More tab is minimal. **Kitchen cannot reach owner screens** — verified.
- Gap: captain/waiter dashboard money KPIs (#6); Reports KPI taps ignore perms (#12); fallback map drift (#8); manager loses Settings (#14).
- Server-side `requireStaffPerm('pnl_statement'|'tax_invoices')` correctly treated as staff perms (`_can(...)`) AND separately as plan keys (`auth.has(...)`) at the drawer.

## 5. Correctness spot-checks

| Area | Result |
|---|---|
| Offline order sync | Order id = client UUID (`repositories.dart:214-220`), sent as `clientId` body + `Idempotency-Key` header; outbox `_maxAttempts=50`, permanent 4xx → immediate dead-letter (kept, surfaced via `deadLetterCount`), 401 stops batch without burning budget, 409 in-flight retried, drain mutex, reachability probe, signed-out skip, post-login drain. Sound. (Comment drift #15.) |
| Double-submit | `confirm_order._submit` guard is first sync statement; driver picker re-entry guard; wallet/points/coupon/split forced online with stable clientId. OK. |
| Money display | `AppFmt.money`/`inr2`; backend paise handled server-side; `priceInr` doubles on plan feed. No paise→rupee bug found in reviewed screens. |
| GST | **Absent on mobile (#2).** |
| Keychain migration | `main.dart:201-218` iOS-only one-time `deleteAll` under new accessibility, flag `ff_keychain_scheme_v2`, runs before any storage read. OK. |
| MPIN/PIN | Lock state preserved on stray 401 (`_onAuthExpired` only when authenticated); offline unlock keeps session (FB-02); persistent fail counter. OK. |
| Google sign-in | `signInWithGoogle` → `_hydrateAfterLogin` → `_postLogin`; errors humanised. OK. |
| Addon checkout | Razorpay → `confirmAddonPayment` (server HMAC) → `refreshPlan` + `_load`; 409 treated as success. OK except SubscriptionProvider not reloaded (#1). |
| Voice POS | Plan-gated + device probe + IDF menu matching; 30 parse tests pass. OK. |
| Printing | Android: `print_bluetooth_thermal` + ESC/POS; iOS: `supportsBluetoothPrinting=false` → `Printing.layoutPdf`/share; labels adapt ("Printing" vs "Thermal printer"). OK. |
| Founder nav rules | `canPop`: 3 uses, all behavioural (drawer-open path, back button, upload-picker pop) — none gate widget visibility. ListView-in-AlertDialog: none (membership dialog's ListView is in a bottom sheet). WhatsApp on dine-in: **1 violation (#4)**. |

## 6. Founder's four questions (mobile)

1. **Working?** Build/lint/tests green. Two real bugs a paying customer will hit: loyalty at checkout requires the addon row, not the plan (#1); mobile bills carry no GST (#2). Plus a latent double-tap crash path in every gated drawer tile (#5).
2. **Registry coverage:** every one of the 51 keys is classified in `kMobileSurfaces` and the test pins it to real call sites. No drift found.
3. **Working on mobile:** all gated screens open and load when entitled; `tax_invoices` has a bypass (#3).
4. **Activate/deactivate per plan:** yes — `/auth/me` on login/resume/purchase, `X-Plan-Version` on every response, 5-min backstop; removal hides tiles within one response or ≤5 min; addition appears likewise. Exceptions: loyalty-at-checkout keyed to addon (#1); addon activations not reflected in `SubscriptionProvider` until resume (#1).
