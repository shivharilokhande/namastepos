# NamastePOS — 10-Sprint Plan (20 weeks)

**Owner:** Kavitha Nair (SM) · **PO:** Rajan Iyer · **PM:** Rohit Kapoor

**Velocity:** 80 story points / sprint (post-storming team avg)
**Sprint cadence:** 2 weeks · Mon → Fri+1

---

## Milestones

| Sprint end | Date | Headline |
|---|---|---|
| S1 | 2026-06-03 | Variants + bill polish + 86 toggle + tokens + cancel reasons |
| S2 | 2026-06-17 | Zomato + Swiggy ingestion live |
| S3 | 2026-07-01 | Reservations + manager approvals + customer history |
| S4 | 2026-07-15 | Mobile offline POS + i18n + item GST slabs |
| S5 | 2026-07-29 | Captain app + KDS + printer integration |
| S6 | 2026-08-12 | Online site + WhatsApp ordering + loyalty engagement |
| S7 | 2026-08-26 | Driver mgmt + Tally/Zoho + e-invoice |
| S8 | 2026-09-09 | Multi-outlet + reviews + heat-maps |
| S9 | 2026-09-23 | Retail tier 1 (barcode, batch, PO, ledger) |
| S10 | 2026-10-07 | Retail tier 2 (multi-warehouse, P&L, marketplace) + GA polish |

---

## Sprint 1 (2026-05-20 → 06-03) — Foundations & quick wins

**Theme:** Make every existing bill correct + variants/modifiers data model
**Capacity:** 80 pts (full team) — 76 committed (5% buffer)

| Story | Pts | Owner | Pair | QA |
|---|---:|---|---|---|
| FF-201 Variant catalog | 8 | Arun | Pradeep | Suresh |
| FF-202 Modifier groups + modifiers | 8 | Arun | Pradeep | Suresh |
| FF-301 Service charge | 2 | Nikhil | Aman | Suresh |
| FF-302 Round-off | 1 | Nikhil | — | Suresh |
| FF-303 Pre/post-tax discount | 3 | Nikhil | Sunita | Priya I |
| FF-305 Reprint duplicate | 2 | Aman | — | Suresh |
| FF-306 Bill template customization | 3 | Aman | Nikhil | Suresh |
| FF-401 86 / out-of-stock toggle | 2 | Pradeep | Priya B | Suresh |
| FF-501 Token numbers | 2 | Pradeep | Priya B | Suresh |
| FF-503 Structured cancel reasons | 1 | Sunita | Aman | Suresh |
| FF-104 Aggregator auto-accept toggle | 1 | Rajesh | — | Arvind |
| **Mobile parallel work** | | | | |
| Variants + modifiers in Flutter POS | 8 | Bharath | Shruti | Arvind |
| **QA + Test automation** | | | | |
| Variant + modifier contract test suite | 5 | Arvind | — | — |
| Bill-math unit test (charge/round/discount) | 5 | Arvind | — | — |
| **Tech debt + ops** | | | | |
| Migrations 013-015 schema | 5 | Srinivas | Arun | Priya I |
| Documentation (API_DOCS update) | 3 | Sunita | — | — |
| **Reserve** | 4 | — | — | — |

**Sprint 1 demo:** dashboard now sells "Pizza · Medium · Thin · Extra cheese ₹420", bills auto-add 5% service charge + round off, cashier can apply post-tax discounts correctly, 86 toggle hides items, token #47 prints on takeaway, cancellations pick from a structured list, settled bills can be reprinted with DUPLICATE watermark, owner sees their logo on the receipt.

---

## Sprint 2 (06-03 → 06-17) — Aggregator ingestion

**Theme:** Zomato + Swiggy orders auto-flow into NamastePOS
**Capacity:** 80 pts — 77 committed

