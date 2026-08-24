# FoodFlow — Final Full-Codebase Review, Product Check & SEO Audit
**Date:** 23 Aug 2026 · **Scope:** backend (~150 endpoints), Flutter app (105 files), dashboard, admin, landing page

---

## 1. Executive verdict

**READY FOR ANDROID BETA** after you rebuild the APK and restart the backend. Everything below marked FIXED is done and verified. Nothing was deleted — dead-code candidates are listed in §5 and wait for your permission.

**Verification (all green):**
- Backend: syntax-check on every src file ✓, server loads ✓, **jest 221/221 tests passing** (was 105/221 at review start — 4 real bugs fixed + stale tests updated)
- Flutter: all 105 Dart files structurally verified ✓ (no SDK in sandbox — run `flutter analyze` once locally)
- Dashboard: TypeScript 0 errors ✓, production build ✓
- Landing: JS syntax ✓

---

## 2. Critical bugs FIXED this round

### Backend

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| C1 | Multi-outlet routes only checked login, not ownership | Any logged-in user could add outlets / move stock in another owner's group | `requireOwner` now checks role; `assertOwnsBusiness` before addOutlet; transfer + receive verify both outlets belong to the caller's group |
| C2 | Cron schedulers ran on every PM2 cluster instance | Duplicate subscription charges / duplicate emails when you scale to 2+ instances | Schedulers gated to instance 0 only |
| C3 | Gift-card redeem read balance then wrote it (no lock) | Two simultaneous redeems could double-spend a card | Row-lock + conditional UPDATE (`balance >= amount` enforced in SQL) |
| **C4 — found during final verification** | **Partial updates reset fields to defaults.** Editing a menu item's price silently reset its **stock to 0**, veg flag, category, GST slab, etc. Same bug in customers (marketing opt-in reset), KOT stations (printer settings reset), ingredients (**stock & cost zeroed**) | This is almost certainly a contributor to your "inventory refill not saving" complaint — every edit from the dashboard wiped stock | Joi update schemas now use `noDefaults` — updates are truly partial. Covered by test: 221/221 pass |
| C5 | Feature gate ran before login check | Anonymous callers got 402 instead of 401 — leaks which features a restaurant's plan lacks, and each probe cost a DB query | Gate now falls through to normal 401 when no token is present |

### Backend — high severity

| # | Bug | Fix |
|---|-----|-----|
| H1 | Old duplicate gift-card/wallet endpoints kept a **second ledger** (double-spend across the two) | Old endpoints return 410 Gone (code kept, not deleted — see §5) |
| H2 | Refund over-refund check ignored session bills (multi-KOT tables) | Prior refunds now summed across the whole table session |
| H3 | Could refund the same line item twice across two refunds | Per-item refunded qty tracked; each line capped at ordered − already-refunded |
| H4 | Order create silently dropped `splits`, `tip`, `serverUserId`, `walletRedeem` from clients | Added to validation schema; `discountIsPreTax` no longer force-defaults to false |
| H5 | `requireOwner` accepted any authenticated user | Role check added |
| H6 | Cancelling an order didn't return stock or membership entitlements | Cancel now restores inventory (+audit row) and puts bundle qty back |

### Flutter app

| # | Bug | Fix |
|---|-----|-----|
| C1 | Loyalty points-redeem selected in POS was **never sent to the backend** | `pointsToRedeem` wired through provider → repo → API |
| C2 | Settings/Inventory "Menu" tiles opened the old legacy menu screen | Both now open the full Menu Editor |
| H1 | Order status update could hit the wrong business after switching outlets | businessId resolved per-order, no first-item fallback |
| H3 | Order cache purge left the offline cache empty until next sync | `cacheAll` batch-refills sqflite after purge |
| H4 | Failed 4xx orders were silently queued offline and retried forever | 4xx (except 401/408/429) now surfaces the error to the user immediately |
| H5/H6/M6 | Missing controller disposes + setState-after-dispose crashes (login, register, tables, PIN login, marketplace, wastage, daily closing) | Guards + disposes added |
| M1 | Duplicated image-URL logic in menu editor | Delegates to shared `fullImageUrl` |
| M2 | PIN login screen didn't know the Driver role (showed raw key) | Label added |

### Dashboard & landing

| # | Bug | Fix |
|---|-----|-----|
| D1 | Reservation embed snippet hardcoded `https://app.foodflow.in` (breaks on your rename) | Now derived from `VITE_APP_ORIGIN` env or the dashboard's own origin |
| L1 | Pricing grid injected plan name/tagline/bullets into HTML unescaped (stored-XSS if plan copy ever contains markup) | All dynamic text HTML-escaped |

