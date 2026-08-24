# FoodFlow — Launch Plan

**Owner:** Shiv · **Drafted:** 2026-05-25 · **Strategy:** Soft beta → geographic → public

This document is the post-launch backlog. Everything in `ROADMAP.md` that's
NOT in the 2-week pre-launch checklist below is deferred until real customers
tell us they need it.

---

## TL;DR

1. **Spend 2 weeks doing only the 12 P0/P1 items in Phase 0.** Don't touch the broader roadmap.
2. **Launch with 3–5 hand-picked beta customers.** Free for 90 days. Personally onboard each.
3. **Six to eight weeks of beta** to surface what customers ACTUALLY break.
4. **Then** decide: scale up to a paid Bangalore cloud-kitchen launch (Option B) or pivot based on what beta taught us.
5. **Public open-signup launch is at least 4 months away.** Do not enable it earlier.

---

## Phase 0 — Pre-launch (2 weeks, before any customer)

### Week 1 — Don't-embarrass-yourself

| ✅ | Item | Owner | Effort | Why it can't slip |
|---|---|---|---|---|
| ✅ | P0 security: upload auth + path traversal + WhatsApp signature | done | done | Already shipped |
| ✅ | Automated hourly DB backups + weekly verification | done | done | Already shipped |
| ⬜ | Sentry free-tier crash reporting (backend + mobile + dashboard + admin) | Shiv | 4h | Without this, outages = angry WhatsApps |
| ⬜ | P1 security sweep: IDOR check on every `/businesses/:id/*` route | Shiv | 4h | One leaked customer's bank rec = brand-killing |
| ⬜ | P1 security sweep: cookie HttpOnly/Secure/SameSite flags audit | Shiv | 1h | XSS exposure |
| ⬜ | P1 security sweep: JWT secret rotation policy documented + monitored | Shiv | 1h | If JWT_SECRET leaks, every active token is forged |
| ⬜ | Staging environment (one extra Docker compose targeting `foodflow_staging` DB) | Shiv | 3h | Never push untested code straight to dev |
| ⬜ | Manual disaster-recovery runbook (one page, copy-paste commands) | Shiv | 1h | At 9pm Friday you don't want to be googling |

### Week 2 — Onboarding-survivable

| ✅ | Item | Owner | Effort | Why |
|---|---|---|---|---|
| ⬜ | First-time setup wizard on mobile + dashboard (business info → menu CSV import → first POS sale) | Shiv | 8h | New customer abandons in <5 min if confused |
| ⬜ | "Network down" graceful screen on mobile (queue + retry, no crash) | Shiv | 4h | Not full offline POS, just stop the worst behaviour |
| ⬜ | WhatsApp support button in-app pointing to Shiv's WhatsApp | Shiv | 30 min | Be reachable. Customers expect it. |
| ⬜ | Plain-English error messages everywhere (no raw `DioException` text) | Shiv | 4h | Today's mobile shows raw stack traces |
| ⬜ | Landing page at foodflow.in (Notion or single HTML page is fine) | Shiv | 4h | Need somewhere to point people to |
| ⬜ | Pricing page matching plans (Starter free / Pro ₹299 / Enterprise ₹799) | Shiv | 2h | Today there isn't one |

**Phase 0 budget:** ~35 engineering hours. Roughly one focused week if no interruptions, two weeks at normal pace.

**Definition of done:** All 14 items ticked, you can run `./scripts/backup-db.sh`, see a Sentry test event, swap dev → staging cleanly, and an outside friend can complete signup → first POS sale without coaching.

---

## Phase 1 — Soft beta (6–8 weeks, customer count 0 → 5)

### Customer profile (in priority order)

1. **Cloud kitchens in Bangalore / Mumbai** — already digital-native, smartphone-first, hate Posist's price
2. **Coffee chains under 5 outlets** — high transaction volume, simple menu, ideal Pro plan prospect
3. **Family / friends running cafés or restaurants** — forgiving feedback loop
4. **Tier-2 city dhabas** — only if you have a personal contact; otherwise too far from your distribution

### Acquisition (zero ad spend — your network only)

- Ask 20 people in your network for 1 restaurant introduction each
- LinkedIn message template to old colleagues running F&B
- Post in WhatsApp groups (school/college/professional)
- Walk into 5 cafés near you with a one-pager + demo on your phone
- Do not run paid ads. Do not buy lead lists. Word-of-mouth only.

### Beta deal terms

- **Free for 90 days** — no card, no commitment
- After day 90: convert to Starter free (with usage caps) OR Pro ₹299
- In return: weekly 15-min feedback call + signed permission to use them as a case study

### Customer onboarding playbook (each customer, ~2 hours total)

1. **Pre-call** — they fill a Google Form (business name, GSTIN if any, menu items count, phone OS Android/iOS)
2. **Video call onboarding (60 min)**:
   - Manual account setup via admin (you create the business + Pro trial)
   - Walk through mobile app: POS, KDS, menu editor
   - Live demo: place 1 order end-to-end, collect cash, view P&L
   - Add them to the FoodFlow customers WhatsApp group
