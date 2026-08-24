# FoodFlow — India Launch Roadmap

**Owner:** Shiv · **Drafted:** 2026-05-25 · **Horizon:** 12 months → 1,000 paying outlets

---

## Operating principles

1. **Stabilize before we scale.** No new features land until P0 security + test coverage + data-loss prevention are green. (Currently 3 P0s open, dev DB recently lost, no offline mode, ~5% test coverage.)
2. **Ruthlessly prioritize India-table-stakes over India-differentiators.** A dhaba owner won't pay for AI menu pricing if the POS dies when WiFi cuts out.
3. **One sprint = one shippable theme.** Sprints are 3 weeks. End of each sprint = something a real customer can use end-to-end, not an accumulation of half-done work.
4. **No DB destruction without explicit approval.** Migration scripts go through review. Test DB is hardcoded-isolated (already fixed).
5. **Sales > engineering for the first 50 customers.** No amount of features wins if distribution stalls. Engineering tracks each sprint's "what makes the next 10 outlets sign up?"

---

## Prioritization (RICE-lite)

For each item: **R** = reach (% of TAM affected) · **I** = revenue impact (1–5) · **C** = confidence (1–5) · **E** = effort (engineer-weeks).

Higher RICE = ship sooner. Below grouped by sprint, sorted descending.

---

## Sprint 0 — Stabilization (3 weeks, START HERE)

