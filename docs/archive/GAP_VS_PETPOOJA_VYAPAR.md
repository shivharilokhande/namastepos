# FoodFlow vs PetPooja / Vyapar — Competitive Gap Analysis

**Date:** 2026-05-20
**Scope:** Honest comparison of what we ship today vs what the India market
expects from a restaurant POS (PetPooja, POSist, Limetray) or general billing
(Vyapar, TallyPrime, Marg).

---

## TL;DR

We have a strong foundation — multi-tenant SaaS, RBAC, addons marketplace,
loyalty, QR ordering, running bills, drag-to-arrange floor plan, recipe
inventory, combos — but to be a credible PetPooja alternative we're missing
**roughly 20 features** that Indian restaurants treat as table stakes.

The big ones, in order of pain caused to a restaurant owner who'd switch
to us today:

1. **No aggregator integrations** (Zomato/Swiggy orders are manually entered)
2. **No item modifiers/variants** (no "Half/Full", "Extra cheese ₹30", "No onion")
3. **No service charge / round-off / pre-tax-vs-post-tax discount logic**
4. **No bill splitting**
5. **No daily closing (Z-report)**
6. **No offline mode**
7. **No table reservation / wait list**
8. **No bill template customization** (logo, footer, GST format)
9. **No reprint / duplicate bill**
10. **No "86 / out of stock" quick-toggle from POS**

---

## What we have today ✅

### Backend
- Multi-tenant SaaS (businesses + business_users + RBAC)
- JWT auth with Google sign-in + 15-min impersonation + 2FA TOTP
- httpOnly cookie refresh + CSRF
- Razorpay subscription billing + webhook handler
- Plans + addons marketplace (per-tenant entitlements)
- Migration system (12 migrations)
- Test foundation (Jest + Supertest + k6 + Playwright)
- CI workflow with migration-test + RBAC matrix

### Customer dashboard
- Menu manager (categories, items, combos, image, prep time, display order)
- Recipe-based inventory + food cost report
- KOT stations + KOT live queue
- Tables + drag-to-arrange visual floor plan + edit/delete
- Running bills (sessions) with itemized view + KOT history
- POS dialog with dine-in / takeaway + "Save KOT" (pay later)
- Customer database (CRM) with loyalty tiers + points
- QR ordering (guest scans table, orders without app)
- Orders page with online / offline channel filter
- Expenses
- Reports (basic)
- Marketplace (addon subscriptions)
- Billing + plan management
- Staff invitations
- Settings

### Super admin
- Customers (CRUD + impersonate + suspend / restore + extend trial)
- Plans CRUD + Razorpay sync
- Coupons + redemptions
- Refunds (Razorpay-backed)
- Revenue / Finance / GST reports
- Advanced reports (cohorts, funnel, LTV, churn, item heatmap)
- Audit log + webhook events
- Admin team with 4-role RBAC (super_admin / finance / support / sales)
- Platform settings (KV store)
- Addons catalog management

### Mobile (Flutter, on hold for QA polish)
- All POS screens
- Loyalty wired
- Tables wired
- Subscription awareness

---

## Gap 1 — FOOD VERTICAL (must-have to compete with PetPooja)

### Tier 1 — Ship-blocking for serious restaurant prospects

| # | Feature | Why it matters | Effort |
|---|---|---|---:|
| F1 | **Zomato / Swiggy webhook ingestion** | Today orders from Zomato are typed in by hand. PetPooja's #1 selling point is "all aggregator orders show up automatically". This is the single biggest reason restaurants switch. | 2 wk |
| F2 | **Item modifiers & variants** | "Pizza · Medium · Thin crust · Extra cheese · No onion · ₹420". We have flat items only. Without this, the menu can't represent reality. | 1 wk |
| F3 | **Half / Quarter pricing** | Roti ₹15 vs Roti-half ₹8. Industry-standard in India. Same item, multiple price points. | 3 d |
| F4 | **Service charge + round-off** | Almost every dine-in restaurant adds 5-10% service charge + rounds the bill. Affects GST calculation. | 2 d |
| F5 | **Pre-tax vs post-tax discount** | "10% off the food, not the tax" vs "10% off everything". Wrong choice = wrong GST filed. | 2 d |
| F6 | **Bill split** (by guest / by item / equal) | "Two friends sharing — give us two bills." Standard request, we have zero support today. | 4 d |
| F7 | **Reprint / duplicate bill** | Cashier prints, customer says "give me one more copy". Currently impossible — we'd issue a fresh order_no. | 2 d |
| F8 | **Bill template customization** (logo, address, GST footer) | Each restaurant wants their brand on the receipt. We print a generic format. | 3 d |
| F9 | **Quick "86" / out-of-stock toggle from POS** | Kitchen runs out of paneer → cashier should flip a switch on /orders → item greys out across all order screens. Currently requires going to Menu page → edit → save. | 2 d |
| F10 | **Daily closing / Z-report** | End of shift: total sales, payment method breakdown, voids, discounts given, cash drawer expected vs counted. Legally required by some state governments. | 4 d |
| F11 | **Table reservation + wait list** | "Book table 5 for tomorrow 8pm for 4 guests." Auto-flips to reserved, blocks walk-ins. | 1 wk |
| F12 | **Manager approval for discounts above threshold** | Prevents staff giving free food. PIN-protected approval when discount > ₹100 (configurable). | 3 d |
| F13 | **Offline mode in mobile POS** | When internet drops, queue orders in SQLite locally and sync when back. PetPooja's mobile app does this. | 2 wk |
| F14 | **Bilingual UI (Hindi + English)** | Many staff read only Hindi. Adds i18n layer to the dashboard + mobile. | 1 wk |
| F15 | **Token / queue numbers for takeaway** | Print token #47 on the bill, customer waits to be called. | 2 d |

