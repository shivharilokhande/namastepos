# FoodFlow — Manual Smoke Test Plan

**Use:** Run this end-to-end before any deploy, and again after any refactor from `DUPLICATE_AUDIT.md` is applied.
**Time to complete:** ~60-75 minutes on a fresh DB. ~30 minutes on a primed DB.
**Surfaces needed:** Backend (port 4000), Owner Dashboard (5174), Super Admin (5173), Flutter on Pixel_10 emulator, optional: paired Bluetooth thermal printer + print_agent on LAN.

---

## Pre-flight (5 min)

```
[ ] Postgres @14 running:           brew services list | grep postgresql
[ ] Backend up:                     curl -s http://localhost:4000/v1/health | jq
[ ] Dashboard reachable:            open http://localhost:5174
[ ] Admin reachable:                open http://localhost:5173
[ ] Pixel_10 emulator booted:       adb devices  (expect emulator-5554)
[ ] Flutter app builds & launches on emulator with API_URL=http://10.0.2.2:4000/v1
[ ] No console errors in any client on first load
```

---

## A. Authentication (8 min)

### A1. Email login (mobile)
```
[ ] Open Flutter app → "Sign in"
[ ] Enter shivlokhande7080@gmail.com + password
[ ] Lands on Home/Dashboard for "Cafe Sugar & Spice"
[ ] Refresh token flow works — kill app, reopen → still logged in
[ ] Logout returns to login screen, clears state
```

### A2. Google Sign-In (mobile, Android)
```
[ ] Tap "Continue with Google"
[ ] Google chooser appears (use shivlokhande7080@gmail.com)
[ ] App lands authenticated, same business loaded
[ ] iOS path: verify reversed URL scheme in Info.plist still matches reference_google_signin_config memory
```

### A3. Registration with granular consent (DPDP, Push 21)
```
[ ] Logout → "Create account"
[ ] Test number / email (use disposable)
[ ] Three consent checkboxes visible (essential / analytics / marketing)
[ ] Essential pre-ticked and locked; others opt-in
[ ] Submit succeeds; new business created
[ ] Check DB: consent_events has 3 rows (or 1 row per non-defaulted consent) for this user
```

### A4. Dashboard login
```
[ ] http://localhost:5174 → login same account
[ ] Same business loaded; mobile + dashboard show consistent KPI numbers
```

### A5. Super-admin login (separate creds)
```
[ ] http://localhost:5173 → admin login
[ ] Dashboard page loads with metrics
[ ] Cannot access via owner credentials (admin guard)
```

---

## B. Menu CRUD (5 min)

```
[ ] Mobile: Menu → add category "Smoke Test Cat"
[ ] Mobile: Menu → add item "Smoke Item" ₹100, GST 5%, in "Smoke Test Cat"
[ ] Refresh dashboard: same item visible in Menu
[ ] Edit price to ₹120 in dashboard
[ ] Mobile reflects ₹120 on next pull-to-refresh (live or after app foreground)
[ ] Delete category cascades or rejects with friendly error (verify chosen behavior)
[ ] Image upload (if available) works on both mobile + dashboard
```

---

## C. Multi-KOT Bill Consolidation (Push 23) — CRITICAL (12 min)

This is the most-recently-changed flow. Test thoroughly.

### C1. Create dine-in session + KOT 1
```
[ ] Mobile: Tables → tap free Table 5 → Start session for 2 guests
[ ] Add 2 items, send to kitchen → KOT 5 created (bill # 5)
[ ] Orders list (mobile): shows ONE row for session 5
[ ] Orders list (dashboard): shows ONE row for session 5
[ ] KDS: shows KOT 5 with both items
```

### C2. Add KOT 2 to same session
```
[ ] Same table, add 1 more item → send → KOT 5.1 created
[ ] Orders list (mobile + dashboard): STILL ONE row for session 5
    Bill # = 5 (smallest), not 5.1
    Items list = merged across both KOTs
    Total = sum of both
[ ] KDS: shows BOTH 5 and 5.1 as separate kitchen tickets
```

### C3. Mark Ready across multi-KOT (bug fix verification)
```
[ ] Tap "Mark Ready" on the consolidated bill row
[ ] BOTH KOT 5 and 5.1 flip to ready (not just first one)
[ ] Verify on KDS: both tickets cleared
```

### C4. Close session + payment
```
[ ] Tap "Close" / "Payment" → choose payment method (cash)
[ ] Bill # shown on receipt = 5
[ ] Customer-facing total matches mobile + dashboard total
[ ] Table 5 returns to free state
[ ] In DB: orders.payment_method updated correctly for all rows in this session
    (previous bug: stuck on 'unpaid')
```

### C5. Cancel inside multi-KOT
```
[ ] Start fresh session on Table 6, add KOT, add second KOT
[ ] Cancel KOT 6.1 only
[ ] Consolidated bill: now shows only KOT 6 items; total updated
[ ] Don't lose KOT 6 by accident
```

---

## D. Table Session Abandon (Push 22) (4 min)

```
[ ] Start session on Table 7, do NOT add any orders
[ ] Mobile Captain bottom sheet → "Abandon" → confirm
[ ] Table 7 returns to free
[ ] Repeat: start session on Table 8, add a KOT, try Abandon
[ ] Mobile + dashboard both reject with: "Cannot release a table with active orders. Settle the bill instead."
[ ] Settle the bill via close-session flow, then Abandon is no-op (table already free)
```

---

## E. Bluetooth Thermal Printing (Push 22) (6 min)

**Skip if no physical printer available.**