**Goal:** Stop bleeding. Fix the things that will burn a real customer in production.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 0.1 | Close remaining P1 security findings (JWT secret rotation, cookie flags, IDOR sweep, mass-assignment, refresh-token rotation) | 100% | 5 | 4 | 1.5 | **53** |
| 0.2 | Backend rate-limit production posture (no-op in dev, enforced in prod) | 100% | 4 | 5 | 0.2 | **100** |
| 0.3 | Hardcode-isolated test DB (DONE) + nightly automated pg_dump backup of dev/prod | 100% | 5 | 5 | 0.5 | **50** |
| 0.4 | Backend integration tests for ALL 23 route files (auth+RBAC+happy+error matrix) — target 80% coverage | 100% | 4 | 4 | 3 | **27** |
| 0.5 | Playwright E2E for 5 critical owner flows (signup → POS → collect → invoice → P&L) — never break | 100% | 4 | 4 | 2 | **40** |
| 0.6 | Sentry/Datadog APM for backend + mobile crash reporting | 100% | 4 | 5 | 1 | **20** |
| 0.7 | Database backup automation (pg_dump → S3 hourly, 30d retention) | 100% | 5 | 5 | 0.5 | **50** |
| 0.8 | Staging environment that mirrors prod (today there's only dev) | 100% | 4 | 4 | 1 | **16** |

**Sprint 0 outcomes:** zero open P0/P1 security, 80%+ backend test coverage, automated backups running, staging env live, real observability.

---

## Sprint 1 — India non-negotiables (3 weeks)

**Goal:** Make the product usable for the 60% of restaurants we're locked out of today.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 1.1 | **Offline-first POS** — local IndexedDB queue, syncs on reconnect. Order placement, KOT print, cash close all work offline. | 100% | 5 | 4 | 4 | **25** |
| 1.2 | **UPI Intent direct** (no Razorpay middleman) — generate UPI deep-link with intent://, fallback dynamic QR. Owners settle T+0 to bank. | 80% | 5 | 5 | 2 | **40** |
| 1.3 | **Hindi UI** + Devanagari thermal receipt printing (intl + flutter_localizations) | 60% | 5 | 4 | 2 | **18** |
| 1.4 | **Thermal printer support** (Bluetooth + USB, Epson/Star/ESC-POS protocol) | 70% | 4 | 4 | 2.5 | **18** |
| 1.5 | **Cash drawer reconciliation** (denomination split, variance, end-of-day close screen) | 50% | 3 | 5 | 1.5 | **20** |

**Sprint 1 outcomes:** mobile POS works on a Bluetooth-connected printer, accepts UPI, surfaces Hindi UI, runs offline through a power cut.

---

## Sprint 2 — GST + e-Invoice compliance (3 weeks)

**Goal:** Become installable for B2B businesses (>₹5cr turnover) — currently locked out.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 2.1 | **e-Invoice via NIC IRP** — register IRN/QR per B2B invoice, batch-retry on failure, signed PDF | 25% | 5 | 4 | 3 | **17** |
| 2.2 | **GSTR-1 export** in GSTN's JSON format (not just CSV) — drop into the portal in 1 click | 90% | 5 | 4 | 1.5 | **30** |
| 2.3 | **GSTR-3B summary export** | 90% | 4 | 4 | 1 | **29** |
| 2.4 | **Composition scheme (1%)** support — alternate invoice format, no input ITC, declared turnover cap | 30% | 3 | 4 | 1 | **14** |
| 2.5 | **e-Way Bill** generation for goods movement (B2B kitchens shipping inventory) | 10% | 3 | 3 | 2 | **5** |
| 2.6 | **HSN / SAC catalog** with auto-suggest based on item name | 100% | 3 | 5 | 1 | **15** |

**Sprint 2 outcomes:** any CA/accountant can file the full GST stack from FoodFlow exports in one sitting.

---

## Sprint 3 — Bar / liquor / excise (3 weeks)

**Goal:** Open up the 30% of TAM that runs alcohol licenses.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 3.1 | **Dual menu mode** (food vs. liquor, separate tax slabs, separate license tracking) | 30% | 5 | 4 | 2 | **30** |
| 3.2 | **Excise duty-paid pricing** with state-specific rates (MH/KA/TN/Goa) | 30% | 4 | 4 | 1.5 | **20** |
| 3.3 | **Pegs / bottles inventory model** with auto-deduct on pour | 30% | 4 | 4 | 1.5 | **20** |
| 3.4 | **Happy hour / time-based pricing** (KOT timestamp drives the price) | 30% | 3 | 5 | 1 | **22** |
| 3.5 | **Excise / FL-3 license reminder + document storage** | 30% | 3 | 5 | 0.5 | **22** |
| 3.6 | **Age-verification flow** for liquor billing (configurable per state) | 30% | 3 | 4 | 0.5 | **18** |

**Sprint 3 outcomes:** the Goa beach shack and the Bangalore brewpub are both on FoodFlow.

---

## Sprint 4 — Aggregator economics + growth UX (3 weeks)

**Goal:** Make owners *want* to upgrade to Pro by showing them money they're losing.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 4.1 | **Aggregator margin dashboard** — net P&L after Swiggy/Zomato commission, hour-by-hour | 70% | 5 | 5 | 2 | **45** |
| 4.2 | **"What Swiggy cost you this month" weekly email/WA** | 70% | 4 | 5 | 0.5 | **140** |
| 4.3 | **Aggregator price-up rules** — automatically markup menu by 25% on aggregators | 70% | 5 | 4 | 1.5 | **47** |
| 4.4 | **Tab / khaata for regulars** — phone-based credit, weekly settlement, WhatsApp reminders | 50% | 4 | 4 | 2 | **20** |
| 4.5 | **Festive promotion engine** — Diwali/Holi/Eid/Onam templates, auto-discount, banner upload | 80% | 4 | 4 | 1.5 | **30** |
| 4.6 | **WhatsApp Business API** template approval flow for receipts/reminders/marketing | 100% | 5 | 4 | 2 | **40** |

**Sprint 4 outcomes:** owner sees in big numbers how much Swiggy is costing them. The marketplace tab finally has things people *want* to buy.

---

## Sprint 5 — Hardware + offline polish (3 weeks)

**Goal:** Match PetPooja's hardware story without owning the supply chain.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 5.1 | **Partner-tested printer catalog** (Epson TM-T82, Star SP742, Citizen CT-S310II) with one-tap pairing | 70% | 4 | 4 | 1 | **22** |
| 5.2 | **Cash-drawer kick** via printer pulse | 30% | 3 | 5 | 0.5 | **18** |
| 5.3 | **Bluetooth scale integration** (for kg-priced items in cloud kitchens) | 10% | 2 | 4 | 1 | **3** |
| 5.4 | **Sync conflict resolution UI** — when offline order + online order collide on same table | 50% | 4 | 4 | 1.5 | **21** |
| 5.5 | **Multi-device merging** (POS + KDS + Captain all sync without conflicts) | 60% | 4 | 4 | 2 | **20** |

**Sprint 5 outcomes:** A first-time owner unboxes a ₹3k printer, pairs in 60 seconds, prints a Hindi receipt with kitchen copy.

---

## Sprint 6 — Multi-outlet + franchise (3 weeks)

**Goal:** Unlock the 5–50 outlet segment which Posist owns today.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 6.1 | **Outlet group hierarchy** (already started — needs full UI + reporting) | 15% | 5 | 4 | 2.5 | **12** |
| 6.2 | **Central kitchen mode** — recipe push, ingredient distribution, FIFO/FEFO | 15% | 5 | 4 | 3 | **10** |
| 6.3 | **Cross-outlet inventory transfer** with e-Way Bill | 15% | 4 | 3 | 2 | **9** |
| 6.4 | **Franchise reporting roll-up** (HO sees all outlets' P&L in one view) | 15% | 4 | 4 | 1.5 | **16** |
| 6.5 | **Outlet-level pricing override** (Mumbai vs. Patna pricing on the same chain) | 15% | 4 | 5 | 1 | **30** |
| 6.6 | **Brand-level menu master with outlet variants** | 15% | 4 | 4 | 1.5 | **16** |

**Sprint 6 outcomes:** a 10-outlet biryani chain can run their whole back office on FoodFlow.

---

## Sprint 7 — AI-led features (3 weeks)

**Goal:** Build the defensible differentiator that incumbents will take 2 years to retrofit.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 7.1 | **Voice POS in Hindi / Tamil** (Whisper-large-v3 + custom menu vocab) | 40% | 4 | 3 | 3 | **16** |
| 7.2 | **AI menu price recommender** — based on local competitor scraping + festive demand | 30% | 4 | 3 | 4 | **9** |
| 7.3 | **Inventory demand forecast** per festival (samosa demand x3 on Diwali) | 30% | 4 | 3 | 3 | **12** |
| 7.4 | **Smart upsell prompts** at POS ("they bought masala chai — also pitch samosa?") | 60% | 3 | 4 | 1.5 | **48** |
| 7.5 | **Bilingual receipt** (English + Hindi/regional) auto-printed | 60% | 3 | 5 | 0.5 | **180** |
| 7.6 | **Customer-review summary** (aggregate Zomato/Swiggy reviews → "your dosa is mid") | 50% | 3 | 4 | 1.5 | **40** |

**Sprint 7 outcomes:** voice ordering works for "do chai aur ek samosa", upsell prompts visibly drive AOV.

---

## Sprint 8 — Distribution-readiness (3 weeks)

**Goal:** Build the tooling that lets us *sell*, not just ship.

| # | Item | R | I | C | E | RICE |
|---|---|---|---|---|---|---|
| 8.1 | **Tally integration** (push daily P&L, expenses, sales to Tally — every Indian CA wants this) | 100% | 5 | 4 | 2.5 | **80** |
| 8.2 | **FSSAI license renewal reminder** + document upload + consultant referral | 80% | 3 | 5 | 0.5 | **240** |
| 8.3 | **Shops & Establishment / Trade License reminder** | 80% | 3 | 5 | 0.5 | **240** |
| 8.4 | **Sales-led signup with assisted onboarding** (CSM books a 30-min call, configures menu live) | 100% | 5 | 5 | 1 | **25** |
| 8.5 | **Referral / partner program** (CAs, consultants, NSDL agents get 20% rev share) | 60% | 5 | 4 | 1.5 | **80** |
| 8.6 | **Public marketing site** (foodflow.in) with pricing / blog / SEO / case studies | 100% | 5 | 4 | 2 | **40** |
| 8.7 | **Open developer docs site** (api.foodflow.in/docs) for integration partners | 30% | 3 | 4 | 1 | **36** |

**Sprint 8 outcomes:** CAs are recommending FoodFlow to their clients. The marketing site converts. We have a referral funnel.

---

## Outside the sprint plan (do later, after 1k outlets)

- ONDC seller integration (government push but adoption is anemic — wait for the market)
- Lender partnerships (KreditBee / Lendingkart funding off our P&L data)
- Embedded supplier marketplace (high CapEx; revisit at 5k outlets)
- Drone delivery integration (technology is too immature in India today)
- ESG / FSSAI scorecard for franchise sale prep

---

## Cross-sprint, always-on workstreams

1. **Test coverage** — every sprint adds tests proportional to new code. End-of-quarter target: 80% backend, 60% web, 40% mobile.
2. **Security audit** — quarterly third-party audit (Penetration testing firm in Bengaluru, ~₹2 lakh per engagement).
3. **Customer feedback loop** — weekly call with 3 active outlets, transcribed, themed, fed to sprint planning.
4. **Performance budget** — P95 API < 200ms, mobile cold start < 2.5s, dashboard initial paint < 1.5s. Regress = revert.
5. **Compliance review** — every payment / GST / KYC feature reviewed by a CA before launch.

---

## Resource needs (honest)

To execute this 8-sprint plan in 6 months we need:

| Role | Headcount | Existing | Gap |
|---|---:|---:|---:|
| Backend (Node) | 3 | 1 (you) | 2 |
| Frontend (React) | 2 | 1 (you) | 1 |
| Mobile (Flutter) | 2 | 1 (you) | 1 |
| QA / SDET | 1 | 0 | 1 |
| DevOps | 1 | 0 | 1 |
| Designer | 1 | 0 | 1 |
| Tech writer / docs | 0.5 | 0 | 0.5 |
| **Total** | **10.5** | **1** | **9.5** |

If we can't hire: stretch the timeline to 12 months and ship one sprint per ~6 weeks instead of 3.

---

## Success metrics — what good looks like in 12 months

| Metric | Today | 12-month target |
|---|---:|---:|
| Paying outlets | 1 | 1,000 |
| MRR | ₹0 | ₹4 lakh |
| Free-to-paid conversion | n/a | 8% |
| Monthly churn | n/a | < 3% |
| Outage minutes / month | unmeasured | < 30 |
| P0 security findings open | 0 ✓ | 0 |
| Backend test coverage | ~5% | 80% |
| NPS | n/a | > 40 |
| Setup-to-first-sale time | unmeasured | < 15 min |
| Aggregator API uptime | unmeasured | > 99.5% |

---

## Top 5 risks (and what we do about them)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Friday-evening outage during festive season | High | Brand-killing | Sprint 0 backups, Sprint 1 offline POS, Sprint 0 staging + APM |
| PetPooja copies our UX | Medium | Existential | Move faster on AI/voice differentiators (Sprint 7), build distribution moat (Sprint 8) |
| Razorpay rate-limits us | Medium | Revenue blocker | Sprint 1 direct UPI Intent removes single-vendor risk |
| GSTN API changes break filing | High (annual) | Customer-trust hit | Sprint 2 abstraction layer + monitoring; quarterly compliance review |
| We can't hire 9 engineers | Very high | Timeline doubles | Phased plan that defers Sprints 5–8 if needed |

---

## Approval gates (where the team explicitly stops + reviews)

- **End of Sprint 0:** Founder + CTO sign-off on "no P0/P1 open, backups proven, staging live"
- **End of Sprint 2:** CA reviews GST compliance before any e-Invoice goes to a real customer
- **End of Sprint 3:** Legal review of liquor / age-verification flows before Goa launch
- **End of Sprint 6:** First 100 outlets check — if we're below 100, halt expansion sprints and double down on distribution
- **End of Sprint 8:** Series A pitch deck refreshed with real metrics

---

## What I'll do right now (this conversation)

You tell me which sprint or which specific item from any sprint to tackle first. I'll:
1. Convert the sprint plan into concrete code-level tasks (1-day-each tickets)
2. Write specs / DB migrations / route stubs as needed
3. Implement in batches, you run, we iterate

**My recommendation: Sprint 0 first.** Without it, every feature in Sprints 1–8 is built on sand. Specifically:
- Close the 3 P0 security fixes (already done) + 13 P1 items in AUDIT.md
- Get backups automated (single biggest hedge against repeat data-loss)
- Get test coverage to 50%+ on the existing surface
- Set up staging

Then we open Sprint 1 with Offline POS as the headline feature.

Tell me: **Sprint 0?** Or do you want to pick a specific sprint / item to start with?
