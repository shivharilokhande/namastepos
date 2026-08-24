# Device-test fix round — 22 Aug 2026 (all 20 issues)

Every issue from your device test, with the root cause. Verified: backend 72/72 tests, all files parse, all 54 migrations apply cleanly twice. **Run `npm run migrate` before testing — several fixes need migration 054.**

| # | Your report | Root cause → fix |
|---|---|---|
| 1 | Hamburger disappears for seconds on back | `Navigator.canPop()` is unstable during the pop animation. All 37 AppBars now use `ModalRoute.isFirst` (stable). No more flicker. |
| 2 | Yellow/red "OVERFLOWED" stripes on kitchen tickets | Debug-build overflow warnings (never visible in release APK) — but the layout bug was real: header packed big order-no + `IN_PROGRESS` badge + OK label + timer into a half-width card. Now flexible + ellipsis, badge reads NEW / PREPARING / DONE. |
| 3 | Settle should show full item list + discount | Settle sheet rebuilt: full bill items, discount box with live "To pay" total, then payment method. Discount is applied server-side at close (capped at bill total, shows in reports/leakage). |
| 4 | Bottom nav missing on Captain floor view | Same unstable `canPop()` check inside the shared bottom-nav widget made it hide itself. Now `ModalRoute.isFirst`. |
| 5 | Loyalty shows zero points | Three real bugs: (a) earn was gated on the **paid addon**, not the plan feature — Pro-plan businesses never earned; (b) table-session settle bypassed the earn hook entirely (your main dine-in flow); (c) loyalty settings auto-created with `is_active=FALSE`. All three fixed; migration 054 enables existing settings rows. |
| 6 | Driver: "no deliveries", close → black screen crash | A 30-second timer fired a location-permission prompt even with zero deliveries — dismissing it mid-navigation crashed. Location is now only requested when a delivery actually exists. Also added mounted-guards. |
| 7 | Home stat blocks should be clickable | Revenue → Monthly report, Expenses → Expenses, Profit/Margin → P&L (falls back to Monthly report if plan-locked). |
| 8 | Low-stock toggle ignored on Home | Home section now respects the More → Settings toggle. |
| 9 | Customer tap → order history + membership | New customer detail screen: points/orders/spend/tier, order history, favourite items, active membership, **Add membership** (enroll into a plan; owner can quick-create a plan too). Backend endpoints already existed. |
| 10 | Menu image not on POS tiles | POS tiles never rendered images. Now show the item photo (shared URL resolver with the menu editor), graceful fallback when none. |
| 11 | Wastage: invisible reasons, no history, "not saved" | Unselected chips had a theme color that rendered invisible — fixed + humanised labels ("Over-prepared"). It WAS saving, but popped the screen with no trace; now stays put, shows "Recent wastage" history with rupee value, and sends item cost so wastage shows real ₹ in the P&L. |
| 12 | Daily closing "Route not found" | Client called `/daily-closing`, backend route is `/daily-closings` (plural). Also fixed the result card (read paise fields — showed ₹0 before). |
| 13 | Surge pricing can't set | Screen was read-only ("add from dashboard"). Now has **Add rule**: name, day, from/to time pickers, multiplier — posts to the existing backend route. |
| 14 | No Driver option in staff | Full new role `staff_driver` (migration 054 + backend + app): PIN sign-in, lands on My-deliveries, auto-registered in the drivers table so the delivery picker sees them, and drivers can mark picked-up/delivered themselves (routes were owner/cashier-only before). |
| 15 | Plans should show admin-set functions | The pipeline already worked (plan_features → /plans → app). Added a fallback so cards never render empty on a DB without the matrix. If you still see empty features after migrating, tell me what the Plans screen shows. |
| 16 | Refund → Items → blank screen crash | Real crash: `AlertDialog` sizes content with IntrinsicWidth; the item checklist used a `ListView`, which can't report intrinsic size → layout exception → blank dialog. Swapped to a Column. Bonus fix: item refunds on multi-KOT bills summed to ₹0 server-side (items from KOT 2+ weren't counted) — now counts all KOTs in the session and caps at the bill total. |
| 17 | Dine-in POS order jumps to WhatsApp | Auto-WhatsApp now skips dine-in everywhere (POS confirm + mark-ready). Takeaway/delivery unchanged. |
| 18 | "Start Preparing" text overlapping | Button label now scales down instead of clipping on narrow cards. |
| 19 | Aggregators should be phone + OTP, not API key | Screen rebuilt around the backend OTP flow: enter merchant phone → Send OTP → verify → paste outlet ID → LINKED badge. API key demoted to an "Advanced" expander. (Old screen only saved the key locally — it never talked to the backend at all.) |
| 20 | KDS "IN_PROGRESS" raw text | Humanised (see #2). |

## Before you test
1. `cd foodflow_backend && npm run migrate` (applies 053 + 054 — loyalty, driver role, split-tender, walkouts all need it).
2. Restart the backend.
3. Rebuild the app: `cd foodflow_flutter && flutter analyze && flutter run` — I can't run the Flutter toolchain here, so `flutter analyze` is your compile gate. Everything passed structural checks.

## Notes
- Aggregator OTP currently sends via your own OTP service (MSG91, or server-log in dev mode) — real Zomato/Swiggy-side verification needs their Partner API (2–6 week approval, as documented).
- Loyalty: existing customers earn points from the NEXT collected/settled order; past orders aren't back-credited.