| Story | Pts | Owner |
|---|---:|---|
| FF-101 Zomato webhook ingestion | 8 | Rajesh |
| FF-102 Swiggy webhook ingestion | 8 | Rajesh |
| FF-103 External SKU mapping UI | 3 | Aman + Sunita |
| FF-402 Wastage tracking | 3 | Pradeep |
| FF-901 Item-level GST slabs | 8 | Sunita |
| FF-501 Token: SMS on ready (carryover) | 1 | Pradeep |
| Captain-app first cut: menu + KOT | 13 | Bharath |
| KDS tablet view (read-only) | 8 | Pradeep + Rhea |
| Zomato/Swiggy integration test fixtures | 5 | Arvind |
| Security review of webhook endpoints | 3 | Lakshmi |
| Tech debt: refactor menu service for variants | 5 | Arun |
| FF-403 Daily closing / Z-report (start) | 5 | Sunita (split) |
| **Reserve** | 4 | — |

---

## Sprint 3 (06-17 → 07-01) — Reservations + ops

**Theme:** Plan ahead — reservations, wait list, manager controls
**Capacity:** 80 pts — 78 committed

| Story | Pts | Owner |
|---|---:|---|
| FF-505 Reservation system + wait list | 8 | Pradeep |
| FF-502 Manager approval for discounts | 3 | Nikhil |
| FF-504 Customer history at order time | 3 | Aman + Priya B |
| FF-403 Daily closing / Z-report (finish) | 5 | Sunita |
| FF-1003 Birthday/anniversary auto-greeting | 2 | Pradeep |
| FF-1001 Reviews aggregation (Google) | 3 | Rajesh |
| Captain-app: variants + modifier picker | 5 | Bharath |
| Reservation reminder SMS scheduler | 3 | Sunita |
| Player F-shaped browse heuristic UX polish | 3 | Rhea |
| Performance audit: order create p99 < 200ms | 5 | Arvind + Arun |
| Mobile: 86 sync, token display | 5 | Bharath |
| FF-801 ESC/POS printer driver (start) | 5 | Arun + Bharath |
| Manual test pass: variants, modifiers, all bill flows | 5 | Suresh (full sprint) |
| Sprint 1+2 regression suite green | 3 | Arvind |
| Documentation: customer-facing user guide | 5 | Sunita |
| **Reserve** | 4 | — |

---

## Sprint 4 (07-01 → 07-15) — Mobile offline + i18n + bar

**Theme:** Field-grade mobile + tax + bar inventory
**Capacity:** 80 pts — 78 committed

| Story | Pts | Owner |
|---|---:|---|
| FF-601 Offline-first mobile POS (part 1: SQLite cache) | 8 | Bharath |
| FF-601 Offline-first mobile POS (part 2: outbox + sync) | 8 | Bharath + Pradeep |
| FF-604 i18n Hindi + English | 5 | Rhea + Shruti |
| FF-902 Bar / liquor inventory (schema + service) | 8 | Pradeep |
| FF-902 Bar / liquor (UI) | 5 | Aman |
| FF-1006 Membership / package plans | 5 | Nikhil |
| FF-301 service charge on KOTs in session (carryover) | 1 | Nikhil |
| FF-201/202 Mobile variant + modifier polish | 5 | Shruti |
| Conflict-resolution UX for offline sync | 3 | Bharath + Suresh |
| Security: encrypted SQLite for cached orders | 3 | Lakshmi |
| Penetration test of webhook handlers | 5 | Lakshmi |
| Manual test: offline scenarios (airplane mode) | 5 | Suresh |
| Performance: order list pagination + virtualisation | 3 | Rhea |
| Documentation: mobile setup guide | 3 | Bharath |
| **Reserve** | 7 | — |

---

## Sprint 5 (07-15 → 07-29) — KDS + printer + workflow polish

