# NamastePOS — Product Backlog (66 user stories)

**Owner:** Rajan Iyer (PO) — backlog priority + AC sign-off
**Author:** Ananya Desai (BA) — story breakdown + edge cases
**Last refined:** 2026-05-20

**Sizing legend:**
| Pt | T-shirt | Calendar (1 person) |
|---|---|---|
| 1 | XS | <1 day |
| 2 | S | 1 day |
| 3 | S | 2 days |
| 5 | M | 3-5 days |
| 8 | L | ~1 week |
| 13 | XL | 1.5-2 weeks |
| 21 | XXL | 3 weeks (must be split) |

**Definition of Ready (DoR):**
- User story format (As a / I want / So that)
- ≥3 acceptance criteria, all testable
- Mockup or wireframe linked (where UI is involved)
- Dependencies identified
- Sized
- Owner + reviewer assigned

**Definition of Done (DoD):**
- Code merged to main, CI green
- ≥1 unit test + ≥1 integration test
- Manual test pass by Suresh
- Security review by Lakshmi (auth/data-touching stories)
- Documented in API_DOCS or USER_GUIDE
- Deployed to staging + smoke-tested
- Demo'd in sprint review, PO accepted

---

## EPIC F1 — Aggregator integrations (15 pts)

### FF-101 · Zomato webhook ingestion (8 pts)
**As a** restaurant manager
**I want** Zomato orders to appear in my Orders queue automatically
**So that** I never re-type online orders and miss none under rush

**AC**
1. New endpoint `POST /v1/webhooks/zomato` accepts the documented payload
2. Signature verified against `ZOMATO_WEBHOOK_SECRET`
3. Order created with `source = 'zomato'`, customer phone/name extracted, items mapped to our menu via external SKU; unknown SKUs surface as "unmapped" warning on the order
4. Duplicate event IDs (already-processed) return 200 idempotent (using `webhook_events` table)
5. Failed mapping logged to `audit_log` with severity=warning
6. Order status mirrors Zomato lifecycle: Placed → Accepted → Ready → Picked-up
7. Settings page lets owner paste Zomato outlet ID + API key

**Deps:** existing `orders` + `webhook_events` tables
**Owner:** Rajesh (BE) · **QA:** Arvind · **PO:** Rajan

### FF-102 · Swiggy webhook ingestion (8 pts)
**As a** restaurant manager
**I want** Swiggy orders to appear automatically
**So that** I have one queue for all delivery platforms

**AC**
1-7 analogous to FF-101, against Swiggy's webhook format
8. Both Zomato + Swiggy orders show in the existing **Online** channel filter on `/orders`

**Deps:** FF-101 establishes the pattern
**Owner:** Rajesh · **QA:** Arvind

### FF-103 · External SKU mapping UI (3 pts)
**As a** restaurant owner
**I want to** map my menu items to Zomato / Swiggy SKUs
**So that** orders coming in get matched correctly

**AC**
1. Each menu item has optional `external_skus` JSON: `{ zomato: "...", swiggy: "..." }`
2. Menu edit dialog shows a collapsible "External listings" section
3. Bulk-mapping helper page: paste Zomato menu URL → autopairs by name similarity
4. Unmapped order items show up under "Mapping issues" on the order

**Owner:** Aman (FE) + Sunita (BE) · **QA:** Suresh

### FF-104 · Aggregator order auto-accept toggle (1 pt)
**As a** restaurant manager
**I want to** auto-accept incoming Zomato/Swiggy orders
**So that** my cashier doesn't have to tap accept during rush

**AC**
1. Setting per-tenant: `aggregator.autoAccept = true/false`
2. When true, incoming order skips `pending` and lands directly at `ready`
3. Default: false (safer for new tenants)

---

## EPIC F2 — Item variants + modifiers (16 pts)

### FF-201 · Variant catalog (8 pts)
**As a** restaurant owner
**I want to** sell the same item at multiple price points (Half/Full, Small/Med/Large)
**So that** my menu reflects reality

**AC**
1. Schema: `menu_item_variants(id, menu_item_id, label, price, sku, is_active, display_order)`
2. Menu edit dialog → "Variants" panel; add/edit/delete inline
3. POS shows variants as chips below the parent item; tap adds the variant (not the parent)
4. Each variant has its own stock (optional — default share parent stock)
5. Recipes attach to variants (large size uses more ingredient)
6. Order line shows `Paneer Tikka · Large · ₹420`

**Deps:** existing menu_items table

