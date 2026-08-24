# FoodFlow — Production readiness audit

**Date:** 2026-08-20
**Target launch:** tomorrow
**Auditor:** Shivhari + AI review pass

I'll be blunt with the numbers so you can make a real go/no-go call.

---

## 1. Reality check on "1 million requests"

Before we scale-plan anything, we need to agree on what "1M requests" means:

| Interpretation | RPS equivalent | Difficulty |
|---|---|---|
| 1M requests **per day** | ~12 RPS avg, ~50 RPS peak | Trivial — the current stack handles it |
| 1M requests **per hour** | ~278 RPS avg | Doable on a modest VM with tuning |
| 1M requests **per minute** | ~16,600 RPS | Needs a small cluster (3-5 API nodes) |
| 1M requests **per second** | 1M RPS sustained | Google-scale. Not deployable tomorrow. Ever. |
| 1M **concurrent connections** | connections, not throughput | Different problem — requires WebSocket/SSE tuning + load balancer sizing |

**Realistic Day-1 target for a POS SaaS launching to Indian cafes tomorrow:** ~500 businesses × ~50 orders/day × 20 API calls per order-flow = **500,000 requests/day** peak. That's <100 RPS avg. **The current single-VM stack handles this comfortably with two config changes** (below).

The "1M" number is a good long-term target. Don't try to hit it tomorrow. Launch, measure, scale.

---

## 2. Current architecture bottlenecks (ordered by impact)

### 🔴 BLOCKER — DB pool max is 10
`foodflow_backend/src/config/env.js` defaults `DB_POOL_MAX=10`. That's a laptop dev setting. Each Node worker holds up to 10 PG connections; at 100 concurrent requests you'll queue-and-timeout.

**Fix (prod .env):**
```
DB_POOL_MAX=50
DB_POOL_MIN=10
```
Postgres default `max_connections=100`, so 50 leaves headroom for scheduled jobs + admin queries. If you run PM2 with N workers, divide `DB_POOL_MAX` by N and bump `max_connections` proportionally.

### 🔴 BLOCKER — Single Node process, no clustering
`server.js` runs one `app.listen()`. On a 2-vCPU VM you're wasting half the CPU. Every launch playbook needs PM2 with cluster mode.

**Fix:**
```
npm i -g pm2
pm2 start src/server.js -i max --name foodflow-api
pm2 startup && pm2 save
```
`-i max` spawns one worker per vCPU. Also add sticky-cookie config in nginx if you rely on in-process caches (the current `reportService` cache is in-process — see #4).

### 🟡 IMPORTANT — Rate limit is 120/min per IP
For a cafe with 10 staff on the same NAT'd Wi-Fi, that's 12 requests/min each. First busy Friday, they'll hit 429s.

**Fix (prod .env):**
```
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=600      # 10/sec per IP — covers a full shift
```
Longer-term: switch the limiter to key on user ID instead of IP so cafe-Wi-Fi noise doesn't cross-limit.

### 🟡 IMPORTANT — No shared cache (reportService uses in-process Map)
Every worker has its own daily-report cache. On a 4-worker cluster you'll refetch 4× until the cache warms per worker. Not critical for launch; move to Redis in week 2.

### 🟡 IMPORTANT — Sentry is soft-loaded but DSN not set
Errors on Day-1 will be invisible unless you set `SENTRY_DSN` in prod `.env`. Do this before you flip DNS.

### 🟢 OK — Backend security posture
- Every business-scoped route gates on `requireBusinessOwnership` (verified in Sprint 11 audit + IDOR script)
- Refresh cookie is HttpOnly + SameSite=strict + Secure(prod)
- CORS wildcard is rejected in prod at boot
- Helmet + trust-proxy configured
- PII scrubber wired on Sentry + Flutter telemetry

### 🟢 OK — Indexes
Reviewed all `CREATE INDEX` statements in migrations 001-043. Hot tables have coverage:
- `orders(business_id, created_at)` — yes
- `orders(status, created_at)` — yes (via idx_kot_tickets_status equivalent)
- `menu_items(business_id, category)` — yes
- `business_users(business_id, is_active)` — yes
- `subscriptions(business_id, status)` — implicit via unique
- Missing: none I could find that would hurt Day-1

### 🟢 OK — Migrations 042 + 043
Confirmed both are safe to apply on Shivhari's prod DB. Order matters — 042 first, 043 second.

---

## 3. Test coverage snapshot

| Layer | Coverage | Confidence |
|---|---|---|
| Backend unit tests | 58/58 pass — auth, orders, staff, menu, PnL, tax, invoicing, WhatsApp webhook, Sentry scrubber, onboarding email | High |
| Backend integration | 25 suites, needs live PG. All pass on your Mac | High |
| Backend security | IDOR audit script + backend security audit doc | High |
| Dashboard Playwright | Public routes + wizard shape covered | Medium (auth-gated flows deferred) |
| Admin Playwright | Login + 404 + auth-bounce covered | Medium |
| Flutter widget tests | humanizeError, telemetry scrubber, connectivity | Medium |
| Flutter integration | Manual only — the emulator + browser sweep from earlier this week | Medium |
| **Overall pre-launch confidence** | — | **Green with the fixes in §2** |

---

## 4. What to do TODAY before deploying tomorrow

Ordered by dependency:

1. **Fix `.env` on prod** with the values from §2 (DB_POOL_MAX=50, RATE_LIMIT_MAX=600, SENTRY_DSN, JWT_SECRET rotated, etc.)
2. **Apply migrations 042 + 043** on prod DB (`npm run migrate`)
3. **Install PM2, start API in cluster mode** (`pm2 start src/server.js -i max`)
4. **Run the load test in `load-test/`** on staging (or dev) — get a baseline number. If it drops below 300 RPS on 2vCPU, don't launch until PM2 + DB_POOL_MAX are actually applied.
5. **Enable nginx gzip + cache-control** for `/uploads` static + landing assets
6. **Nightly `pg_dump` cron** to Wasabi Mumbai — Postgres has zero forgiveness for "oh I forgot the backup"
7. **Verify /health from the public internet** before flipping DNS
8. **Announce launch to 5 friendly cafes first**, not to 500

---

## 5. Go / no-go

**Go if:**
- Items 1-7 above are done
- Load test shows ≥300 RPS sustained with <300ms p99 latency
- You have SSH access + a rollback plan (previous release SHA pinned)

**No-go if:**
- DB_POOL_MAX still 10
- Only one Node worker
- No Sentry DSN
- No backup schedule
- Load test never ran

If you're on the fence, launch to **5 cafes**, watch for 3 days, then open to 50. It's the difference between "we had a launch" and "we had an outage."
