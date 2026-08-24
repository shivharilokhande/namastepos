# Device-test fix round 2 — 23 Aug 2026

Verified: backend 72/72 tests + boots clean, all **55** migrations apply twice, all 103 Dart files parse, dashboard builds. **Run `npm run migrate` (new migration 055) and restart the backend before testing.**

## The black-screen crash — actually found this time

The driver sheet was innocent. **Every drawer tile ran `Navigator.pop(context)` to close the drawer.** On a double-tap (easy when the next screen has a network fetch, like the driver list), tap #1 closed the drawer and tap #2 popped the **root route** — empty navigator → black screen, dead app. This could kill the app from ANY drawer item. All 15 drawer tiles now use `closeDrawer()` (can never touch routes), plus a double-tap guard on the driver flow. My earlier fix addressed a real-but-different issue (location prompt); this was the killer.

## Everything else

| Your report | Fix |
|---|---|
| Driver role missing on dashboard | Added `Driver (delivery)` to the dashboard Staff page (role list + default permissions) — parity with the app. DriversPage already existed there. |
| Sold-out toggle → "Validation failed" | Client sent `{mode: ...}`, backend expects `{until: ...}` (null = available again). Fixed. |
| Order time shows 8 AM instead of 1:32 PM | Backend timestamps are UTC; the app formatted them without converting. All date/time formatters now convert to device-local. That was display-only — |
| Surge not applying | — the real surge issue was that **nothing consumed the rules**. Now: POS fetches the active rule when the confirm screen opens, shows a "⚡ Surge ×2.00 (test) — prices adjusted" banner, and multiplies every line price. Backend rule-matching also now computes "now" in IST (a UTC prod server would have been 5h30m off). |
| Loyalty still 0 points | The code fixes landed yesterday but need **`npm run migrate` (054 activates loyalty settings) + backend restart**, and points only accrue on orders collected/settled AFTER that. Your 5 old orders won't back-credit. Place a fresh order with the customer's phone → points appear. If still zero after migrating, tell me. |
| Customer order tap → full invoice | Order history rows now open the full order detail (items, totals, timeline, reprint, refund). Works for old orders too — the screen fetches by id when it's not in the recent list. |
| Membership = item bundles | Built exactly as you described: **create a plan with bundle items** (e.g. 20× Cold Coffee + 20× Pizza, 30 days — picker with +/− steppers in the plan dialog); **auto-redeem at order** — covered items are discounted server-side and the balance counts down (1 pizza + 3 coffees + 1 tea → customer pays for the tea); customer screen shows "17× Cold Coffee left" chips; **renewal popup at billing** when the membership has lapsed — Renew charges the plan price (collected separately, message tells the cashier) and the bundle works from that same order; "Not now" continues normal billing. |
| Wastage → expense | Logging wastage now also writes an expense (category "wastage") at the item's **cost price × qty** (falls back to selling price if no cost price set). Shows in Expenses + daily report; P&L counts it once (COGS), not twice. |
| Daily closing = real closing | The screen now shows, before you close: **today so far** (orders + gross), **split by method — Cash ₹X · UPI ₹Y · Card ₹Z**, expected cash in counter, and **yesterday's counted cash**. Then count → variance. |
| Refund: partial qty + amount + accounting | Items tab now has **+/− steppers per line** (refund 1 of 2 chai); the Amount tab already covers custom amounts. On item refunds the backend also books the **making cost (cost price)** as a "Refunded prepared-food cost" expense, so income/expense reflects the loss. |
| Blank "Usually orders" chips | Same root cause as the invisible wastage reasons: the global chip theme had no text color. Fixed once in the theme — all chips everywhere. |

## Before testing
1. `cd foodflow_backend && npm run migrate` → applies 055 (and 053/054 if not yet).
2. Restart the backend.
3. `cd foodflow_flutter && flutter analyze` then rebuild the APK.
4. For the membership flow: set **cost price** on menu items (menu editor) so wastage/refund expenses use real making costs.

## Notes
- Membership renewal is charged as a separate membership payment (clean books) — the snackbar tells the cashier to collect it; it isn't merged into the order's GST bill because the membership isn't a food item.
- Dashboard/admin parity beyond staff roles: I've kept the backend as the single source of truth, so app-side features (bundles, surge, wastage expenses) show up in dashboard reports automatically. A full dashboard UI pass for the new screens (bundle editor, surge editor) is pending your dashboard test round.