### FF-202 · Modifier groups + modifiers (8 pts)
**As a** restaurant owner
**I want to** offer addons like "Extra cheese ₹30", "No onion", "Spice: Mild/Medium/Hot"
**So that** customers can customize their order

**AC**
1. Schema: `modifier_groups(id, business_id, name, min_select, max_select)` + `modifiers(id, group_id, name, price_delta_inr)` + `item_modifier_groups(item_id, group_id)`
2. Menu editor: "Modifiers" panel attaches groups to items
3. POS: tapping a multi-modifier item opens a modal — pick from each group respecting min/max
4. Cart line shows base item + modifier list + total price including deltas
5. Recipe deduction walks modifier-linked ingredients too
6. KOT ticket includes modifier choices ("Extra cheese", "No onion")

---

## EPIC F3 — Bill polish (14 pts)

### FF-301 · Service charge (2 pts)
**As a** restaurant owner
**I want to** auto-add a service charge (e.g. 5%) on dine-in bills
**So that** I don't have to add it manually each time

**AC**
1. Setting per-tenant: `service_charge_pct` (0-15) + `service_charge_dine_in_only` (default true)
2. Applied to subtotal before tax
3. Visible as separate line on bill + receipt
4. POS dialog shows the auto-applied charge with a toggle to remove for that one bill
5. Stored on `orders.service_charge_paise`

### FF-302 · Round-off (1 pt)
**As a** cashier
**I want** the final bill rounded to the nearest rupee
**So that** I don't deal with paise change

**AC**
1. Setting: `bill_round = nearest_rupee | down | none`
2. Round-off applied AFTER total, stored on `orders.round_off_paise` (can be negative)
3. Shown on receipt as "Round off: -₹0.30" (or +)

### FF-303 · Pre-tax vs post-tax discount (3 pts)
**As a** cashier
**I want** to apply a discount either before tax (food discount) or after tax (instant cashback)
**So that** GST is calculated correctly

**AC**
1. Each discount row in the order has `apply_before_tax: boolean`
2. UI radio in the discount picker: "10% off the food (before tax)" vs "Flat ₹100 off total bill (after tax)"
3. Bill math: pre-tax discounts reduce subtotal before tax calc; post-tax discounts reduce final total
4. GST report shows both correctly

### FF-304 · Bill split (5 pts)
**As a** cashier
**I want to** split a bill three ways: equal, by item, or custom amounts
**So that** friends sharing a meal can pay separately

**AC**
1. From the SessionDialog "Settle" button → "Split bill" sub-action
2. Three modes: Equal (N ways), Per item (each guest picks items), Custom amounts
3. Generates N child invoices, each with its own payment method
4. Each split invoice prints separately; loyalty points credit the customer linked to that split
5. Only allowed on `open` sessions

### FF-305 · Reprint / duplicate bill (2 pts)
**As a** cashier
**I want to** reprint a bill after it's been settled
**So that** I can give the customer a second copy

**AC**
1. Order detail page has a "Reprint" button (RBAC: business_owner + staff_manager + staff_cashier)
2. Duplicate bills are marked "DUPLICATE" at the top of the receipt
3. Each reprint logged to `audit_log`
4. Same bill number (not a new order_no)

### FF-306 · Bill template customization (3 pts)
**As a** restaurant owner
**I want to** set my logo, address, GSTIN, and footer text on the receipt
**So that** the bill looks branded

**AC**
1. Settings → "Bill template" page: upload logo, address textarea, GSTIN, footer note
2. Live preview as fields are edited
3. Stored on `bill_templates` table per tenant
4. Receipt printer uses the active template
5. Optional second template for KOT (different format)

---

## EPIC F4 — Inventory + ops (10 pts)

### FF-401 · 86 / out-of-stock quick toggle (2 pts)
**As a** cashier
**I want to** mark an item out of stock from anywhere in the POS
**So that** the kitchen doesn't get tickets they can't fulfill

**AC**
1. Each menu item card on POS has a long-press / right-click → "Mark 86" toggle
2. "86" items show greyed-out with "Sold out" overlay across all POS views
3. Auto-restocks at 06:00 next day (configurable per tenant)
4. Manager can permanently 86 (no auto-restock)

### FF-402 · Wastage tracking (3 pts)
**As a** restaurant manager
**I want to** log wasted ingredients
**So that** my food cost report is accurate and I can reduce waste

**AC**
1. Ingredients page → "Record wastage" action per row
2. Form: qty, reason (expired / spilled / over-prep / other), note
3. Reduces ingredient stock; logged in `ingredient_transactions` with `kind='waste'`
4. Wastage report: total waste ₹ + top wasted items, week-over-week trend
5. Linked to expense category 'ingredients'

