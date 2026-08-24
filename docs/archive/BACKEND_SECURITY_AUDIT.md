# FoodFlow — Backend security audit (FF-256)

**Audit date:** 2026-08-20
**Scope:** All 25 route files, 139 handler entries under `foodflow_backend/src/routes/`.

## Multi-tenant isolation (IDOR defence)

Every business-scoped router mounts `requireAuth, requireBusinessOwnership`. The audit sweeps `router.use(...)` and confirms:

| Router | Handlers | requireAuth | requireBusinessOwnership | Verdict |
|---|---:|:---:|:---:|:---|
| billing.routes.js | 0 (delegated) | ✓ | ✓ | OK |
| customers.routes.js | 1 | ✓ | ✓ | OK |
| expenses.routes.js | 1 | ✓ | ✓ | OK |
| finalSprint.routes.js | 32 | ✓ | ✓ | OK |
| ingredients.routes.js | 1 | ✓ | ✓ | OK |
| menu.routes.js | 1 (composite) | ✓ | ✓ | OK |
| ops.routes.js | 3 | ✓ | ✓ | OK |
| orders.routes.js | 0 (delegated) | ✓ | ✓ | OK |
| reports.routes.js | 18 | ✓ | ✓ | OK |
| sprint1Extras.routes.js | 8 | ✓ | ✓ | OK |
| sprintsAll.routes.js | 36 | ✓ | ✓ | OK |
| staff.routes.js | 10 | ✓ | ✓ | OK |
| taxInvoices.routes.js | 5 | ✓ | ✓ | OK |
| **Total business-scoped** | **116** | ✓ | ✓ | **PASS** |

Per-user (self-service) routes correctly skip ownership:

| Router | Auth model |
|---|---|
| me.routes.js | `requireAuth` only — every op is scoped to `req.user.id`, no business context |

Public / signature-verified routes (no auth):

| Router | Auth model |
|---|---|
| auth.routes.js | login/register/refresh — pre-session |
| admin.routes.js | Uses its own `requireAdmin` (super-admin only) |
| guest.routes.js | Signed QR token in URL — validated per request |
| aggregatorWebhooks.routes.js | HMAC signature verification |
| whatsappWebhook.routes.js | Twilio signature verification |
| compliance.routes.js | Public per DPDP Act (grievance filing, cookie consent) |
| publicSite.routes.js | Landing-page catalog reads |
| addons.publicRouter | Public addon catalog |
| invitations.routes.js | Uses one-time invite token |
| multiOutlet.routes.js | Uses its own `requireOutletGroupOwnership` |
| uploads.routes.js | Serves static + auth on write |

## Automated IDOR probe

Companion script `scripts/idor-audit.js` (FF-212) programmatically confirms cross-tenant access is refused. Run:

```
node scripts/idor-audit.js
```

## Other checks

- **Rate limiting:** Global limiter (`express-rate-limit`) attached in `app.js` (skipped in NODE_ENV=test).
- **CSRF:** Double-submit token via `middleware/csrf.js` — enforced on all cookie-session state-changing requests, exempted for signature-verified webhooks and pre-login auth endpoints.
- **CORS:** `env.CORS_ORIGINS` allow-list; wildcard rejected in production at boot.
- **Helmet:** Enabled with CSP enforce in prod.
- **Cookie flags:** `ff_refresh` is HttpOnly + SameSite=strict + Secure(prod). `ff_csrf` intentionally readable by JS for the double-submit pattern. See FF-213.
- **Trust proxy:** `app.set('trust proxy', 1)` — required behind nginx TLS terminator.
- **Sensitive headers:** `x-powered-by` disabled.

## Conclusion

**No IDOR gaps detected.** All 116 business-scoped handlers correctly gate on `requireBusinessOwnership`. All non-business-scoped routes have an appropriate auth model.

Follow-up: **FF-256b** — annual re-run this audit and pipe results into CI as a gate before deploy.
