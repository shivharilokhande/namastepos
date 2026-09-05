---
tags: [namastepos, review]
---
# Code Review 2026-09-05 (shipped 2026-09-06 as `4b50e19`)

Full `/engineering:code-review` — 5 reviewers, 5 fixers. 62 findings (8 P0, 22 P1), 52 fixed and live. Report: `../../CODE_REVIEW_2026-09-05.html`; raw evidence: `../review-2026-09-05/`.

## Headlines
- **Money:** five ways to hold a paid plan free (resume, addon resume, downgrade keeps mandate, pause→resume, self-un-suspend) — closed; see [[Plans Billing and Subscriptions]].
- **GST:** every auto-issued tax invoice showed ₹0 GST (per-line GST never written); both tills sent `tax: 0`; GSTR exports 500'd — fixed; see [[GST and Money]].
- **Gates:** six keys had rules matching no route and the audit could not tell — real rules + router-walking test; empty-plan→Enterprise fallback closed; see [[Feature Registry and Gating]].
- **Tenant isolation:** `users.phone` write without membership, foreign `tableSessionId`, guest-paid table never freed, guest QR trusted like an aggregator — fixed.
- **Dashboard:** gating was a lock icon; now fail-closed + route guards + 402 toast + staff nav by permission + `X-Plan-Version`.
- **Mobile v1.0.22:** loyalty at checkout by plan key, GST shown, tax_invoices bypass, WhatsApp on dine-in, drawer pop crash, captains off money KPIs.

## Rounds 2 and 3 (same day, `8d4f6c9`, `8f96b87`)
- Built `recurring_invoices` (real schedules → tax invoices), `api_access` (read-only `X-API-Key`), `white_label` (brand on guest/site/receipts); B2B template store (`b2b_invoice`); staff perms on orders; admin effective-features + Review checks page; suspend cancels mandate, paid addon cancel at period end; mobile variant/modifier lines; KOT names the choice.
- Founder's bug: wallet at Pay & place then Settle still due → sessions now carry `totalPaise/paidPaise/duePaise/isSettled`; settle charges the balance only (was double-debiting the wallet); re-settle 409. Shortfall/top-up on both screens, both clients; membership renew card; grievance PATCH 42P08 fixed.
- New helpers to reuse: dashboard `lib/checkout.ts`, `lib/navConfig.ts`, `lib/featureLabels.ts`; mobile `utils/checkout_money.dart`, `utils/checkout_gates.dart`, `utils/gst.dart`; admin `components/FeaturePicker.tsx`, `lib/rbac.ts`.

## Still open (see `TRACKER.html`)
Founder decisions: recurring_invoices/api_access/white_label/marketplace_addons sold but empty; proration on upgrade; suspended tenants' mandate; paid-addon cancel timing; B2B template save key; inventory Starter-web vs Pro-mobile. Prod checks: count ₹0-GST invoices; tenants with aggregator creds but no key; lapsed cancel-at-period-end rows before the first sweep. Next session: mobile order lines don't send `variantId`/`modifierLines`; `requireStaffPerm` on orders/cancel/customers; B2B template backend; dashboard vitest; admin eslint; admin "effective features" view; "Offer yearly" toggle no-op.