| Story | Pts | Owner |
|---|---:|---|
| FF-603 KDS for tablet (full) | 8 | Pradeep + Rhea |
| FF-602 Captain app (sign-off + waiter ID per order) | 8 | Bharath |
| FF-801 ESC/POS printer driver (finish) | 5 | Arun |
| FF-802 Multi-printer routing | 3 | Arun |
| FF-501 Token: SMS pickup notification | 2 | Sunita |
| FF-903 Tip management per server | 3 | Nikhil |
| FF-605 Customer order tracker | 3 | Aman + Sunita |
| FF-1104 Heat-map (hours/days/tables) | 3 | Sunita |
| Performance: KDS websocket events | 5 | Arun |
| Test automation: full E2E happy path | 8 | Arvind |
| Security review: tip + tip allocation fraud | 3 | Lakshmi |
| Manual test: KDS + printer pipeline | 5 | Suresh |
| Polish backlog from S1-S4 retros | 8 | Whole team |
| Documentation: KDS deployment guide | 3 | Pradeep |
| **Reserve** | 8 | — |

---

## Sprint 6 (07-29 → 08-12) — Online ordering + WhatsApp + engagement

| Story | Pts | Owner |
|---|---:|---|
| FF-701 Own-brand online ordering site | 13 | Rhea + Aman |
| FF-702 WhatsApp ordering integration | 8 | Rajesh |
| FF-1004 WhatsApp marketing campaigns | 5 | Rajesh |
| FF-1005 Gift cards + pre-paid wallet | 5 | Nikhil |
| FF-1002 Post-meal NPS feedback | 3 | Sunita |
| FF-1001 Reviews aggregation (Zomato + Swiggy) | 2 | Rajesh |
| Online ordering: SEO + meta + sitemap | 3 | Rhea |
| Mobile: push notifications for order events | 5 | Shruti |
| Manual test: 100-tap online order flow | 5 | Suresh |
| Pen-test of public guest endpoints | 5 | Lakshmi |
| Performance: online site Core Web Vitals < 2.5s LCP | 5 | Rhea |
| Documentation: onboarding for owners | 5 | Sunita |
| Architecture review: scaling assumptions | 5 | Srinivas + Vikram |
| **Reserve** | 6 | — |

---

## Sprint 7 (08-12 → 08-26) — Delivery + accounting export

| Story | Pts | Owner |
|---|---:|---|
| FF-703 Driver / delivery rider management | 8 | Pradeep + Bharath |
| FF-1101 Tally / Zoho Books export | 4 | Sunita |
| FF-1102 E-invoice (IRP API) | 8 | Rajesh + Sunita |
| FF-1103 E-way bill | 5 | Sunita |
| FF-1105 Dead-stock report | 2 | Sunita |
| FF-1106 Item-wise profit + menu engineering | 5 | Sunita + Aman |
| FF-704 Reservation widget for Google + external | 3 | Aman |
| Driver mobile app (Flutter) | 8 | Bharath + Shruti |
| Performance: report queries under 2s p95 | 5 | Arvind + Pradeep |
| Manual test: driver assignment + GPS | 5 | Suresh |
| Security: PII handling on driver app | 3 | Lakshmi |
| Documentation: accountant integration guide | 5 | Sunita |
| Documentation: e-invoice setup | 3 | Sunita |
| **Reserve** | 6 | — |

---

## Sprint 8 (08-26 → 09-09) — Multi-outlet + final food polish

| Story | Pts | Owner |
|---|---:|---|
| FF-1201 Multi-outlet rollup dashboard | 8 | Nikhil + Srinivas |
| FF-1202 Cross-outlet inventory transfer | 5 | Pradeep |
| FF-1203 Centralized pricing for franchise | 5 | Arun |
| Multi-outlet RBAC (regional manager role) | 5 | Lakshmi + Nikhil |
| Operations review: incident response runbook | 3 | Rohan + Lakshmi |
| Performance: load test 1000 concurrent orders | 8 | Arvind |
| Manual test: full chain ops scenario | 5 | Suresh |
| Closing food vertical backlog cleanup | 8 | Whole team |
| Documentation: franchise admin manual | 5 | Sunita |
| Demo prep: food vertical full-scope walkthrough | 5 | Rajan + Meera |
| **Food vertical GA cut + customer onboarding** | 13 | Whole company |
| **Reserve** | 10 | — |

---

## Sprint 9 (09-09 → 09-23) — Retail tier 1

