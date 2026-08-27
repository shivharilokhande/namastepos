# NamastePOS — Super-Admin, Compliance & Growth Roadmap

_Prepared 2026-08-27. Scope: super-admin product + business-owner dashboard. Prioritised Now / Next / Later, scored by effort (S ≤ 2 days, M ≤ 1 week, L > 1 week) and revenue/retention impact (★ low → ★★★ high). Grounded in the current codebase, not aspiration._

---

## Executive summary

NamastePOS already has a stronger super-admin than most v1 SaaS: metrics (MRR/ARR/cohorts/LTV/churn), a per-tenant CRM (health score, lifecycle stage, tasks, renewals), plans/add-ons/coupons with Razorpay sync, GST filing exports, audit log, RBAC (4 roles), 2FA, and DPDP endpoints.

The gap between "good admin" and "unicorn engine" is three things:

1. **Stop the leaks** — no dunning/failed-payment recovery, no proration. This is money already earned that's walking out.
2. **Turn the admin into a revenue engine** — payments take-rate on GMV, then fintech/lending attach. In India, subscription is the wedge; payments + capital are the profit.
3. **Turn the tenant dashboard into a retention + ARPU machine** — own-brand online ordering (dodge aggregator commissions), metered WhatsApp, automated win-back.

Everything below assumes "no lock-in / all-inclusive" positioning stays — the monetisation is usage- and GMV-based, not feature paywalls.

---

## NOW (0–4 weeks) — fix leaks, tidy foundations

| # | Item | Area | Effort | Impact | Notes |
|---|------|------|--------|--------|-------|
| N1 | **Dunning / failed-payment recovery** | Super-admin + backend | M | ★★★ | Razorpay webhook already exists. On `payment.failed`/`subscription.halted`: retry schedule + email/WhatsApp sequence + a "past-due" queue in admin. Biggest single revenue saver. |
| N2 | **Fix pricing card vs compare-table mismatch (live)** | Landing | S | ★★ | Cards show 3 plans (Starter/Growth/Enterprise); compare table shows 5 (adds Pro/Advanced). Confuses buyers *today*. Drive both from the live `/v1/public/plans` feed. |
| N3 | **Remove dead `super_admins` auth path** | Backend | S | ★ (risk) | ✅ Done 2026-08-27. Dead login/bootstrap on `super_admins` removed; all auth is `admin_users` (consistent with `requireSuperAdmin`). Orphan table can be dropped later. |
| N4 | **Consolidated invoice / subscription ledger page** | Super-admin | M | ★★ | Today invoices are per-customer only. One page: all subs, status, next-charge, past-due, comped-vs-paid, export. Finance can't operate tenant-by-tenant. |
| N5 | **SEO quick wins: schema.org (SoftwareApplication + FAQPage + Organization), city/solution pages, branded download domain** | Landing | M | ★★ | FAQ schema = instant rich-result eligibility. Split Solutions (cloud kitchen/QSR/café) into indexable pages for long-tail. Move APK to `downloads.namastepos.in`. |
| N6 | **Substantiate or soften the "4.9 rating" claim** | Landing/compliance | S | ★ | Either add real `AggregateRating` schema tied to actual reviews, or reword. Unsubstantiated claims are a compliance + SEO-penalty risk. |

---

## NEXT (1–3 months) — the revenue engine

| # | Item | Area | Effort | Impact | Notes |
|---|------|------|--------|--------|-------|
| X1 | **Payments take-rate (Razorpay Route / PA)** | Both + backend | L | ★★★ | Settle tenant collections through the platform, earn bps on GMV. GMV is already tracked in metrics. Admin needs settlement + commission reporting. This typically dwarfs subscription revenue. |
| X2 | **Proration on mid-cycle upgrades** | Backend + billing | M | ★★ | Today the period just rolls forward — upgrade revenue is lost. Charge the delta on upgrade. |
| X3 | **Usage-based upsell trigger queue** | Super-admin | S | ★★ | Limits are already computed (`enforceLimit`). When a tenant hits menu/staff/order caps, auto-create a sales task ("hit staff cap → pitch Pro"). Cheap, high-conversion. |
| X4 | **In-console tenant messaging / broadcast + lifecycle campaigns** | Super-admin | M | ★★ | Announce features, upsell, win-back. Onboarding drip already exists (Brevo) — extend to segmented broadcasts. |
| X5 | **Own-brand online ordering storefront + delivery** | Owner dashboard | L | ★★★ | Helps restaurants dodge 20–30% aggregator commission — strongest retention wedge; a reason never to churn. Public site renderer + QR order tracker already exist to build on. |
| X6 | **Metered WhatsApp marketing (sell credits)** | Both | M | ★★ | WhatsApp receipts/marketing already built. Meter it → recurring high-margin usage revenue (blocked on MSG91 DLT approval — see infra). |
| X7 | **Support / ticketing** | Super-admin | M | ★★ | Health score already penalises "open critical ticket" but there's no ticket entity/UI. Retention + NPS lever. |

