# FoodFlow — Master QA Report

**Prepared by:** Smart IT by Shiv — 5-tester QA panel
**Date:** 2026-05-19
**Scope:** Backend API · Customer Dashboard · Super-Admin Panel
**Out of scope (this pass):** Flutter mobile apps (will be tested after web is green)

**Panel:**
- **Arvind Kumar** — Backend / API testing (22 yrs)
- **Priya Iyer** — Database integrity & schema (24 yrs)
- **Suresh Pillai** — Functional / E2E web testing (21 yrs)
- **Lakshmi Reddy** — Security & RBAC review (23 yrs)
- **Vivek Sharma** — Performance & test automation (20 yrs)

**Headline result:** product is **NOT ship-ready**. 13 unique P0 ship-blockers, 28 P1, 14 P2.
Most P0s are concentrated in three areas: (a) **impersonation token scope** is far too broad, (b) **race conditions** on order numbering / stock / usage counters under concurrent load, and (c) **three dashboard pages stuck in infinite render loops** because state is mutated inside the render body.

---

## 1. Executive Summary

| Tester | Area | Findings | P0 | P1 | P2 |
|---|---|---:|---:|---:|---:|
| Arvind | Backend API | 15 | 4 | 8 | 3 |
| Priya | Database | 12 | 4 | 5 | 3 |
| Suresh | Functional / E2E | 15 | 4 | 8 | 3 |
| Lakshmi | Security | 15 | 5 | 7 | 3 |
| Vivek | Perf & Automation | 18 | 0 (10 hotspots + 8 gaps) | — | — |
| **Total (deduped)** | — | **55** | **13** | **28** | **14** |

Severity definitions used across the panel:

- **P0 / CRITICAL** — blocks launch. Data corruption, security breach, complete feature failure, infinite loop in production code, financial loss.
- **P1 / HIGH** — must fix before paid customers. Wrong totals, RBAC leaks, broken happy-path features, missing core constraints.
- **P2 / MEDIUM** — fix in first month. UX papercuts, missing indexes, lint warnings, hardening gaps.

---

## 2. P0 — Ship Blockers (must fix before any customer goes live)

### P0-1 · Impersonation tokens grant FULL write access, not read-only
**Source:** Lakshmi #1, Arvind #4
**Files:** `foodflow_backend/src/services/adminService.js:194-207`, `src/middleware/auth.js`
**What:** `impersonate()` issues a JWT with `role: 'business_owner'` and `imp: true`. The middleware honours `role`, so the impersonator can create/edit/delete menu items, refund orders, change billing, invite staff — anything the owner can do — under that owner's `business_id`. The audit log captures the action as if the owner did it.
**Impact:** A rogue or compromised admin can drain a customer's data, issue refunds to themselves, or tamper with orders. Regulatory failure (PCI/GDPR audit trails are untrustworthy).
**Fix:** Add a `requireNotImpersonating` guard on all mutation routes, OR scope impersonation tokens to a read-only role. Log every impersonation session with start/end + actions attempted. Auto-expire impersonation tokens after 15 minutes (current TTL is the standard access token TTL).

### P0-2 · Order number race condition — duplicate `order_no` under load
**Source:** Arvind #2, Priya #1
**Files:** `foodflow_backend/src/services/orderService.js` (nextOrderNo helper)
**What:** `nextOrderNo()` does `SELECT MAX(order_no) + 1` outside a row lock. Two concurrent POST /orders requests on the same business read the same MAX and both insert the same number. There is **no unique constraint** on `(business_id, order_no)` to catch it.
**Impact:** Duplicate human-facing order numbers, broken KOT routing, billing disputes ("I paid for #142 but the kitchen has two #142s").
**Fix:** Either use a per-business sequence table updated with `SELECT ... FOR UPDATE`, or switch to a Postgres sequence per business (created on tenant onboarding), and add `UNIQUE (business_id, order_no)` as a defense-in-depth constraint.

### P0-3 · Three dashboard pages have infinite render loops
**Source:** Suresh #1, #2, #3
**Files:**
- `foodflow_dashboard/src/pages/CustomersPage.tsx`
- `foodflow_dashboard/src/pages/QrCodesPage.tsx`
- `foodflow_dashboard/src/pages/IngredientsPage.tsx`

**What:** All three pages do something like `if (settings && !form) setForm(settings)` directly in the render body. That calls `setForm` during render, which schedules a re-render, which runs the same line again. React 18 throws "Maximum update depth exceeded" and the tab freezes. Suresh reproduced it on every visit.
**Impact:** Customers cannot manage customer profiles, table QRs, or ingredients — three of the major dashboard features built in the food vertical sprint.
**Fix:** Move the conditional `setForm` into a `useEffect(() => { if (settings && !form) setForm(settings); }, [settings])`. Same pattern in all three files.