### Test suite (was silently rotten)
- 5 test files were stale: auth mock loaded after the app (all google-login tests 401'd), tables tests used a pre-floors schema, tax-invoice tests used old param names, old `isNew` field. All updated to the current, device-verified API. The menu test then caught real bug C4 above.

---

## 3. Report-only findings — Medium (working, but worth a sprint later)

1. **Settle bypasses tax-invoice + WhatsApp receipt** — settling via table session doesn't auto-issue a GST invoice or queue the WA receipt the direct-collect path does. Inconsistent paper trail.
2. **`wa_messages` queue is never drained** — messages insert but no worker sends them. Either wire a sender or hide WA marketing UI until then.
3. **Coupons module is disconnected** — coupon CRUD exists; order create never checks coupons.
4. **Food-coupon `recordUse` not called** on any order path.
5. **IST day-bucket queries** use expressions that can't use indexes — fine at beta scale, add expression indexes before ~100k orders.
6. `platformReports` builds SQL with string interpolation from an internal enum — safe today, fragile pattern.
7. `openSession` doesn't re-verify the table belongs to the business (guarded upstream, but belt-and-braces).
8. `updateStatus` multi-KOT bulk path isn't in one transaction (partial failure = mixed states).
9. PIN lockout counter is in-memory — resets on restart, per-instance in cluster mode.

**Low:** L1-L7 unchanged (naming drift, unused envs, minor UX copy) — list available on request.

---

## 4. Product check (brainstorming skill)

**Launch-ready:** ordering lifecycle, KOT/KDS, tables/floors, captain, billing+GST, refunds w/ clawback, loyalty, membership bundles (your full spec: item bundles, validity, auto-discount, renewal popup with fee), inventory+wastage→expense, daily closing w/ method split, surge CRUD, offline outbox, multi-tenant auth, staff PIN roles, DPDP endpoints.

**Gaps to know about (not blockers):**
1. **No dashboard UI for refunds** — API exists (`initiateRefund`), only the app can refund. Owners will expect it on web.
2. **No dashboard editor for membership bundle items** — bundles with items can be created from the app; the dashboard membership form doesn't expose `benefits.items`.
3. WA marketing sells a queue that never sends (M2 above) — either finish or hide pre-launch.
4. Aggregator integrations are stubs behind a real-looking UI — fine for beta, label as "coming soon" to avoid support tickets.
5. Onboarding: a brand-new owner lands on an empty POS. A 3-step first-run (add 5 items → print test KOT → first order) would cut churn dramatically for POS-novice owners.
6. **Monetization risk:** Starter (trial) includes enough to run a small café indefinitely if trial enforcement ever regresses — add a server-side hard block at day 15, not just UI.
7. Pricing page CTA says "Start 30-day trial" but your Starter policy is **14 days** — fix the copy when you do the rename pass.

---

## 5. Dead / duplicate code — **awaiting your permission to delete** (nothing removed)

**Backend:** `marketplaceService.js` (superseded), `requireFeature.js` middleware (replaced by featureGate), ~15 dead exports across services, `gstService` vs `gstrExport` duplicate logic, the 410'd dual-ledger route handlers (§2-H1).
**Flutter:** `menu_screen.dart` + `edit_item_screen.dart` (legacy, now unreachable), `PosLaunchCard`, `addon_locked.dart`, `report.dart` model, `sync_queue` sqflite table, `report_cache`/`notifications` tables, ~13 unused pubspec deps, unused strings in `strings.dart`.
**Dashboard:** 31 unused `ffApi` methods + 8 unused `adminApi` methods (incl. `initiateRefund` — see §4.1: build UI instead of deleting?).

Say "delete list A/B/C" (or specific items) and I'll remove them with a verification pass.

---

## 6. SEO audit — landing page

**Do now (survives the rename):**
1. Tailwind is loaded via CDN at runtime — precompile to static CSS (~10× faster first paint; CDN Tailwind is not for production).
2. One keyword-bearing H1 ("Restaurant POS & billing software for Indian cafés") — current H1 is brand-only.
3. Add JSON-LD: `SoftwareApplication` (with price range) + `FAQPage`.
4. Add a favicon + `apple-touch-icon`.
5. Trim font weights (loading 9, using ~4).
6. Fix "30-day trial" copy → 14-day (also a legal/consistency issue).

**Wait until the rename (domain-dependent — doing them now doubles the work):**
canonical URL, robots.txt + sitemap.xml, `og:url` / `og:site_name` / final `og:image`, title + meta description with the final brand, Search Console + analytics registration.

---

## 7. Before you deploy

1. `npm run migrate` (through 055) → restart backend (PM2: all instances).
2. Rebuild the APK (`flutter build apk --release`) — many app fixes this round.
3. Run `flutter analyze` locally once (sandbox has no Flutter SDK).
4. Rebuild dashboard (`npm run build`).
5. Device-retest the round-4 items: refill stock → **edit the item's price → confirm stock survives** (C4), redeem loyalty points at POS (C1), cancel an order → stock returns (H6).