3. **Day 1 follow-up** — "How was your first day? Anything broken?"
4. **Days 2–7 daily check-in** — WhatsApp, 1 question each: "what did you use today?", "what failed?", "what did you miss?"
5. **Week 1 retro** — 30 min Zoom: top 3 wins, top 3 pain points, anything they hated
6. **Weeks 2–8 weekly retro** — 15 min, same questions, track changes

### Beta scorecard (track per customer, weekly)

| Customer | Daily orders | Active users | Reported bugs | Feature asks | Likely to pay? (Y/N/?) |
|---|---:|---:|---:|---:|---:|
| C1 | — | — | — | — | — |
| C2 | — | — | — | — | — |
| C3 | — | — | — | — | — |
| C4 | — | — | — | — | — |
| C5 | — | — | — | — | — |

### Beta success criteria (graduates to Phase 2)

- ≥ 3 of 5 customers using the app every day in week 6+
- ≥ 3 of 5 customers verbally committed to paying after free period
- Top 3 feature asks are CLEAR and overlap (signal, not noise)
- Zero P0 outages in the last 4 weeks
- Sentry shows < 5 user-visible errors/week per customer

### Beta failure criteria (forces a pivot or restart)

- < 2 customers using daily by week 4 → product-market fit is off; talk to 20 prospects to find a better segment
- > 1 P0 outage that loses real orders → halt acquisition, fix root cause + add tests for that surface
- All 5 want the SAME missing feature (e.g. "I need printer support") → that feature jumps to top of Phase 1.5 before continuing

---

## Phase 1.5 — Inline patches during beta

These get built ONLY when a beta customer asks for them. NOT pre-built.

The likely top-5 (best guesses — let real customers reorder this):

1. Thermal printer support (Bluetooth + USB Epson/Star)
2. Cash-drawer reconciliation at end-of-day
3. Hindi UI (if a non-Bangalore customer joins)
4. Full offline POS with sync queue (if a customer hits a real outage)
5. Aggregator margin dashboard (likely cloud-kitchen ask)

**Process:** customer asks → confirm with at least one other customer → spec → ship in ≤ 2 weeks → confirm they use it.

---

## Phase 2 — Geographic launch (months 3–6)

Triggered by Phase 1 success criteria above.

### Targets

- 50 paying outlets in Bangalore cloud-kitchen segment
- ₹50k–₹2L marketing budget (referral incentives + targeted LinkedIn ads)
- Hire 1 customer success person (part-time / contractor) once at 20+ customers

### Phase 2 features to build BEFORE expanding

Compiled from beta feedback. Placeholder list (will be replaced by real asks):

- Full offline POS (best guess: this WILL come up)
- Thermal printer support
- Aggregator margin dashboard
- WhatsApp Business API templates for receipts + reminders
- Tab/khaata for regulars
- Multi-floor / outlet group management (for the first 2-outlet customer)

### Phase 2 graduation triggers

- 50+ paying outlets
- MRR ≥ ₹50k
- Monthly churn < 5%
- NPS ≥ 30
- Zero P0 outages for 8 consecutive weeks

---

## Phase 3 — Public launch (months 6–12)

Triggered by Phase 2 success criteria.

### Pre-requisites

- ≥ 80% backend test coverage
- ≥ 60% web E2E coverage
- ≥ 40% mobile widget/integration coverage
- 24x7 on-call rotation (you + 1 hire)
- Self-service signup + onboarding (no human required)
- Public docs site
- Status page (status.foodflow.in)
- Refund policy + terms of service + privacy policy reviewed by a lawyer
- ISO 27001 / SOC 2 prep started (if going after enterprise)

### Public launch features (the big roadmap items deferred until now)

The full `ROADMAP.md` sprints 1–8 become candidates here. Re-prioritise based on what beta + geographic launch revealed.

---

## Post-launch backlog (deferred — see ROADMAP.md for details)

Everything below is in the order it SHOULD ship, BUT real customer asks override this:

### Compliance batch (defer until first B2B customer)
- e-Invoice via NIC IRP
- GSTR-1 / 3B export in GSTN JSON format
- Composition scheme support
- e-Way Bill generation
- HSN/SAC catalog with auto-suggest

### Hardware batch (defer until first customer asks)
- Bluetooth thermal printer support
- USB ESC/POS printer support
- Cash drawer kick via printer pulse
- Bluetooth scale integration

### Localisation batch (defer until first non-English customer)
- Hindi UI (full mobile + dashboard)
- Tamil UI
- Kannada UI
- Devanagari thermal receipt printing

### Liquor batch (defer until first Goa/Mumbai bar)
- Dual menu mode (food vs liquor)
- Excise duty-paid pricing
- Pegs/bottles inventory
- Happy-hour pricing
- FL-3 license storage + reminders
- Age verification

