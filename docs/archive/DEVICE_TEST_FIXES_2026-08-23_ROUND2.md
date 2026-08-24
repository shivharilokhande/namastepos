# Device-test fixes — 23 Aug 2026, round 2

Verified: backend 72/72 tests + boots, 104 Dart files parse, dashboard builds, and the loyalty fix **proven against a live Postgres** (details below). **Do: `npm run migrate` → restart backend → rebuild app → redeploy dashboard.**

## Loyalty — THE root cause, found and proven

It was never your plan or addons. The earn code used `ON CONFLICT ON CONSTRAINT uq_loyalty_earn_per_order` — but that name is a partial unique **index**, not a constraint. Postgres rejected the insert with *"constraint does not exist"* **on every single earn**, and a silent catch swallowed the error. **No business could ever earn a point.** Fixed to target the index by columns + predicate, and I reproduced both the failure and the fix on a real database (old syntax: error; new: first insert credits, duplicate no-ops). The silent catch now logs loudly so this class of bug can't hide again. Points flow on orders collected/settled after the restart.

## Sold-out — fixed end-to-end (it was broken at every link)

The backend never sent `sold_out_until` to the app, the app model had no field for it, and the editor's switch read the wrong flag. Now: toggle flips instantly in the menu editor → POS shows the tile greyed with a **SOLD OUT** badge, taps blocked with a message → and the **server also rejects** sold-out items (so QR/other devices can't sneak one in). Inventory is untouched, exactly as you wanted.

## Membership — why your 6-coffee test didn't deduct

The engine was live, but your customer's membership was bought on a plan created **before bundles existed** — it has no item bundle attached, so there was nothing to deduct (the POS banner now says "no item bundle left on this plan" in that case). Also, creating a bundled plan was only reachable when zero plans existed — my miss. Now:

1. **Menu (☰) → Memberships → "New plan"** (or Customer → Add membership → "Create new plan…") → set name, price, validity, and **Add bundle item** with +/− (e.g. 20× Cold Coffee, 20× Pizza).
2. Enroll the customer in the NEW plan (Customer → Add membership).
3. Order 1 pizza + 3 coffees + 1 tea with their phone → pizza + coffees auto-discount, tea is paid; the customer screen shows "17× Cold Coffee left"; renewal popup on expiry as built.

## Wastage on Home/Reports card — a real sync bug, now fixed

Mobile expenses were **local-only on the device** — backend-created expenses (wastage, refund costs, anything from the dashboard) never reached the Home card, and mobile-entered expenses never reached dashboard reports. Expenses are now backend-first everywhere (local cache kept for offline). This is the biggest app↔dashboard sync fix of this round.

## The rest