### P0-4 · Stock check race on guest QR ordering
**Source:** Arvind #3
**Files:** `foodflow_backend/src/services/orderService.js` (guest order path)
**What:** Guest order flow reads `menu_items.stock_qty`, validates quantity, then inserts the order, all without `SELECT ... FOR UPDATE` on the menu_items row. Two simultaneous orders on the last unit of a dish both pass the check and both insert.
**Impact:** Oversold dishes during peak rush — exactly the load this app is designed for. Kitchen prints two KOTs for items it can only make one of.
**Fix:** Inside the order transaction, `SELECT id, stock_qty FROM menu_items WHERE id = ANY($1) FOR UPDATE` before deducting, then validate. Same treatment needed for the ingredients deduction path (recipe-based inventory).

### P0-5 · Usage counter race — addon limits can be exceeded
**Source:** Arvind #1
**Files:** `foodflow_backend/src/middleware/requireAddon.js`, services that bump usage
**What:** Usage counters (e.g., WhatsApp messages sent this period) are read, compared to the plan limit, then written back. Concurrent calls bypass the limit.
**Impact:** Customers exceed paid quotas; we eat the upstream cost (WhatsApp Business per-message charge, SMS gateway, etc.).
**Fix:** Use `UPDATE … SET usage = usage + 1 WHERE usage < limit RETURNING usage` as a single atomic statement. If the update returns 0 rows, reject with 402.

### P0-6 · Missing FK constraints orphan order history
**Source:** Priya #2
**Files:** `db/migrations/001_init_schema.sql`, `002_*` …
**What:** `order_items.menu_item_id` has no FK to `menu_items(id)`. When a menu item is deleted, the order_items row points to nothing, and historical revenue queries get NULL joins.
**Impact:** Reports get wrong totals; audit trail is lossy.
**Fix:** Add `ALTER TABLE order_items ADD CONSTRAINT … FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE RESTRICT`. For tenant deletion paths, soft-delete menu items (`is_deleted`) instead of hard delete.

### P0-7 · `ON DELETE CASCADE` on `orders` cascades too aggressively
**Source:** Priya #3
**Files:** schema migrations
**What:** `order_items.order_id REFERENCES orders(id) ON DELETE CASCADE` — combined with an admin/test path that deletes orders, this nukes line items, KOT entries, and loyalty earn rows in one shot. Any reporting downstream is wrong.
**Impact:** Accidental data loss when admins use the "delete" affordance.
**Fix:** Switch to `ON DELETE RESTRICT` and provide a `cancel_order()` flow that sets `status='cancelled'` instead of deleting. Disable hard-delete UI for orders in production.

### P0-8 · Loyalty earn lacks unique constraint — double-earn on retry
**Source:** Priya #4
**Files:** `loyalty_ledger` table, `loyaltyService.js`
**What:** No `UNIQUE (business_id, order_id, type='earn')`. If the order POST handler retries (timeout, ELB retry, client double-tap), the customer earns points twice for the same order.
**Impact:** Loyalty fraud / customer-trust hit.
**Fix:** Add the unique index, and switch the earn insert to `ON CONFLICT DO NOTHING`.

### P0-9 · Settings/banking field mass-assignment
**Source:** Lakshmi #3
**Files:** `foodflow_backend/src/services/businessService.js` (settings update), `routes/settings.js`
**What:** PATCH /settings does a `UPDATE businesses SET … FROM req.body` shape. Body keys include `payout_account`, `gst_number`, `commission_rate` — fields that should only be writable by super-admin. A logged-in cashier could PATCH them.
**Impact:** Cashier can redirect Razorpay payouts to their own bank account.
**Fix:** Whitelist updatable fields per role (Joi schema with `Joi.forbidden()` on protected keys for non-owner roles), and additionally enforce server-side: those fields can only be set via the super-admin route.

### P0-10 · `deleteNote` has no `business_id` check — cross-tenant delete
**Source:** Lakshmi #4
**Files:** notes/comments service in customer module
**What:** `deleteNote(noteId)` looks up by id only, doesn't verify the note belongs to the requester's business.
**Impact:** Tenant A can delete tenant B's notes by guessing/iterating UUIDs.
**Fix:** `DELETE FROM notes WHERE id = $1 AND business_id = $2`. Audit every service for the same pattern — the panel suspects there are more.