### Multi-outlet batch (defer until first 2-outlet customer)
- Outlet group hierarchy UI
- Central kitchen mode
- Cross-outlet inventory transfer
- Franchise reporting roll-up
- Outlet-level pricing override
- Brand-level menu master

### Aggregator economics batch (defer until first cloud-kitchen customer)
- Aggregator margin dashboard
- Weekly "Swiggy cost you ₹X" report
- Aggregator price-up rules
- Aggregator API uptime monitoring

### AI batch (defer until at least 100 outlets)
- Voice POS in Hindi / Tamil
- AI menu price recommender
- Inventory demand forecast per festival
- Smart upsell prompts at POS
- Customer-review summary

### Distribution batch (defer until ready for paid acquisition)
- Tally integration (push daily P&L)
- FSSAI / Shops & Establishment reminder
- Sales-led signup with assisted onboarding
- CA referral program
- Public marketing site with case studies
- Developer docs site

### Tech debt batch (always-on; chip away during sprints)
- Backend integration test coverage to 80%
- Frontend E2E coverage to 60%
- Mobile widget test coverage to 40%
- ESLint strict + TS strict mode
- Performance budget (P95 API < 200ms, mobile cold start < 2.5s)
- Quarterly third-party security audit

---

## Decision triggers (when to re-read this doc)

| Trigger | Action |
|---|---|
| First customer signs up | Open daily metrics tracker; start the beta scorecard above |
| Customer #1–5 hits a P0 bug | Pause acquisition. Fix + add tests + monitoring for that surface. |
| Same feature asked by ≥ 3 customers | Promote it from "deferred" to next sprint |
| Customer says "I'll leave if you don't add X" | Discount + commit to a date OR let them go and learn |
| MRR crosses ₹10k / ₹50k / ₹2L | Re-read this doc; re-evaluate which phase you're in |
| You're considering paid ads | Re-read Phase 2 graduation triggers; do NOT advertise before 50 paying outlets |
| Competitor (PetPooja/Posist) launches something that mirrors us | Don't react. Re-read your beta feedback. Build what YOUR customers asked for. |

---

## Risks (top 5)

| Risk | Probability | Mitigation |
|---|---|---|
| First customer hits a P0 outage during Friday dinner rush | High | Sentry + staging + manual incident playbook (all Phase 0) |
| No customer signs up in 4 weeks | Medium | Pivot acquisition message; talk to 20 prospects; don't quit |
| Beta customer churns immediately | Medium | Daily check-ins in week 1 catch most reasons; ask for 30-min exit interview |
| You burn out doing manual onboarding for 5 customers | High | Cap beta at 5 customers max; do NOT take a 6th until first 5 are stable |
| PetPooja copies us | Low (early) → Medium (after PR) | Differentiate on price + mobile-first UX + AI; don't fight on features |

---

## Beta customer wishlist (start filling this as soon as you reach out)

| # | Name | Business | City | Smartphone OS | Connection from your network | Status |
|---|---|---|---|---|---|---|
| 1 | — | — | — | — | — | — |
| 2 | — | — | — | — | — | — |
| 3 | — | — | — | — | — | — |
| 4 | — | — | — | — | — | — |
| 5 | — | — | — | — | — | — |

Fill in the next 24 hours. Aim for first conversation with 3 of them by end of next week.

---

## Anti-goals (things explicitly NOT to do pre-launch)

- ❌ Run paid ads (Google / Meta / LinkedIn)
- ❌ Hire engineers / sales reps
- ❌ Build features from this doc's roadmap section that nobody asked for
- ❌ Promise compliance features (e-Invoice, GSTR direct filing) we haven't built
- ❌ Take >5 beta customers (you'll burn out)
- ❌ Discount below ₹299 except for the 90-day free period
- ❌ Add a customer outside your network in the first 5
- ❌ Compare yourself to PetPooja in marketing copy (positioning by attack ≠ winning)
- ❌ Build a chatbot, build an AI assistant, build a mobile-PWA — focus
- ❌ Run a Product Hunt launch before Phase 3

---

## What I will help with (the AI / dev assistant)

Whichever Phase 0 item you assign me. In rough priority order:
1. Setup wizard (mobile + dashboard) — 1 day
2. Plain-English error messages (mobile) — half day
3. WhatsApp support button in app — 30 min
4. Sentry integration code (you create the project on sentry.io; I wire it up) — 2 hours
5. Staging Docker compose — 2 hours
6. P1 security sweep audit (read-only first; fixes in batches) — 1 day
7. Landing page HTML (single-file, no React build) — 2 hours
8. Pricing page that pulls from /plans — 1 hour
9. Disaster-recovery runbook — 30 min

Tell me which to tackle next and I start writing code or scripts.

---

## Sign-off

This plan stays valid until either:
- 30 days pass with no customer signups (force a pivot conversation)
- 5 paying customers (graduates to Phase 2)
- A founder-level strategy change

Re-read every 4 weeks. Update the scorecards. Don't drift.
