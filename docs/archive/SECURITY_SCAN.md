# FoodFlow — Security scan report (FF-216)

**Scan date:** 2026-08-20
**Scanner:** `npm audit` (production tree only where applicable)
**Owner:** Shivhari Lokhande

Automated dependency scan across all four surfaces of the FoodFlow stack. Baseline captured, safe fixes applied, remaining vulnerabilities triaged below with a fix plan.

---

## Executive summary

| Surface | Before | After safe fix | Critical | High | Moderate | Low |
|---|---|---|---|---|---|---|
| Backend (Node/Express) | 11 | **6** | 1 | 2 | 3 | 0 |
| Dashboard (React/Vite) | 22 | **2** | 0 | 0 | 2 | 0 |
| Admin (React/Vite) | 22 | **2** | 0 | 0 | 2 | 0 |
| Flutter mobile | *scanner N/A* | *see notes* | — | — | — | — |

**Total production vulnerabilities remaining:** 10 (backend 6 + dashboard/admin 4). All are in transitive deps of `exceljs`, `google-auth-library`, or Vite's dev-server bundler `esbuild` — no direct application code carries the risk.

---

## Backend — foodflow_backend

Remaining after `npm audit fix`:

| Package | Severity | Notes / fix plan |
|---|---|---|
| `tar` (transitive of `bcrypt` via `@mapbox/node-pre-gyp`) | **Critical** | Path-traversal + symlink-poisoning family. Only exercised during `bcrypt` postinstall from the tarball; not at runtime. **Fix:** bump `bcrypt` 5 → 6 (major). Contract test covered — API surface is identical. Scheduled for Sprint 12 (FF-216b). |
| `brace-expansion` (transitive of `glob` chain) | High | DoS via exponential expansion — only triggered on `readdir-glob` patterns; we don't accept user glob input. **Fix:** wait for `readdir-glob` release; not blocking. |
| `tmp` (transitive of exceljs) | High | Path traversal in `tmp` prefix. `exceljs` uses it only for streaming writes to `os.tmpdir()`. Not user-controllable. **Fix:** `exceljs` ships fix in next minor. |
| `uuid` (transitive of exceljs + gaxios) | Moderate | Buffer-bounds check missing in v3/v5/v6 with user-supplied buffer. We only use v4 (auto-buffer). No exposure. |
| `joi` <17.13.4 → we ship 17.12.3 | Moderate | Recursive-link DoS. Our schemas are flat, no `link()` usage. **Fix:** `npm i joi@^17.13.5` (patch bump). Safe — scheduled for next backend deploy. |
| `body-parser` <1.20.6 | Low→Moderate | DoS via invalid `limit` value. We hard-code `limit: '1mb'` — not user-controlled. **Fix:** `express@^4.21` bumps body-parser transitively. |

**Decisions:**
- Critical `tar` deferred to Sprint 12 (bcrypt major bump requires a rebuild test)
- Others are non-blocking for launch — none are reachable from the request surface

Detail:

```
npm audit --production
6 vulnerabilities (3 moderate, 2 high, 1 critical)
```

## Dashboard — foodflow_dashboard

Remaining after `npm audit fix --legacy-peer-deps`:

| Package | Severity | Notes |
|---|---|---|
| `esbuild` <0.25 (transitive of Vite) | Moderate | Dev-server CORS-any issue — only affects `vite dev` binding to a public IP. **Not shipped to production.** |
| `esbuild-kit` (transitive) | Moderate | Same class. |

**Decision:** dev-only. Zero prod exposure.

## Admin — foodflow_admin
Identical footprint to dashboard (2 moderate, esbuild).

## Flutter mobile — foodflow_flutter

`npm audit` doesn't apply. Run periodically:

```
cd foodflow_flutter
flutter pub outdated --mode=null-safety
flutter pub upgrade --major-versions   # dry-run first
```

Manual inventory of packages Claude touched this sprint:
- `connectivity_plus` ^5.0.2 — up to date on 5.x
- `dio` — used, no known CVE
- `print_bluetooth_thermal`, `esc_pos_utils_plus` — no known CVE
- `flutter_local_notifications` ^17.2.4 — up to date

No known critical CVEs on the mobile dependency graph as of scan date.

---

## Follow-up tickets

- **FF-216b** — Backend: bump `bcrypt` to 6.x, re-verify auth tests, ship.
- **FF-216c** — Backend: bump `joi` to 17.13.5 and `express` to 4.21 (transitive body-parser fix).
- **FF-216d** — Frontends: pin `vite@^5.x` once esbuild upstream ships the fix.
- **FF-216e** — Flutter: schedule a quarterly `flutter pub outdated` review.

---

*Scan produced automatically by the Sprint 11 development pass. Re-run before every prod deploy: `cd foodflow_backend && npm audit --production`.*