### P0-11 · Razorpay webhook signature check crashes on length mismatch
**Source:** Lakshmi #5
**Files:** `foodflow_backend/src/routes/webhooks.js`
**What:** `crypto.timingSafeEqual(a, b)` throws if `a.length !== b.length`. Currently wrapped in a `try`, but the catch returns 500. An attacker sending a malformed signature header can crash the request and avoid the proper "invalid signature → 401" path.
**Impact:** Webhook handler is partially DoS-able; certain races can replay valid webhooks while signature handler is recovering.
**Fix:** Compare lengths first; if mismatched, return 401 immediately. Use `Buffer.from(hex)` of fixed length on both sides.

### P0-12 · `Settings` page route is missing the super-admin RBAC check
**Source:** Lakshmi #2
**Files:** `foodflow_admin` route guards
**What:** `/settings` and `/admin-team` are accessible to any logged-in admin role, including `support` and `sales` who should not see them.
**Impact:** Lower-privilege internal users can rotate platform secrets and add new admins.
**Fix:** Wrap the routes in `requireSuperAdmin()` (or the appropriate permission key from `adminRbac.js`).

### P0-13 · Order transaction is too large + N+1 inside it
**Source:** Vivek A1, A2
**Files:** `foodflow_backend/src/services/orderService.js`
**What:** The order-creation transaction does sequential per-item lookups (menu fetch, recipe fetch, ingredient fetch, stock update) — each item is its own roundtrip. Under realistic order sizes (10-15 items), the transaction holds row locks for hundreds of ms, multiplying lock contention with P0-2 and P0-4.
**Impact:** Throughput collapses above ~20 concurrent orders/sec — well below a busy mid-size restaurant on a Saturday night.
**Fix:** Bulk-fetch menu items + recipe lines + ingredients in 3 queries (`WHERE … IN (…)`), do all validation in-memory, then issue a single `UPDATE ingredients … FROM (VALUES …)` for stock deduction. Target: order transaction <50ms.

---

## 3. P1 — Must fix before paid customers

**Backend (Arvind):**
1. Refund flow doesn't reverse loyalty points earned on the refunded order.
2. Coupon usage counter is incremented before payment success — abandoned checkouts burn coupon uses.
3. `requireRole` middleware reads role from JWT, not DB — revoked staff can keep using tokens until expiry (no refresh-blacklist check on role downgrade).
4. Pagination on `/admin/customers` returns `total` from a separate query that can drift from the page query (race between count and rows).
5. Joi validation on `addons/subscribe` accepts unknown fields silently.
6. `/v1/orders` lacks rate limit — a misbehaving POS could DoS the kitchen.
7. KOT printer endpoint exposes raw ESC/POS bytes without auth fingerprinting (anyone on the LAN can replay prints).
8. Razorpay webhook idempotency relies on (event_id) but doesn't store the response — same event re-fired returns 200 but doesn't re-trigger downstream side-effects audit.

**Database (Priya):**
1. `subscriptions` is missing index on `(business_id, status)` — admin listing queries scan the whole table.
2. Money is stored as `NUMERIC` in some tables and `INTEGER paise` in others — inconsistent (Priya found two services that divide one and not the other → off-by-100 risk).
3. `audit_log` has no retention policy or partitioning — will balloon past 1GB in <6 months for a 50-customer SaaS.
4. `users.email` is `TEXT` not `CITEXT` in one migration (mixed casing creates duplicate accounts).
5. No DB-level CHECK constraint on `orders.total >= 0`.

**Functional (Suresh):**
1. **No mobile navigation** — `Layout.tsx` uses `hidden md:flex`, leaving phones with no menu. Owners on phones can't open any page after login.
2. Logout doesn't clear `BUSINESS_KEY` in some flows.
3. Refresh-token refresh fails silently and dumps to login without a toast — looks like a random logout.
4. QR-code printable view is not print-CSS friendly (cuts off at margins on A4).
5. Currency is hard-coded ₹ in the UI but the backend supports multi-currency in plans — drift waiting to happen.
6. Date pickers don't respect locale; reports filter expects ISO but UI shows `dd/mm/yyyy`.
7. Marketplace addon "activate" button keeps spinning if the Razorpay subscription succeeds but the webhook is delayed — no optimistic state or polling.
8. Toast errors swallow the backend `error.code` — support can't diagnose from the screenshot.

**Security (Lakshmi):**
1. Access tokens are 24h — too long for a POS context.
2. Refresh tokens are stored in localStorage (vulnerable to XSS) — should be httpOnly cookie.
3. No CSRF protection on cookie-bearing routes (because tokens are in headers — but the moment we switch to cookies for refresh, this becomes a P0).
4. CORS allows `*` in dev and the same code path runs in prod if `NODE_ENV` is unset.
5. No password complexity requirement on owner signup.
6. Google OAuth flow doesn't validate `hd` (hosted domain) — anyone with any google account can sign up; fine for B2C but worth a feature flag for enterprise tenants.
7. No 2FA for admin team — single password protects entire platform.