```
[ ] OS Bluetooth Settings → pair printer (Android)
[ ] Flutter Settings → Printers → printer appears in list
[ ] Select + Save
[ ] After C4 (close session): tap Print → receipt prints
    [ ] Business name + GSTIN at top
    [ ] Bill # 5 (or whatever your session bill # is)
    [ ] All items from both KOTs (consolidated, not separate KOTs)
    [ ] GST split (CGST/SGST or IGST per state)
    [ ] Total in bold
    [ ] Footer: "Thank you" / business contact
[ ] iOS path: only attempt on MFi-certified printer; non-MFi shown as unsupported with explanation
[ ] If print_agent + LAN printer set up: identical receipt prints via agent
```

---

## F. Plan Upgrade + Feature Gating (8 min)

### F1. Free tier limits
```
[ ] Mobile: confirm current plan via Plan / Subscription screen
[ ] If on free: try to add 4th staff (free cap = 3 staff, excludes owner per memory)
[ ] Over-limit banner shows on mobile + dashboard staff screens
[ ] Cannot add 4th — UI blocks, backend rejects
```

### F2. Upgrade flow (Razorpay test)
```
[ ] Mobile or dashboard: tap Upgrade → Pro (₹X)
[ ] Razorpay checkout in test mode → use 4111 1111 1111 1111 (or test card)
[ ] Payment succeeds → plan flips to pro
[ ] Mobile reflects on next foreground (SubscriptionProvider.load)
[ ] Dashboard reflects on next refetch (60s default in usePlan)
[ ] Confirm tier_kind = 'pro' in `featureService.planSummary()` payload
[ ] Add 4th staff now succeeds
```

### F3. auto_whatsapp_order gating (recent fix)
```
[ ] Super-admin: PlansPage → toggle 'auto_whatsapp_order' OFF for current pro plan
[ ] Mobile foreground → confirm feature now OFF
[ ] Send KOT → WhatsApp auto-send does NOT fire
[ ] Toggle back ON in admin → mobile sees it ON → WhatsApp fires on next KOT
[ ] No regression to the previous bug where it fired regardless
```

---

## G. DPDP Self-Service (Push 21) (5 min)

```
[ ] Mobile: Settings → Privacy & data
[ ] View consents — toggle marketing OFF → save
    Confirm consent_events row recorded with source='mobile_app'
[ ] File DSR → "Export my data" → request appears in queue
[ ] File DSR → "Correct my details" → text correction submitted
[ ] Grievance form → submit complaint → grievance_complaints row created
[ ] Super-admin: /v1/admin/compliance/* views show the new DSR + grievance
[ ] Same flow from dashboard yields the same DB rows (just with source='dashboard')
[ ] Privacy Policy + ToS view shows DRAFT badge (until lawyer-approved version replaces it)
[ ] Cookie banner on landing + dashboard remembers choice on next visit
```

---

## H. Super-Admin Plan Features Matrix (4 min)

```
[ ] http://localhost:5173 → Plans
[ ] See all 3 tier_kinds (starter / pro / enterprise) + any custom plans
[ ] Edit Pro tier → add a NEW feature key that doesn't yet exist in any plan
    (WELL_KNOWN_FEATURE_KEYS in featureService should already list it)
[ ] Save → cache invalidates
[ ] Mobile foreground → SubscriptionProvider.load → mobile sees new feature
[ ] Owner dashboard refetches plan within 60s → also sees new feature
[ ] Remove feature → both clients reflect within their refetch window
```

---

## I. Reports + KPI Drill-down (4 min)

```
[ ] Dashboard: Reports → KPI cards visible (Income / Expense / P&L / Orders)
[ ] Tap a KPI card → drill into detail (recent fix — was non-tappable before)
[ ] Date range filter works on all 4 detail screens
[ ] Export each report as PDF / XLSX / CSV → downloaded files open without error and contain real data
[ ] (If you applied D1+D2 refactor: re-verify all 4 exports still work)
[ ] GSTR-1 + GSTR-3B export (if applicable): produces valid CSV
```

---

## J. Print Agent (only if deployed locally) (3 min)

```
[ ] print_agent running on PC: tail -f agent.log
[ ] Backend sends test print job
[ ] Network transport: prints within 5s (timeout matches)
[ ] BT transport: prints; agent.log shows no errors
[ ] File transport: writes to disk path
[ ] Kill printer mid-job → agent logs error, recovers on next poll
```

---

## K. Regression spot-checks (3 min)

These are the recently-fixed items per project memory. Confirm they didn't regress.

```
[ ] closeSession: payment_method flips correctly (not stuck on 'unpaid')
[ ] Mark Ready on multi-KOT flips ALL KOTs, not just first  → covered in C3
[ ] Staff list: owner row shows business name (not "?")
[ ] WhatsApp gated on auto_whatsapp_order  → covered in F3
[ ] KDS card aspect ratio: "Mark ready" button fully visible (not clipped)
[ ] Reports KPI cards tappable  → covered in I
[ ] Material assertion bug (no duplicate shape + borderRadius) — no console errors during navigation
[ ] Orders screen back button appears when pushed from Reports drill-down
```

---

## L. After any refactor — re-run minimum set

If you applied any item from `DUPLICATE_AUDIT.md`, run AT LEAST:

- The whole of section C (bill consolidation)
- F2 + F3 (plan upgrade + feature gating)
- I (reports + exports, especially if you applied D1+D2)
- E (printing, if you applied F2 — Flutter receipt refactor)

---

## Sign-off

```
Tester:  _______________________
Date:    _______________________
Build:   backend@_____ dashboard@_____ admin@_____ flutter@_____
Result:  [ ] Pass    [ ] Pass with notes (below)    [ ] Fail
Notes:
```

Fail / blocker → file in `ROADMAP_POST_LAUNCH.md` and do NOT deploy.