---

## LATER (3–9 months) — the moat & the multiplier

| # | Item | Area | Effort | Impact | Notes |
|---|------|------|--------|--------|-------|
| L1 | **Merchant cash advance / working-capital (NBFC partner)** | Super-admin + owner | L | ★★★ | You hold real-time GMV + GST data — the exact underwriting signal Indian fintech-POS players monetise. Partner with an NBFC (don't lend yourself). Admin needs an eligibility/offer console. |
| L2 | **Partner / reseller console + referral program** | Super-admin | L | ★★ | "White-label" is already a feature — a partner portal with sub-accounts + commission tracking turns it into a channel. Restaurant-to-restaurant referral is a strong India channel. |
| L3 | **Supplier / procurement marketplace + auto-reorder** | Owner dashboard | L | ★★ | Off your inventory data → procurement take-rate. |
| L4 | **Franchise / multi-outlet chain console** | Both | L | ★★ | Move upmarket to higher-ACV chains; consolidated multi-outlet reporting already partly exists. |
| L5 | **Add-on marketplace revenue share (3rd-party)** | Super-admin | M | ★★ | Take a cut of third-party add-ons. |

---

## Compliance track (run in parallel — required for enterprise deals)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| C1 | **Automated DPDP data-export + erasure pipeline** | M | DSRs are tracked as records today but deletion is manual. Automate tenant/customer export + hard-delete to actually satisfy a request. |
| C2 | **Field-level PII encryption (phone/email)** | M | Currently plaintext across admin APIs. Encrypt before enterprise/security reviews. |
| C3 | **Enforce 2FA org-wide for admins; move KEK off `JWT_SECRET` to a dedicated key** | S | 2FA is opt-in today; encryption KEK is derived from JWT_SECRET (self-noted gap). |
| C4 | **Shared feature-cache invalidation** | M | Feature cache is a per-node 60s Map — inconsistent across instances at scale. Needs a shared invalidation bus before multi-node. |
| C5 | **Rate-limit all admin endpoints (not just login)** | S | Impersonate/refunds/set-plan are unthrottled. |
| C6 | **SOC 2 / ISO 27001 readiness track** | L | Audit log + RBAC already help. PCI largely offloaded to Razorpay — document it. Confirm Neon region = India for data residency. |
| C7 | **e-invoice IRN generation for >₹5cr tenants** | M | "E-invoice ready" today; confirm IRN wiring for tenants crossing the mandate threshold. |

---

## Sequencing rationale

- **Do NOW first** because N1 (dunning) and N2 (pricing mismatch) are losing money at this moment, and N3 (done) removes a latent auth footgun.
- **X1 (payments take-rate) is the pivot** from "SaaS with a ceiling" to "fintech-attached platform." Everything in LATER (lending, marketplace) depends on the payments rail existing first.
- **X5 (own-brand ordering)** is the retention counterweight — it makes churn painful for the restaurant, which protects all the recurring revenue above.
- Compliance items are not optional for the enterprise/chain segment (L4) — start C1–C3 early so they're ready when the first chain deal appears.

---

## What NOT to do

- Don't add per-feature paywalls — it contradicts the "all-inclusive, no lock-in" positioning that's the core differentiator vs legacy POS.
- Don't build the marketplace/lending before the payments rail — no distribution or data flywheel without it.
- Don't drop the `super_admins` table in a rush — do it as a reviewed migration (per the no-DB-drop constraint).