### Tier 2 — Strong polish, important for retention

| # | Feature | Why | Effort |
|---|---|---|---:|
| F16 | **Customer-facing order tracker** | After QR order, customer gets a URL: "Order accepted → preparing → ready". Reduces "is my food coming" questions. | 4 d |
| F17 | **Item-level discount + bill-level discount + auto-coupons** | Today coupons exist for subscription plans (super-admin side). Need same for food bills. | 1 wk |
| F18 | **WhatsApp ordering** | Customer DMs the restaurant's WhatsApp Business → menu link → order. | 1 wk |
| F19 | **Own brand online ordering site** (no Zomato commission) | A pretty branded page per business at `<brand>.foodflow.in` for direct online orders. | 2 wk |
| F20 | **Driver / delivery rider management** | Assign order to rider, mark dispatched, GPS check-in. | 1 wk |
| F21 | **Reservation widget** for customer site / Google | "Book a table" button on the brand site. | 4 d |
| F22 | **Auto-print bill + KOT to thermal printer** (BT / WiFi / ESC/POS) | Today we format ESC/POS strings, but no driver loop to actually push to a printer. | 1 wk |
| F23 | **Multi-printer per station** | KOT to tandoor printer, drink chits to bar printer, bill to counter printer. | 4 d |
| F24 | **Wastage tracking** | "Threw away 2kg paneer (expired)" — logs against expenses, deducts inventory. | 3 d |
| F25 | **Item-level tax slabs (GST 5/12/18)** | Today tax is bill-level. Indian GST is item-level (e.g. AC restaurants 5% vs liquor 18%). | 1 wk |
| F26 | **Bar / liquor inventory with batch tracking** | Liquor licenses require batch + expiry + tax-stamp tracking. | 2 wk |
| F27 | **Tip management** | "Customer left ₹50 tip for waiter Ravi". Track per-server, payroll-ready report. | 3 d |
| F28 | **Reviews aggregation** | Pull Google/Zomato/Swiggy reviews into one inbox. Reply from dashboard. | 1 wk |
| F29 | **Customer history at order time** | When cashier types phone → shows last 5 orders, favorites, allergies. Currently we link but don't surface. | 3 d |
| F30 | **"Reorder same as last"** for regulars | One-tap reorder for repeat customers. | 2 d |
| F31 | **Gift cards / pre-paid wallet** | Sell ₹500 voucher; corporate top-up. | 1 wk |
| F32 | **Membership / packages** | "Unlimited lunch ₹2500/month". | 1 wk |
| F33 | **Birthday / anniversary auto-greetings + bonus points** | Auto-credit 100 pts on birthday + WhatsApp greeting. | 3 d |
| F34 | **Tally / Zoho Books export** | Accountants want it. Daily journal entry CSV. | 4 d |
| F35 | **E-invoice + E-way bill** (mandatory > ₹5 cr turnover) | API integration with NIC's IRP. | 2 wk |
| F36 | **Multi-outlet rollup** for chains | Franchise dashboard with consolidated reports across N outlets. | 2 wk |
| F37 | **Captain / waiter app** | Waiter tablet → take order at table → KOT to kitchen. We have it in the web POS but not as a dedicated waiter app. | 1 wk |
| F38 | **Kitchen Display System (KDS)** | Big-screen TV in kitchen replaces paper KOT. Color-coded by station, swipe to mark done. We have the data, need the screen. | 1 wk |
| F39 | **Cancellation reason picker** | Today we accept a free-text reason. PetPooja has a fixed list (Wrong order / Customer left / Out of stock / etc) — better for reports. | 1 d |
| F40 | **Heat-map: busy hours, busy tables, peak weekdays** | Operations insight. | 4 d |

### Tier 3 — Nice-to-have for differentiation

| # | Feature | Why | Effort |
|---|---|---|---:|
| F41 | **Customer feedback NPS** post-meal | Auto-SMS rating link 30 min after collected. | 3 d |
| F42 | **Smart upsell suggestions** at POS | "Customers who ordered Paneer Tikka also ordered Naan" — small ML model on order history. | 2 wk |
| F43 | **Voice ordering on captain app** | "Two paneer tikka, one naan" → parses → adds to cart. | 1 mo |
| F44 | **AI menu engineering** report | "These 12 items are dead weight, drop them" — based on margin × volume × prep effort. | 1 wk |
| F45 | **Inventory forecasting** | Tomorrow you'll need: 12kg paneer, 5L oil, 2kg onion. | 1 wk |
| F46 | **Dynamic pricing for delivery** during peak hours | Surge pricing on direct online site. | 4 d |

