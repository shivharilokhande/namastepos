# NamastePOS — Super-Admin Review, Plan Strategy & Path to Unicorn
**Prepared 26 Aug 2026 · Review only, no code changes**

This document (1) reviews the current super-admin, (2) lists what's missing / broken and what to add for a *standard, compliant* SaaS admin + CRM, (3) restructures pricing into five plans (Starter · Growth · Pro · Advanced · Enterprise) with a feature matrix and add-on pricing anchored to research, (4) gives an SEO-audit summary, and (5) lays out the profitability / "unicorn" moves across super-admin and the business-owner dashboard.

---

## 1. What the super-admin has today (inventory)

**Overview:** Dashboard (MRR ₹799, ARR, customers, orders 30d, GMV, active subs, signups chart, by-plan pie), Reports, Metrics.
**Customers:** Customers list, Customer detail with drilldown (orders, invoices, staff, addons, menu, CRM, notes), CRM (follow-up tasks + renewals 7/14/30d).
**Revenue:** Plans (3 tiers, per-plan limits + feature multi-select), Add-ons (Online Orders ₹149, Loyalty ₹99, WhatsApp ₹199, Multi-outlet, Recipe/Food Cost, Custom Branding), Coupons, Finance, Refunds (Razorpay), GST & Tax (GSTR export).
**Operations:** Audit log, Webhooks, Admin team (RBAC: super_admin / finance / support / sales), Platform settings (KV: platform.gstin, tax_pct, HSN, brand, etc.), 2FA (TOTP).

**Verdict:** genuinely strong for an early product — RBAC, 2FA, audit log, plan/feature engine, add-ons, refunds and GST export already exist. The gaps are in *depth* (CRM, analytics, self-serve tooling) and *compliance hardening*, not basics.

---

## 2. What's not working / needs fixing

1. **Plan-limit misconfig (live bug):** Growth = 20 menu items while free Starter = 30. Growth must be ≥ Starter. (Fix: set Growth menu_items to unlimited or ≥100.)
2. **Only 3 plans; you want 5.** Starter/Growth/Enterprise today → add Pro and Advanced (section 6).
3. **Dashboard is vanity-metric only.** No churn, MRR movement (new/expansion/contraction/churned), trial→paid conversion, LTV, ARPU, activation rate, or cohort retention — the numbers a SaaS actually runs on.
4. **CRM is a stub.** Only follow-up tasks + renewals. No lifecycle stages, health score, activity timeline, segments, email/WhatsApp outreach, or notes-at-scale.
5. **No self-serve growth loops in admin:** no impersonate-to-support UX beyond basics, no in-app announcement/broadcast, no feature-flag/rollout console, no trial-extension automation, no dunning (failed-payment recovery).
6. **Billing is Razorpay-live-dependent** (KYC pending) — subscription activation, invoices and refunds only fully work once Razorpay is live. (GST-compliant invoice PDF is now built and prod-ready.)
7. **Compliance gaps** (section 5): no data-retention policy UI, no PII masking/redaction in admin, no admin session timeout / IP allowlist, no DPDP grievance-officer workflow surfaced, no export/delete-my-data (DSAR) tooling.

---

## 3. Standard super-admin features to ADD (prioritized)

### P0 — run the business (do first)
- **Real SaaS metrics dashboard:** MRR with movement waterfall (new / expansion / contraction / churn / reactivation), ARR, ARPU, LTV, gross/net revenue retention, trial→paid %, activation rate, logo & revenue churn, DAU/WAU/MAU. Date-range + cohort views.
- **Dunning / failed-payment recovery:** auto-retries, email/WhatsApp reminders, grace period, auto-downgrade on non-payment. This alone recovers 5–10% of MRR.
- **Trial & lifecycle automation:** trial countdown, auto-nudges at day 3/7/13, one-click extend, win-back sequences for churned.
- **Customer health score + lifecycle stages:** trial / activated / at-risk / churned, computed from login recency, order volume, feature adoption — surfaced on Customers list and detail.
- **Fix the plan-limit bug + move to 5 plans.**