### FF-403 · Daily closing / Z-report (5 pts)
**As a** manager
**I want** an end-of-day report with totals, payment breakdown, voids, and expected cash
**So that** I can reconcile the till and close the shift

**AC**
1. New page: "Daily closing" — defaults to today, picker for past dates
2. Sections: Sales summary (gross / refunds / net), Payment methods (cash / UPI / card / online), Discounts given, Cancellations + reasons, Top items, Cash drawer expected (cash sales − cash refunds − cash expenses), Cashier sign-off textarea
3. PDF export
4. Stored as `daily_closings(business_id, date, payload JSONB, closed_by, closed_at, signature)` — write-once
5. Closing locks the day from further edits (admin override possible)

---

## EPIC F5 — Workflow (10 pts)

### FF-501 · Token numbers for takeaway (2 pts)
**As a** cashier
**I want** a token printed on takeaway orders
**So that** I can call out the number when food is ready

**AC**
1. New table `takeaway_counters(business_id, date, last_token)`
2. Token resets each day at 00:00 (configurable)
3. Token printed on receipt in large font; visible in /orders card
4. Status flips to `ready` → optional SMS to customer: "Order #47 ready"

### FF-502 · Manager approval for discounts (3 pts)
**As a** restaurant owner
**I want** discounts above ₹100 to require a manager PIN
**So that** cashiers can't give free food to friends

**AC**
1. Setting: `discount_approval_threshold_inr` (default 100)
2. In POS, applying discount ≥ threshold opens a PIN modal
3. Manager PIN stored hashed per `business_users` (admin can set)
4. Approval logged: `discount_approvals(order_id, manager_user_id, amount, approved_at)`
5. Auto-allowed if logged-in user is business_owner or staff_manager
6. RBAC: `staff_cashier` always needs approval if threshold > 0

### FF-503 · Structured cancellation reasons (1 pt)
**As a** restaurant manager
**I want** cancellations to pick from a list of reasons
**So that** reports can show why orders fail

**AC**
1. Settings → "Cancellation reasons" — owner-managed list (default: Wrong order, Customer left, Out of stock, Kitchen error, Payment failed, Other)
2. Cancel dialog replaces free-text with required dropdown + optional note
3. Cancellation report groups by reason with counts + lost ₹

### FF-504 · Customer history at order time (3 pts)
**As a** cashier
**I want** to see a customer's recent orders, favorites, and notes when I type their phone
**So that** I can suggest their usual and avoid allergens

**AC**
1. POS phone input → autocomplete after 4 digits
2. Selected customer shows in side panel: last 5 orders (with items), favorite items (most-ordered), allergy notes
3. One-tap "Same as last" button populates cart from most recent order
4. PII protection: cashier role only sees masked email (a***@b.com)

### FF-505 · Reservation system + wait list (8 pts) [Sprint 3]
**As a** host
**I want to** accept reservations for future dates and manage a wait list
**So that** I can plan service and reduce walk-out frustration

**AC**
1. New tables: `reservations`, `wait_list`
2. Reservations dashboard: calendar view of bookings
3. Booking form: name, phone, party size, date, time, special requests
4. Auto-marks the table `reserved` 15 min before slot
5. Wait list: name + party size + ETA estimate; SMS when table ready
6. Reminder SMS 1 hour before reservation
7. No-show after 15 min auto-releases table

---

## EPIC F6 — Mobile + offline (16 pts) [Sprint 4-5]

### FF-601 · Offline-first mobile POS (13 pts) [needs split]
### FF-602 · Captain / waiter app (8 pts)
### FF-603 · Kitchen Display System (KDS) for tablet (8 pts)
### FF-604 · i18n Hindi + English (5 pts)
### FF-605 · Customer-facing order tracker (3 pts)

---

## EPIC F7 — Online + delivery (24 pts) [Sprint 6-7]

### FF-701 · Own-brand online ordering site (13 pts)
### FF-702 · WhatsApp ordering integration (8 pts)
### FF-703 · Driver / delivery rider management + tracking (8 pts)
### FF-704 · Reservation widget for external sites + Google (3 pts)

---

## EPIC F8 — Printer integration (8 pts) [Sprint 5]

### FF-801 · ESC/POS thermal printer driver (5 pts)
**As a** restaurant
**I want** receipts to auto-print on settle
**So that** the cashier doesn't have to copy-paste

**AC**
1. Mobile app talks BT to printer; web app uses USB via WebUSB / printer relay
2. Per-station printer config (already on `kot_stations.printer_address`)
3. Print queue with retry on failure
4. Test-print button in settings

