# FoodFlow — Post-Launch Roadmap

**Purpose.** This document is the single source of truth for everything we deliberately deferred to land the current version. It combines two earlier conversations:

1. The pre-launch / post-launch split we drew up after the compliance push.
2. The PetPooja feature-parity research from the dashboard walkthrough at <https://billing.petpooja.com>.

We ship the current build first, then work this list in order. Nothing here blocks the initial launch — every item below is either an upgrade or a fast-follow.

**Owner.** Shivhari Lokhande
**Last updated.** 2026-05-28
**Status.** Draft — review before each phase kicks off.

---

## 1. Launch sequence (one-time, before customer #1)

These are the items we agreed to finish before taking paying customers. They are NOT in this roadmap's iteration loop — they're the gate we cross once. Listed here for completeness so nothing falls through.

| # | Item | Effort | Notes |
|---|---|---|---|
| L-1 | Buy `foodflow.in` domain | 10 min | Cloudflare Registrar (~₹780/yr) |
| L-2 | Provision India-region VM | 1 hr | Oracle Cloud Mumbai free, or DigitalOcean Bangalore ~₹500/mo |
| L-3 | Point DNS at the VM | 5 min | `@`, `www`, `api`, `app`, `admin` — DNS-only (grey cloud) |
| L-4 | Install backend stack (Node 20, Postgres 14, nginx, PM2, Let's Encrypt, ufw, fail2ban) | 1 hr | per `DEPLOYMENT.md` Phase B |
| L-5 | Prod `.env` with real secrets | 30 min | JWT secret, Razorpay LIVE keys, CORS list, Google OAuth IDs |
| L-6 | Apply DB migrations + seed Grievance Officer | 10 min | `seed-compliance.sql` |
| L-7 | Verify `/v1/health` from outside the network | 5 min | curl from cellular |
| L-8 | Razorpay webhook URL → prod | 5 min | dashboard.razorpay.com |
| L-9 | Run `compliance.test.js` against prod once | 5 min | sanity check |
| L-10 | Daily `pg_dump` cron to Wasabi Mumbai | 30 min | one-time setup |

The compliance side (lawyer-reviewed Privacy/ToS, Pvt Ltd, breach runbook) is acceptable to defer to Wave 1 below as long as the DRAFT scaffolding stays in the UI and customers are explicitly beta.

---

## 2. Wave 1 — Operational polish (week 1-2 post-launch)

These items are what makes the difference between "the app runs" and "the app runs like a business." Pick them off in any order — none block each other.

**Observability and uptime**

- Sign up for Sentry and paste the DSN into backend `.env` + dashboard `.env.local`. Free tier covers 5k events/month — more than enough for the first 50 customers.
- Create an UptimeRobot account (free), wire it to monitor `https://api.foodflow.in/v1/health` every 5 min, post the public status page link on the landing page footer.

**Communications**

- Provision `support@foodflow.in` (Zoho Mail free, 5 users) and put the address on the landing page contact card + the support footer of every receipt.
- Sign up for Resend (or Sendgrid). Wire `MAIL_FROM=support@foodflow.in`. Add an outbound email queue worker that sends:
  - password-reset links,
  - invoice receipts when an order is settled,
  - DSR-completion confirmations,
  - breach notifications (required by DPDP s.8(6) within 72 hours).

**Compliance — finish what's pending**

These are tasks #117, #118, #120, #126 from the live task list:

- C1 — Privacy Policy. Brief a startup lawyer, replace the DRAFT scaffold in `LegalPage.tsx` and `privacy_policy_screen.dart`. Budget ~₹15-25k.
- C2 — Terms of Service + Customer SaaS Agreement. Same lawyer engagement.
- C4 — Designate a real Grievance Officer with current contact details. Update via `PUT /v1/admin/compliance/settings` — name/email/phone/address are already wired into both apps.
- C10 — Write the data-breach response runbook. Phone tree, DPB notification template, CERT-In contact, customer-notification email template. Doc-only, no code.

**Incorporation track**

- C8 — Pvt Ltd / LLP incorporation, GSTIN, current account. CA workflow, ~₹15-20k + 2-3 weeks. Until done you can run as sole proprietor with Razorpay payouts to a personal account, but the company name on every invoice will be your personal name.
- Once incorporated, swap the legal-entity fields via the admin compliance-settings PUT, and switch Razorpay payouts to the company.

---

## 3. Wave 2 — PetPooja parity (weeks 3-8)

The dashboard walkthrough at billing.petpooja.com surfaced eight functional areas where FoodFlow's owner dashboard trails. Doing all of these is what makes the product feel like a peer of PetPooja / Posist / DotPe rather than a smaller alternative.

Each phase below is sized to land in one focused push.

### Phase A — Dashboard parity (~3 days)

The /overview page today shows a few headline numbers. PetPooja's equivalent shows a sales-statistics panel with a date picker, sync-freshness badges, payment-method breakdown, order-status split with a bar chart, channel tiles (Dine in / Pick up / Delivery), an online-orders table grouped by aggregator, a leakage report (KOTs cancelled / modified / not used in bills / shifted; Bills modified / re-printed / waived off), an expenses & withdrawals card, and an Action Center pill at top-right that surfaces the count of things needing attention.

Specifics:
- Sales card → split by Cash / Card / UPI / Online / Other + Not Paid.
- Order-status panel → Successful / Complementary / Cancelled + a tiny bar chart.
- Channel tiles → Dine-in (with TTA), Pickup, Delivery.
- Online orders table → Zomato / Swiggy / other aggregators with per-row "open detail" action.
- Sync-freshness badges → "POS synced N min ago", "Orders synced N min ago".
- Action Center pill → count + popover showing items needing attention (unpaid bills > 1 day, KOTs older than 30 min, low-stock items, expired offers).
- Leakage card → KOT modifications/cancellations/shifts and bill modifications/reprints/waivers.
- Expenses & withdrawals card → today's total with a "View breakdown" drill-down.

### Phase B — Multi-outlet (~2 days)

Right now every login is scoped to a single business. PetPooja's "Sugar & Spice" top-bar control switches between outlets owned by the same merchant. Implementation outline:

- A user-level "active outlet" preference. Top bar dropdown lists every `business_users` row belonging to the user.
- Switch action calls the existing `/auth/switch-business` endpoint, refreshes session and reloads cached business state.
- All `/businesses/:bid/*` endpoints already filter by business — no backend change needed beyond the switch action.
- Reports gain an optional outlet filter that defaults to the active outlet; an "All outlets" rollup is added for multi-outlet owners.

### Phase C — CRM surface (~3 days)

Today the Customers module exists behind the Loyalty addon but the dashboard doesn't expose segments, campaigns, gift cards, or feedback as first-class objects.

- Segments → builder UI on top of the existing customer query API. "Top 10% by spend in last 30 days", "Haven't visited in 14 days", "Birthday in next 7 days".
- Campaigns → segment + channel (email / WhatsApp / SMS) + template → send. Backend already has WhatsApp + email plumbing; we just need the UI flow.
- Gift cards → new addon, simple SKU table (denomination, expiry) and a redemption flow against an order.
- Feedback → re-introduce the reviews surface we removed earlier (task #74 deprecated it). Inbox view, reply path, average-rating widget.

### Phase D — Operations polish (~2 days)

- Device mapping → label each printer / terminal ("Counter 1", "Kitchen pass") so KOT routes correctly when there's more than one of either.
- Menu schedule changes → time-based availability per item ("Lunch menu 12-3pm only"). Backend menu_items already has `is_active`; extend with `available_from / available_to / weekdays`.
- Item commission → optional commission % per item per staff role. Used for waiter incentive reports.

### Phase E — Audit Trail UI (~1 day)

The backend already writes to an `audit_log` table on sensitive actions (plan changes, impersonation, addon detach). Surface it as a sortable table in the super-admin panel, filtered by actor/action/date.

### Phase F — Marketing site polish

- Add screenshot carousel of mobile app + dashboard.
- Add testimonial section (once we have one).
- Add a `/pricing` page with full feature matrix (already loaded from `/v1/plans`).
- SEO: meta tags, structured data, sitemap.xml.

---

## 4. Wave 3 — Quality and scale (weeks 9-14)

These are the tasks already on the master list (#111-#116) that we deferred to ship the MVP. They turn FoodFlow into a maintainable product, not a faster product.

| # | Phase | What |
|---|---|---|
| 111 | 1 | Backend security audit + fixes (in_progress) |
| 112 | 2 | Backend integration test suite (Jest + Supertest) |
| 113 | 3 | Admin Playwright — gap-fill 11 more pages |
| 114 | 4 | Dashboard Playwright — gap-fill ~35 flows |
| 115 | 5 | Flutter widget + integration tests from zero |
| 116 | 6 | Code quality pass — lint, types, perf, DB indexes |

Order matters: 1 → 2 catches regressions during fast-follow shipping; 3-5 catches UI regressions; 6 is the polish layer.

---

## 5. Wave 4 — Deferred features (anytime in months 3-6)

These are items we explicitly chose to defer. Stay deferred unless a customer's commercial ask makes one of them urgent.

- **Captain table-tap bug fix** (task #127) — the seat-edit flow incorrectly opens for unpaid orders. Quick fix once we make time.
- **E-invoice IRN integration** — required by GST law for businesses crossing ₹5 Cr annual turnover. Add when a first-such customer comes onboard.
- **In-app Bluetooth printer on iOS** — limited to MFi-certified printers due to Apple's restrictions. Add only if we get an iOS-restaurant prospect with the right hardware.
- **Voice POS** — was in pubspec, removed due to dependency conflicts. Re-enable when `speech_to_text` aligns with our package graph again.
- **Aggregator deep integrations** — direct Zomato / Swiggy API push instead of CSV import. Each integration is its own week of work + partnership paperwork.
- **Multi-currency / multi-region** — when (if) we expand outside India.
- **Print-agent installer + auto-update** — currently a manual `npm start` on a PC. Package it as a one-click installer (electron-builder or pkg) once we have customers using it in production.
- **Native iOS Bluetooth printer support for MFi printers** — currently the BT package works on iOS but Apple's MFi gate filters out most cheap printers. Document this as a known limitation for the iOS App Store review.

---

## 6. Definition of done

For each item in this roadmap to be considered shipped:

1. Code is merged to `main` and deployed to prod via the standard pipeline (PM2 restart for backend, Vite build + nginx reload for dashboard, `flutter build` + Play Store / TestFlight upload for mobile).
2. A short release-note bullet is added to `CHANGELOG.md`.
3. The matching task in the task list is moved to `completed`.
4. Where applicable, a corresponding Playwright/Jest test is added so we don't regress.

---

## 7. Cost overhead reminder

Numbers from the deployment-requirements doc, repeated here for quick reference:

| Bucket | Now (pre-launch) | First 10 customers | First 100 customers |
|---|---|---|---|
| Infrastructure | Oracle free (~₹0) | Oracle free | DigitalOcean ₹4k |
| Domain | ₹780/yr | ₹65/mo | ₹65/mo |
| WhatsApp (Twilio) | ₹0 | ₹4,500/mo | ₹45,000/mo |
| Email (Resend) | ₹0 | ₹0 (free tier) | ₹1,700/mo |
| Backups (Wasabi) | ₹60/mo | ₹60/mo | ₹250/mo |
| Sentry | free | free | ₹2,200/mo |
| Support inbox | ₹0 (Zoho free) | ₹0 | ₹408/mo (3 Google Workspace seats) |
| **Total/month** | **~₹125** | **~₹4,625** | **~₹53,600** |
| Per-customer cost | n/a | ~₹463 | ~₹536 |

At Pro ₹799/mo per customer the unit economics are healthy past the first paying customer — net contribution ~₹260/mo per customer after Razorpay fees and WhatsApp.

---

## 8. Open questions to decide before each wave

Before kicking off **Wave 1**:

- Final lawyer pick? (Vakilsearch / IndiaFilings / local Pune lawyer)
- Hosting picked? (Oracle Mumbai vs DigitalOcean Bangalore — recommend Oracle for cost)
- Domain bought?

Before kicking off **Wave 2 Phase A**:

- Action Center scope — which signals count as "needing attention"? (KOTs > 30 min, unsettled bills > 24 hours, low stock, expired addons, …)
- TTA computation — wall clock from KOT creation to "ready"? Or to "collected"?

Before kicking off **Wave 2 Phase B**:

- Multi-outlet pricing — same Pro plan covers all outlets, or per-outlet billing?

Before kicking off **Wave 2 Phase C**:

- WhatsApp template approval — Twilio templates need Meta approval before they can be sent to non-opted-in customers. Apply early; lead time is 2-7 days.

Make these calls when the relevant wave is about to start, not now.