### P1 — scale support & growth
- **Full CRM:** activity timeline per account (logins, orders, tickets, emails), segments/saved filters, bulk actions, notes with @mentions, task assignment across the admin team.
- **In-app broadcast / announcement center:** target by plan/segment, banners + email + WhatsApp; changelog feed.
- **Feature-flag & rollout console:** toggle features per tenant/segment, gradual rollout, kill-switch (you already have a feature catalog — expose flags).
- **Impersonation with audit + read/write scoping** (partially exists) — one-click "view as owner" for support, fully logged.
- **Support inbox / ticketing** or a tight integration (email-to-ticket), SLA timers.
- **Reseller / partner console:** referral tracking, commission, sub-accounts (you already have a reseller one-pager — operationalize it here).

### P2 — polish & intelligence
- **Revenue analytics:** cohort retention curves, plan-migration Sankey, add-on attach rate, discount leakage from coupons.
- **Churn prediction & save-offers** (rule-based first, ML later).
- **Data exports & scheduled reports** (CSV/email) for finance.
- **Multi-currency & multi-country readiness** (already partially in schema) for expansion.
- **Status page + incident comms** for uptime trust.

---

## 4. Standard **business-owner dashboard** additions (drives retention + expansion)
- **Owner "home" scorecard:** today's sales, covers, top items, low-stock, staff on shift — the first screen every morning.
- **Benchmarks:** "your avg order value vs similar restaurants in your city" (aggregate, anonymized) — sticky and unique.
- **Guided onboarding checklist** with progress → boosts activation (the #1 lever for trial→paid).
- **In-app upgrade prompts** at the moment of limit-hit (e.g., "you've hit 30 menu items — upgrade to add more") → expansion revenue.
- **WhatsApp/SMS campaign builder**, review requests, and loyalty dashboards (monetizable add-ons).
- **Accountant access** (read-only role + GST export) — reduces churn at filing time.

---

## 5. Compliance checklist ("compliant in all ways")

**India-specific**
- **DPDP Act 2023:** publish privacy policy (done), appoint & surface a **Grievance Officer**, consent capture + withdrawal, **DSAR tooling** (export/delete a data principal's data) in super-admin, breach-notification process, data-retention schedule.
- **GST / e-invoicing:** GST-compliant invoices (built), GSTR-1/3B export (exists), e-invoice IRN once turnover crosses threshold, correct HSN/SAC, TDS/TCS where applicable.
- **Payments (PCI-DSS):** never store card data — delegate to Razorpay (SAQ-A scope). Confirm no PAN/CVV ever touches your servers/logs.
- **Business registration:** GST registration (pending), FSSAI not applicable to SaaS, company PAN, terms & refund/cancellation policy (published).

**Security / SaaS trust**
- **RBAC** (have), **2FA** (have), **audit log** (have) → add: **admin session timeout**, **IP allowlist for admin**, **least-privilege review**, **break-glass access with approval**, **PII masking** in admin views, **immutable/exportable audit trail**.
- **Encryption** in transit (TLS, have) + at rest (confirm Neon/Render), **secrets management** (env, have), **backups + tested restore / DR runbook**, **rate limiting** (have).
- **SOC 2 Type II / ISO 27001** — aspirational but a real enterprise-sales unlock; start a lightweight controls matrix now (you have the audit-support skill).
- **Accessibility (WCAG 2.1 AA)** on dashboard + landing — also an SEO/UX win.
- **Uptime/SLA** commitments for paid tiers + status page.

---

## 6. Recommended 5-plan structure (Starter · Growth · Pro · Advanced · Enterprise)

Pricing anchored to the Indian restaurant-POS market (competitors commonly ₹300–₹1,500/mo per outlet, often + setup fees and unbundled add-ons). NamastePOS positioning = **all-inclusive, mobile-first, no lock-in, undercut on total cost**. Prices are **per outlet/register, per month; yearly = 2 months free**.

| Plan | Monthly | Yearly | Who it's for |
|---|---|---|---|
| **Starter** | ₹0 | ₹0 | Single counter / new outlet trying it out |
| **Growth** | ₹399 | ₹3,990 | Small cafés, QSR, single counter going pro |
| **Pro** ⭐ | ₹799 | ₹7,990 | Full-service single-outlet restaurant *(most popular)* |
| **Advanced** | ₹1,499 | ₹14,990 | High-volume / multi-station, inventory + accounting heavy |
| **Enterprise** | ₹2,999+ / custom | custom | Chains, franchises, multi-outlet, API/white-label |

### Limits by plan

| Limit | Starter | Growth | Pro | Advanced | Enterprise |
|---|---|---|---|---|---|
| Outlets | 1 | 1 | 1 | up to 3 | Unlimited |
| Registers/counters | 1 | 2 | 3 | 5 | Unlimited |
| Staff logins | 2 | 5 | 15 | Unlimited | Unlimited |
| Menu items | 50 | Unlimited | Unlimited | Unlimited | Unlimited |
| Monthly orders | 500 | 5,000 | Unlimited | Unlimited | Unlimited |
| Support | Community | Email | Priority email | Priority + phone | Dedicated + SLA |

*(Starter menu items raised to 50 so paid tiers are always ≥ free — fixes the current bug.)*

### Feature matrix (● included · ◐ add-on · — not available)

| Capability | Starter | Growth | Pro | Advanced | Enterprise |
|---|---|---|---|---|---|
| Billing & POS, KOT, token | ● | ● | ● | ● | ● |
| Tables (single floor) | ● | ● | ● | ● | ● |
| Multi-floor tables | — | ● | ● | ● | ● |
| Menu variants & modifiers | — | ● | ● | ● | ● |
| GST invoices (basic) | ● | ● | ● | ● | ● |
| Offline mode | ● | ● | ● | ● | ● |
| QR self-ordering | — | ● | ● | ● | ● |
| Captain & KDS | — | ● | ● | ● | ● |
| Customer directory | ● | ● | ● | ● | ● |
| Customer CRM | — | ● | ● | ● | ● |
| Loyalty & wallet | — | ◐ | ● | ● | ● |
| WhatsApp marketing | — | ◐ | ◐ | ● | ● |
| Aggregators (Zomato/Swiggy) | — | ◐ | ◐ | ● | ● |
| Reservations | — | — | ● | ● | ● |
| Inventory & recipe costing | — | — | ● | ● | ● |
| Advanced reports & P&L | — | ● | ● | ● | ● |
| Accounting (P&L/BS), bank rec | — | — | — | ● | ● |
| GST tax invoices + e-invoice | — | — | ● | ● | ● |
| Dish wastage, dead-stock, forecast | — | — | — | ● | ● |
| Surge pricing, heat-map | — | — | — | ● | ● |
| Multi-outlet & consolidated reports | — | — | — | ◐ (3) | ● |
| API access | — | — | — | — | ● |
| White-label | — | — | — | — | ● |
| Priority / dedicated support | — | — | ● | ● | ● (SLA) |

### Add-on pricing (à la carte, per outlet / month)

| Add-on | Price | Notes |
|---|---|---|
| Online Orders / Aggregators | ₹149 | Free on Advanced+ |
| Loyalty & Cashback | ₹99 | Free on Pro+ |
| WhatsApp Marketing | ₹199 | Free on Advanced+ |
| Recipe & Food Cost | ₹149 | Free on Pro+ |
| Custom Branding (white-label receipts) | ₹199 | Free on Enterprise |
| Extra register | ₹149 / register | Beyond plan limit |
| Extra outlet | ₹499 / outlet | Beyond plan limit |
| e-Invoice (IRN) | ₹99 | Free on Pro+ |
| Priority support | ₹299 | Free on Pro+ |
| Payment gateway | rev-share / MDR | New revenue line (see §8) |
| Hardware bundle (printer/scanner) | one-time | Reseller margin |

**Why this works:** free plan drives acquisition; Growth→Pro is the volume band; Advanced captures inventory/accounting-heavy operators at a premium; Enterprise is land-and-expand for chains. Add-ons let price-sensitive owners start cheap and expand — expansion revenue is the #1 SaaS growth lever.

---

## 7. SEO audit — quick summary (marketing:seo-audit)

**Done / strong:** fast static site, mobile-friendly, HTTPS, robots.txt, sitemap (submitted to Google + Bing), JSON-LD (Organization + SoftwareApplication + FAQ + Blog + Article), meta/OG/canonical, GA4 + Clarity + GSC + Bing, new /blog with 3 keyword-targeted articles.

**Priorities next (biggest ranking ROI):**
1. **Content depth & cadence** — publish 2–4 articles/month around bottom-funnel keywords: "restaurant billing software price", "QR ordering system for restaurants", "KOT software", "cloud kitchen POS", "cafe billing machine", city pages ("restaurant POS in Mumbai/Delhi/Bengaluru").
2. **Programmatic/local landing pages** — /restaurant-pos/[city] and /solutions/[cafe|cloud-kitchen|qsr|bar] for long-tail + local intent.
3. **Backlinks (white-hat only):** directories (SoftwareSuggest, Techjockey, Capterra, G2, Crunchbase), Product Hunt launch, guest posts, Google Business Profile.
4. **Reviews & ratings:** seed G2/Capterra/Google reviews — social proof + rich snippets.
5. **Internal linking** from blog → pricing/features (started).
6. **Core Web Vitals** monitoring in GSC; keep the site fast.
7. **Schema for pricing** (Offer/AggregateOffer) and Review/AggregateRating once you have real reviews.
8. **Backlink hygiene:** avoid paid link schemes — they can penalize a new domain.

---

## 8. How to make it more profitable / unicorn

**Monetization levers (highest impact first)**
1. **Payments = the real business.** POS is the wedge; payments is the profit. Add UPI/card acceptance and earn MDR/rev-share on every transaction processed — this can dwarf subscription revenue at scale (the Toast/Square playbook). Highest-leverage single move.
2. **Expansion revenue:** in-app upgrade prompts at limit-hit, add-on attach at the point of need, per-outlet/register pricing for chains.
3. **Dunning + annual plans:** recover failed payments; push annual (2 months free) to cut churn and pull cash forward.
4. **Capital / lending:** merchant cash advance against POS transaction history (later, with a lending partner) — very high margin.
5. **Marketplace take-rate:** aggregator commissions, hardware resale margin, third-party add-ons.
6. **Reseller/partner channel:** franchise your GTM — resellers sell + support locally for a commission (one-pager already built).

**Product moves that create a moat**
- **Data network effects:** anonymized benchmarks ("top items in your city", "your AOV vs peers") — nobody can copy your aggregate data.
- **Ecosystem lock-in via value, not contracts:** loyalty wallet, customer CRM, WhatsApp base living in NamastePOS make switching costly *because it's valuable*, not because of lock-in.
- **Vertical depth:** own the full restaurant stack — POS → payments → inventory → accounting → capital → marketing.
- **Best-in-class activation:** onboarding checklist + "set up in 5 minutes" is your growth engine; obsess over trial→paid %.

**North-star & unit economics to track (in the new dashboard)**
- North star: **weekly active paying outlets** (or GMV processed).
- Keep **CAC payback < 12 months**, **NRR > 110%** (expansion > churn), **gross margin > 75%**.
- 1,000 paid customers in 6 months (your goal) at ~₹800 blended ARPU ≈ ₹8L MRR ≈ ₹96L ARR — the path there is: free-plan acquisition + activation + expansion + payments attach.

---

## 9. Suggested execution order (when you're ready to build)
1. Fix plan-limit bug + roll out 5-plan structure + update landing pricing feed.
2. SaaS metrics dashboard + dunning + trial automation (P0).
3. Payments acceptance (MDR) — the profit engine.
4. Full CRM + health scores + broadcast center (P1).
5. Compliance hardening (DPDP DSAR, admin session/IP controls, PII masking) + start SOC2-lite.
6. SEO content cadence + reviews + backlinks (ongoing).

*All figures are recommendations for your decision, not financial or legal advice — confirm pricing with market testing and compliance specifics with a CA/lawyer.*
