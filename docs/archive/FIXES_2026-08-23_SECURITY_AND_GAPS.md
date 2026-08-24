# Fixes applied — 23 Aug 2026 (security + product gaps + refund view)

All verified: **backend jest 225/225** (221 + 4 new security regression tests), app loads clean, **migrations 001–057 idempotent double-pass on fresh Postgres**, dashboard TypeScript 0 errors + production build ✓, landing JS ✓.

---

## 1. Your question: refund showed on Admin, not on the Owner dashboard

**Cause.** Both the owner's refund (Orders → *Refund…*) and admin refunds write to the same `refunds` table. The **admin panel** had a Refunds page listing every tenant's refunds, but the **owner dashboard had no refunds list at all** — so a refund for *Mumbai Pavbhaji and Pulao* only surfaced on the admin side. The owner could *start* a refund but had nowhere to *review* refund history.

**Fixed.**
- New backend route `GET /businesses/:id/refunds` — always scoped to the caller's own business (`refundService.list({ businessId })`), owner/manager only, `limit` capped.
- New **Refunds page on the owner dashboard** (sidebar → *Refunds*, under Tax invoices) with status filter, total, date/reason/status/amount. `foodflow_dashboard/src/pages/RefundsPage.tsx`.
- The admin panel keeps its platform-wide view (that's the operator's oversight) — but your restaurant's refunds now live where you expect them: on your own dashboard.

---

## 2. Security findings — all fixed

| ID | Severity | Fix |
|----|----------|-----|
| **S1** | High | Refresh tokens now carry `user_id` (migration **056**). The refresh consume query joins on the token's own user, so a cashier can no longer refresh into the owner's role. Reuse of a rotated token now revokes the whole session family. |
| **S2** | High | Super-admin tokens are now **read-only** on the business API — any tenant mutation must go through `/admin` (RBAC-gated) or an explicit impersonation session. A support/sales admin can no longer delete menus or issue refunds on any restaurant. |
| **S3** | Medium | Super-admin identity is re-checked against `admin_users.is_active` on every admin request (30 s cache) — a deactivated admin's token stops working immediately. |
| **S4** | Medium | PIN lockout moved from an in-memory Map to `business_users` columns (migration **057**) — now shared across PM2 workers and survives restarts. PIN-login + staff-picker get a dedicated tighter 10/min limiter. |
| **S5** | Medium | Refresh-token reuse detection + family revocation (with S1). |
| **S6** | Medium | Retail Goods-Receipt (`receivePO`) now verifies the PO **and** each line belong to the caller's business before writing — closes the cross-tenant procurement write. |
| **S7** | Medium | CSV exports neutralise formula injection — cells starting with `= + - @` are prefixed so Excel/Sheets treats them as text. |
| **S8** | Low | JWT verify pins `algorithms:['HS256']`. |
| **S10** | Low | Landing pricing grid now escapes `plan.billingPeriod` too. |
| **S13** | Low | pg unique-violation `detail` no longer echoed to clients in production. |
| **S14** | Low | Razorpay checkout-signature verify guards missing/short signatures (clean 401, not a 500). |

**Documented / accepted (not code-changed):** S9 (dead CSRF issuance — cookie-mode uses `sameSite=strict`; Bearer clients unaffected), S11 (access token in `localStorage` — deliberate; refresh token is httpOnly-cookie, blast radius ≤1 h), S12 (unbounded `limit` — already bounded by the global 600/min limiter + 1 MB body cap), S15 (LIKE wildcard quirk — no injection). Access-token deny-list on logout deferred (tokens are short-lived; refresh family-revocation covers theft).

New regression tests: `tests/integration/security_fixes.test.js` proves S1 (identity preserved on refresh, reuse rejected) and S2 (admin write blocked, owner write allowed).

---

## 3. Product gaps from the final review — filled

- **§4.1 Owner refund view** — done (section 1 above).
- **§4.2 Dashboard membership bundle editor** — the New Plan dialog now has an item builder (pick menu items + quantities). Saves as `benefits.items`, which the app already auto-redeems at billing. So you can build "20 × Cold Coffee + 20 × Pizza, valid 30 days" from the dashboard, not just the app.
- **§4.3 WhatsApp outbound queue** — added a cron drain for transactional `wa_messages` (order receipts) that were being inserted but never sent. Mock provider marks them sent so they don't loop; real Twilio config sends them.
- **§4.6 Trial hard-block** — an **expired trial no longer keeps Pro features**. `featureService` now checks `trial_ends_at`; a lapsed trial with no paid subscription falls back to the free/Starter tier server-side (not just UI). Starter POS/billing keeps working.
- **§4.7 Pricing copy** — landing now says **14-day** trial (matches the backend 14-day default), not 30-day.
- **§4.4 Aggregators** — page now carries a *Beta* badge and a one-line note that ingestion is via webhook and official one-click onboarding is coming — so owners don't expect a turnkey Zomato/Swiggy connection.
- **§4.5 Onboarding** — already partly covered by the existing Setup Wizard (`/onboarding`) + First-Order Tour; left as-is (a fuller first-run flow is a larger feature, flagged for a later sprint).

---

## Deploy steps
1. `npm run migrate` (applies **056** + **057**; both additive `ADD COLUMN`, no drops, no data loss).
2. Restart the backend (all PM2 instances).
3. Rebuild the dashboard (`npm run build`) and redeploy the landing page.
4. No Flutter changes this round — existing APK still works, but a rebuild is fine.

**One-time note on S1:** existing refresh tokens for *multi-staff* businesses get `user_id = NULL` (can't be disambiguated) and will require one fresh sign-in. Solo-owner sessions are backfilled and keep working.
