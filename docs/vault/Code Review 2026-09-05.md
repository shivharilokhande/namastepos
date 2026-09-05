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

## Still open (see `TRACKER.html`)
Founder decisions: recurring_invoices/api_access/white_label/marketplace_addons sold but empty; proration on upgrade; suspended tenants' mandate; paid-addon cancel timing; B2B template save key; inventory Starter-web vs Pro-mobile. Prod checks: count ₹0-GST invoices; tenants with aggregator creds but no key; lapsed cancel-at-period-end rows before the first sweep. Next session: mobile order lines don't send `variantId`/`modifierLines`; `requireStaffPerm` on orders/cancel/customers; B2B template backend; dashboard vitest; admin eslint; admin "effective features" view; "Offer yearly" toggle no-op.