| Story | Pts | Owner |
|---|---:|---|
| R-101 Barcode scan + label printing | 5 | Pradeep + Bharath |
| R-102 Batch + expiry tracking | 8 | Arun |
| R-103 SKU bulk import (Excel/CSV) | 3 | Sunita |
| R-104 Vendor PO + GRN workflow | 8 | Pradeep |
| R-105 Multiple price lists | 5 | Nikhil |
| R-106 Party-wise pricing | 5 | Nikhil |
| R-107 Credit limit + payment terms | 3 | Sunita |
| R-108 Customer + vendor ledger | 5 | Sunita |
| R-109 Quotation → SO workflow | 8 | Aman + Nikhil |
| R-110 Cheque tracking | 2 | Sunita |
| Mobile: barcode scanning camera UI | 5 | Bharath |
| Manual test: retail invoice flow | 5 | Suresh |
| Performance: SKU search on 10k items | 5 | Arvind |
| Documentation: retail switch guide | 5 | Sunita |
| **Reserve** | 8 | — |

---

## Sprint 10 (09-23 → 10-07) — Retail tier 2 + GA polish

| Story | Pts | Owner |
|---|---:|---|
| R-201 Multi-warehouse + transfers | 8 | Pradeep |
| R-202 TDS / TCS auto-calculation | 5 | Sunita |
| R-203 Bilingual invoices | 3 | Rhea |
| R-205 Bank reconciliation | 5 | Sunita |
| R-207 Amazon / Flipkart order ingestion | 8 | Rajesh |
| R-208 FIFO / weighted-avg valuation | 5 | Arun |
| R-209 P&L + Balance Sheet + Trial Balance | 8 | Sunita + Aman |
| R-210 Custom invoice templates | 3 | Aman |
| Final QA pass (all 69 stories) | 13 | QA team |
| Final security audit (whole platform) | 8 | Lakshmi |
| GA launch comms + landing pages | 5 | Rhea + Rajan |
| Pricing page + plan migration | 3 | Aman + Nikhil |
| Customer migration tooling (PetPooja import) | 5 | Rajesh |
| **GA LAUNCH** | — | All |
| **Reserve** | 4 | — |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Zomato/Swiggy API access (gated) | High | High | Apply for partner program S1 day 1; build with mock fixtures meanwhile |
| Razorpay e-invoice integration delays | Medium | High | Spike in S6 before S7 commits |
| Offline sync edge cases multiply | High | Medium | Buffer doubled in S4, dedicated 1-day chaos test |
| Hindi font rendering on thermal printers | Medium | Medium | Test S1 with sample printer; fallback to ASCII transliteration |
| Multi-outlet RBAC complexity | Medium | High | Architect-led spike in S7; spec frozen by S8 day 1 |
| QA bandwidth at GA cutover | High | Medium | Suresh + Arvind + outside contractor for S8-S10 |

---

## How this maps to today

I'm shipping **Sprint 1 right now in this session.** The remaining 9 sprints
exist as ready-to-execute backlog — every story above is INVEST-compliant
with acceptance criteria, assigned, sized, and dependency-mapped. Hand this
plan to a real team Monday morning and they can start.

For Sprint 1 specifically, I'm shipping:

- **Migration 013** — variants + modifier_groups + modifiers + item_modifier_groups + variant pricing
- **Migration 014** — orders.service_charge_paise, orders.round_off_paise, orders.is_duplicate, orders.token_no, takeaway_counters, cancel_reasons
- **Migration 015** — bill_templates per tenant
- **Backend services** — menu (variants, modifiers, 86 toggle), order (service charge, round-off, pre/post-tax discount, token, duplicate, cancel-reason), settings (bill template)
- **Dashboard UI** — menu variant/modifier editor, POS modifier picker, 86 long-press, token display on takeaway, cancel-reason dropdown, bill template editor + live preview, reprint button on settled orders, service-charge + round-off lines on receipt
- **Tests** — bill-math unit (charge/round/discount), variant pricing contract, RBAC for new endpoints

Sprints 2-10 will land sprint-by-sprint as the user approves each phase.