---

## 4. P2 — Polish (first month)

**Backend:** structured logging keys not consistent; some routes log `userId` and some `uid`. Health endpoint doesn't check DB.

**DB:** missing indexes on `orders.created_at` (used by every report), `kot_orders.status`, `loyalty_ledger.customer_id`. `business_addons.activated_at` is timestamptz vs `timestamp` elsewhere.

**Functional:** Sidebar active-state colour fails WCAG AA contrast (3.9:1 vs required 4.5:1). Toast position covers the "Save" button on mobile.

**Security:** Helmet's CSP is in report-only; switch to enforce. Add SRI to CDN scripts in dashboards.

---

## 5. Performance hotspots (Vivek)

Ranked by expected production impact:

1. **Order create N+1** — covered as P0-13 above.
2. **Listing endpoints** do COUNT + SELECT separately (Arvind P1 #4 + perf). Switch to window function: `SELECT *, COUNT(*) OVER () AS total …` — single roundtrip.
3. **Loyalty tier recomputation** runs on every order — expensive when tiers are weighted. Cache per-customer tier on `customers` table, recompute on a scheduled job nightly.
4. **Admin metrics** dashboard fires 6 sequential queries — parallelize with `Promise.all`.
5. **Recipe deduction** in order create does one `UPDATE` per ingredient. Batch.
6. **Menu list** endpoint serializes recipe lines even when not requested — gate behind `?include=recipe`.
7. **GMV30d query** scans `orders` without a partial index on `status <> 'cancelled' AND created_at > now() - 30 days` — add covering index.
8. **JWT verify** happens twice on routes that use both requireAuth and requireBusinessOwnership — middleware order needs cleanup.
9. **React-Query `staleTime`** is the default (0) on most queries → every navigation refetches. Set sensible per-query stale times.
10. **Bundle size** — both web apps ship the full lucide-react icon set instead of tree-shaken imports.

---

## 6. Test automation gaps (Vivek)

The codebase has **zero automated tests** today. The panel ranked what needs to exist by Sprint:

1. **Migration test in CI** — spin up Postgres, run migrations forwards then re-run from scratch, fail if either drifts. (1 day)
2. **API contract tests** for every route — Supertest + Jest. ~80 routes. (1 sprint)
3. **Auth + RBAC matrix tests** — for each protected route, every role × every tenant. Auto-generate from the permission matrix. (3 days)
4. **Order create concurrency test** — k6 script that fires 100 concurrent guest orders against the same menu_item with stock=1 and asserts exactly 1 success. Reproduces P0-4. (1 day)
5. **E2E happy paths** with Playwright — login (Google + email), create menu item, take order from POS, take guest order via QR, view in KOT, mark ready, mark paid. (1 sprint)
6. **Load test** — k6 baseline of 200 orders/min sustained for 5 min; report p95 latency, error rate. (2 days, gated on P0-13 fix)
7. **Webhook replay tests** — Razorpay signature verify + idempotency. (1 day)
8. **Visual regression** — Percy or Chromatic on the dashboard pages. (1 day)

---

## 7. Recommended fix order

**Sprint QA-1 (1 week) — Unblock launch:**
P0-1 impersonation scope · P0-3 render loops · P0-9 mass-assignment · P0-10 cross-tenant delete · P0-12 settings RBAC. (5 P0s, all small surface-area, no schema migration risk.)

**Sprint QA-2 (1 week) — Data integrity & races:**
P0-2 order_no race · P0-4 stock race · P0-5 usage race · P0-6/7 FK fixes · P0-8 loyalty unique · P0-11 webhook crash · P0-13 transaction shape. (Schema migrations required — coordinate a maintenance window or roll forward in two passes.)

**Sprint QA-3 (1-2 weeks) — P1 cleanup + automation foundation:**
All 28 P1s + migration test in CI + contract test scaffold + RBAC matrix test. Target: 60%+ route coverage by end of sprint.

**After QA-3:** safe to greenlight Fork 2 (mobile launch + polish).

---

## 8. Sign-off

The panel does **not** recommend mobile-app work until at least QA-1 and QA-2 are complete. Building a Flutter UI on top of a backend with the order-number race and the impersonation hole would multiply the blast radius — every mobile install becomes another vector.

The dashboards are **demo-able** today (super-admin metrics work, customer list works, billing flows render) but should **not** receive a real paying customer until QA-1 lands. Three pages currently freeze the browser.

— Smart IT by Shiv QA panel