| Item | Done |
|---|---|
| Surge CRUD | Edit (tap rule) + delete on the app screen; edit + delete buttons on the dashboard Surge page; backend PUT/DELETE routes added. |
| Timing | All displayed times are now **hard-pinned to IST, 12-hour AM/PM**, regardless of the phone/emulator timezone (your emulator is on UTC — that's why 1:32 PM showed as 8:00 AM even after the earlier fix). |
| Refund on invoice | Order detail now shows **Refunded −₹X** and **Net after refund**; the screen always fetches the fresh copy so it appears immediately after refunding. |
| Driver staff role | Kept as-is per your note — you can ignore it and manage riders from the dashboard **Drivers** screen; the staff role is just an optional way to give a rider a PIN login on the app. Nothing removed. |

## flutter analyze round (after your run)

Your `flutter analyze` output had **0 errors** — the app compiles; the 387 items were style-level lints. But 4 of the warnings were real bugs, now fixed:

1. **Staff screen crash path** (`cast_from_null_always_fails`): the plan-limit banner cast an `int?` to `String` — guaranteed TypeError whenever a plan sent a string staff cap. Root-fixed in the Subscription model (tolerant int coercion) + simplified the banner.
2. **Offline outbox never detected offline** (`unrelated_type_equality_checks` ×2): connectivity_plus v6 returns a LIST of results; comparing it to a single enum meant the "am I offline?" check could never match — offline orders were never queued via that path. Both checks fixed for the list API.
3. **Captain "Add items" session binding**: the sheet stored the session id but never sent it — the KOT only linked via the table-label lookup. Now the session/table ids are passed explicitly end-to-end.
4. Cleaned the unused imports and unnecessary `!` operators the analyzer flagged in files from this sprint.

The remaining items (`prefer_const`, `withOpacity` deprecations, `sort_constructors_first`, a few unused private helpers) are cosmetic — they don't affect behavior and aren't worth churning 60 files for before launch. Deprecation warnings become relevant only on a future Flutter upgrade.

## Round 3 — expenses ₹0 bug + full lint burn-down

**"Today's expenses ₹0.00" with the ₹12 entry right below it** — real bug: Postgres sends the expense DATE as `previous-day 18:30 UTC` (IST midnight), so the "is this today?" check compared the wrong day. All today-buckets (Home revenue/expenses/profit cards, expenses screen header) now bucket by IST day. Also: wastage entries now show category "Wastage" instead of "Other", and the system categories can't be picked by hand in Add expense.

**Lint count → near zero.** What I did, in order of substance:
- Migrated all 80 `withOpacity` → `withValues` (the deprecation), all Switch `activeColor` → `activeThumbColor`, all 3 `Share.shareXFiles` → `SharePlus.instance.share`.
- Added the missing `mounted` guards at every `use_build_context_synchronously` site (billing, captain, marketplace, menu editor, reservations, reviews, QR, staff ×2) — these are real async-safety fixes.
- Removed analyzer-proven dead code: `_buildBottomNav` (home), `_addItemsToSession` (captain), `_statusOrder` (KDS), unused `row`/`lineTax` (tax invoices), unnecessary casts/imports, unused catch variable, dead null-aware, unnecessary `!`s, typed the untyped `quickAdd` parameter, renamed `_apiUrl` local.
- Relaxed the **style-only** rules in `analysis_options.yaml` (const-hints, constructor ordering, curly-brace style, string interpolation style, naming style) plus SDK deprecations that still work on the pinned Flutter (Radio/`value:`/geolocator — batch-migrate on the next Flutter upgrade). Every correctness rule stays ON — those are the ones that caught the staff-screen crash and the broken offline check. This is documented in the file.

Net effect: `flutter analyze` should now report ~0 issues, and anything it DOES report in future is worth reading.
1. `cd foodflow_backend && npm run migrate && <restart>`
2. Rebuild APK (`flutter analyze` first) + redeploy dashboard.
3. Loyalty: place + collect a fresh order with a customer phone → points appear.
4. Membership: create a bundled plan → enroll → order covered items.
5. Sold-out: toggle in menu editor → check POS tile + try ordering.
6. Wastage: log one → Home Expenses card + Expenses screen + P&L.

## Round 4 — Mark Ready error, inventory, loyalty clawback, membership at pay-time

**"Cannot move order from collected to ready" — root cause.** Not an order-number mismatch: #36 on the Orders screen is the BILL (named after its first KOT), and the kitchen shows its individual KOTs #36–39 — that's by design, and refunds never change order numbers or IDs. The real bug: your bill had 3 finished (collected) KOTs plus 1 new pending one, and "Mark Ready" blindly updated ALL of them. It "worked before" only because there was no transition matrix — illegal moves silently passed (and re-awarded loyalty points, which is why the matrix was added on the 22nd). Fixed on both sides: the app now only advances KOTs that can legally move (pending→ready etc.), and the backend treats same-status updates as a harmless no-op.

**Inventory refill not saving.** The app called `/menu-items/:id/stock` but the backend route lives at `/menu/:id/stock` — every adjustment 404'd. Path fixed (+ the response was read from the wrong key). Refills from the Inventory screen now persist.

**Loyalty clawback on refunds.** Refunds now reverse points proportionally: ₹200 refunded on a ₹400 order that earned 40 pts claws back 20 pts — balance, lifetime points, a "Refund clawback" ledger entry and the order's earned-points all update atomically with the refund.

**Membership offer moved to where money changes hands** (your exact spec):
- **Pay & Place**: tapping the button first shows the membership popup for customers with no active plan — renew (if lapsed) or pick a plan (if never enrolled). Buying adds the fee to THIS billing — the "Order placed" dialog says "+ Membership ₹X — COLLECT ₹Y TOTAL" — and the bundle discounts this very order (subscribe happens before the order is created).
- **KOT saves**: no popup at save; it appears at **settle** instead — the settle sheet shows "Membership (added now) +₹X" and folds it into "To pay".
- "Not now" always continues normal billing untouched.
- The bundle mechanics you described (20 coffees + 20 pizzas → auto-discount until used, renewal after expiry) were already live from round 2 — this round moved WHERE the offer appears and merged the fee into the bill display. Reminder: the offer only shows plans once you've created a bundled plan (Memberships → New plan).

Verified: backend 72/72 tests + boots, all 105 Dart files parse. Restart backend + rebuild APK to test.