### FF-802 · Multi-printer routing per station (3 pts)
**As a** restaurant
**I want** KOTs routed to the right station printer + bill to counter
**So that** the kitchen team gets only their items

**AC** Already wired in `kot_stations.printer_address`; just need driver glue

---

## EPIC F9 — Tax + bar (16 pts) [Sprint 4]

### FF-901 · Item-level GST slabs (5/12/18) (8 pts)
### FF-902 · Bar / liquor inventory with batch + duty tracking (13 pts) [split]
### FF-903 · Tip management per server (3 pts)

---

## EPIC F10 — Customer engagement (13 pts) [Sprint 6]

### FF-1001 · Reviews aggregation (Google/Zomato/Swiggy) (5 pts)
### FF-1002 · Post-meal NPS feedback (3 pts)
### FF-1003 · Birthday/anniversary auto-greeting + bonus (2 pts)
### FF-1004 · WhatsApp marketing campaigns (5 pts)
### FF-1005 · Gift cards + pre-paid wallet (5 pts)
### FF-1006 · Membership / package plans (5 pts)

---

## EPIC F11 — Reporting + finance (13 pts) [Sprint 7]

### FF-1101 · Tally / Zoho Books export (4 pts)
### FF-1102 · E-invoice (IRP API) (8 pts)
### FF-1103 · E-way bill generation (5 pts)
### FF-1104 · Heat-map (hours/days/tables) (3 pts)
### FF-1105 · Dead-stock report (2 pts)
### FF-1106 · Item-wise profit + menu engineering (5 pts)

---

## EPIC F12 — Multi-outlet / chains (16 pts) [Sprint 8]

### FF-1201 · Multi-outlet rollup dashboard (8 pts)
### FF-1202 · Cross-outlet inventory transfer (5 pts)
### FF-1203 · Centralized pricing for franchise (5 pts)

---

## RETAIL EXPANSION (Sprints 9-10)

### EPIC R1 — Core retail (39 pts)

| # | Story | Pts |
|---|---|---:|
| R-101 | Barcode scan + label printing | 5 |
| R-102 | Batch + expiry tracking | 8 |
| R-103 | SKU bulk import (Excel/CSV) | 3 |
| R-104 | Vendor PO + GRN workflow | 8 |
| R-105 | Multiple price lists | 5 |
| R-106 | Party-wise pricing | 5 |
| R-107 | Credit limit + payment terms | 3 |
| R-108 | Customer + vendor ledger | 5 |
| R-109 | Quotation → Sales Order workflow | 8 |
| R-110 | Cheque tracking | 2 |

### EPIC R2 — Multi-firm + accounting (32 pts)

| # | Story | Pts |
|---|---|---:|
| R-201 | Multi-warehouse + stock transfers | 8 |
| R-202 | TDS / TCS auto-calculation | 5 |
| R-203 | Bilingual invoices (Hindi/regional) | 3 |
| R-204 | Multi-currency | 5 |
| R-205 | Bank reconciliation | 5 |
| R-206 | Recurring invoices + B2B subscriptions | 3 |
| R-207 | Amazon / Flipkart order ingestion | 8 |
| R-208 | FIFO / weighted-avg valuation | 5 |
| R-209 | P&L + Balance Sheet + Trial Balance | 8 |
| R-210 | Custom invoice templates | 3 |

---

## Backlog summary

| Epic | Stories | Total pts |
|---|---:|---:|
| F1 Aggregators | 4 | 20 |
| F2 Variants + modifiers | 2 | 16 |
| F3 Bill polish | 6 | 16 |
| F4 Inventory + ops | 3 | 10 |
| F5 Workflow | 5 | 17 |
| F6 Mobile + offline | 5 | 37 |
| F7 Online + delivery | 4 | 32 |
| F8 Printer | 2 | 8 |
| F9 Tax + bar | 3 | 24 |
| F10 Engagement | 6 | 25 |
| F11 Reporting | 6 | 27 |
| F12 Multi-outlet | 3 | 18 |
| **Food total** | **49** | **250** |
| R1 Core retail | 10 | 52 |
| R2 Advanced retail | 10 | 45 |
| **Retail total** | **20** | **97** |
| **GRAND TOTAL** | **69** | **347 pts** |

At 80 pts/sprint that's ~5 sprints of food + ~2 sprints of retail = **7 sprints (14 weeks)** end-to-end, plus 1 stabilization sprint = **8 sprints / 16 weeks**.

We round up to 10 sprints (20 weeks / 5 months) for slack, hiring ramp, and inevitable scope creep.