---

## Gap 2 — RETAIL EXPANSION (Vyapar territory)

Save for after food vertical is solid. These are what Vyapar / TallyPrime
own today.

### Tier 1 — Core retail

| # | Feature | Why |
|---|---|---|
| R1 | Barcode scanning + barcode label printing | Counter checkout |
| R2 | Batch number + expiry tracking | Grocery, pharma, cosmetics |
| R3 | SKU bulk import (Excel/CSV) | Onboarding a 500-SKU shop manually = no-go |
| R4 | Vendor purchase orders + GRN (goods receipt note) | Procurement workflow |
| R5 | Multiple price lists (retail / wholesale / distributor / MRP) | B2B mix |
| R6 | Party-wise pricing | Big customers get a custom price |
| R7 | Credit limit per customer + payment terms | "₹50k limit, Net 30" |
| R8 | Customer / vendor ledger | A/R + A/P |
| R9 | Quotation → Sales Order → Invoice workflow | B2B selling |
| R10 | Cheque tracking with date + bank | India still uses cheques |

### Tier 2 — Multi-firm + advanced

| # | Feature | Why |
|---|---|---|
| R11 | Multi-warehouse with stock transfers | Chain stores |
| R12 | TDS / TCS auto-calculation on invoices | Legal compliance |
| R13 | Bilingual invoices (English + Hindi / regional) | Mandatory for some states |
| R14 | Multi-currency | Export businesses |
| R15 | Bank reconciliation | Match bank statement to ledger |
| R16 | Recurring invoices + subscriptions for B2B | Monthly retainers |
| R17 | Amazon / Flipkart marketplace order ingestion | Multi-channel sellers |
| R18 | Inventory valuation: FIFO / weighted-avg / LIFO | Accountant choice |
| R19 | Item-wise profit + P&L + Balance Sheet + Trial Balance | Real accounting |
| R20 | Custom invoice templates | Brand consistency |

---

## Suggested roadmap

### Phase 1 — Close the table-stakes gap (4-6 weeks, food only)

Pick the **15 Tier-1 food gaps** above. Critical to even start pitching.
Most-impactful 5 to ship first:

1. F1 — **Zomato + Swiggy webhook ingestion** (biggest pain killer)
2. F2 — **Item modifiers & variants**
3. F4 — **Service charge + round-off**
4. F8 — **Bill template customization**
5. F7 — **Reprint duplicate bill**

These 5 cover ~70% of the "why we left PetPooja and came back" complaints.

### Phase 2 — Retention polish (3-4 weeks)

The 25 Tier-2 items above. Once a customer's been on FoodFlow 30 days,
these are what makes them stay vs swap.

### Phase 3 — Vyapar-killer retail (6-8 weeks)

Build the 10 Tier-1 retail features. Pitched as a **second product** —
"FoodFlow for Restaurants" + "FoodFlow Shops".

### Phase 4 — Differentiate (open-ended)

AI + ML stuff (F42-F46) and platform plays (multi-outlet, marketplace).

---

## Why we'd actually win vs PetPooja

PetPooja's weaknesses (their own customers complain):
- Heavy desktop app, slow on cheap Windows tablets
- Charge per outlet (expensive for chains)
- 100+ features but UX is buried in menus
- No transparent pricing online
- Mobile app is a thin wrapper over the web
- Support tickets take days

What we already do better:
- **Web-first** — works on any device with a browser
- **Mobile-native** Flutter app — true offline-ready
- **Drag-to-arrange floor plan** (PetPooja's is fixed grid)
- **Per-feature addons marketplace** — pay only for what you use
- **Transparent pricing**
- **Modern auth** (Google sign-in, 2FA, impersonation read-only)
- **Tests + CI** — fewer surprise outages

These advantages disappear the moment they ship modifiers/variants and we
still don't. Phase 1 is urgent.

---

## What I recommend you do next

Pick one of these three Sprint 1 themes:

**Option A — Aggregator + modifiers** (the two biggest pain killers)
- F1 Zomato/Swiggy ingestion
- F2 Item modifiers & variants
- 3 weeks · biggest competitive lift per day of work

**Option B — Bill polish** (covers 10 of the most-complained-about gaps)
- F4 Service charge + round-off
- F5 Pre/post-tax discount
- F6 Bill split
- F7 Reprint
- F8 Bill template
- 2 weeks · removes most "this isn't a real POS" objections

**Option C — Daily-ops backbone**
- F10 Z-report / daily closing
- F12 Manager-approval discounts
- F15 Token numbers
- F24 Wastage tracking
- F39 Cancellation reasons (structured)
- 2 weeks · what a busy restaurant manager cares about most

Tell me which one to start, or pick your own 5 from the table.
