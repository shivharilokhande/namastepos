# NamastePOS — Load testing kit

Two scripts. Run against your dev backend first, then against the prod-mirror staging box before flipping DNS tomorrow.

---

## Prereqs

```
brew install k6
```

Get a valid `API_TOKEN` and `BIZ_ID`. Fastest way:

1. Open http://localhost:5174 in Chrome
2. Sign in with Google
3. DevTools → Application → Local Storage → `ff_token`  (that's your bearer token)
4. DevTools → Application → Local Storage → `ff_business` → copy the `id` field  (that's your business UUID)

---

## Test 1 — Mixed workload (realistic day-in-the-life)

```
API_BASE=http://localhost:4000/v1 \
API_TOKEN=<paste> \
BIZ_ID=<paste> \
k6 run k6-mixed-workload.js
```

Ramps to 100 VUs over 60s, holds for 3 min, ramps down. Simulates ~300-600 RPS depending on API speed.

**Pass criteria (printed at end):**
- Sustained RPS ≥ 300
- p95 latency < 800ms
- Error rate < 1%

Anything less and you have a bottleneck — usually DB pool or Node clustering. See `PRODUCTION_READINESS.md` §2.

---

## Test 2 — Spike / burst (POS rush at 8pm)

Same script, override stages via env var:

```
API_BASE=http://localhost:4000/v1 API_TOKEN=... BIZ_ID=... \
k6 run --vus 300 --duration 60s k6-mixed-workload.js
```

This simulates 300 concurrent cafes hitting the API at the same time. If the backend chokes here but is fine at Test 1's 100 VUs, the bottleneck is concurrency (add workers) not throughput.

---

## Sizing math — what the numbers mean

| Result | Real-world capacity |
|---|---|
| 100 RPS  | 8.6M requests/day. Fine for 500 cafes. |
| 300 RPS  | 26M requests/day. Fine for 3,000 cafes. |
| 1,000 RPS | 86M requests/day. Fine for 10,000 cafes. |
| 10,000 RPS | 864M requests/day. Fine for 100,000 cafes — needs a cluster + LB. |

Rule of thumb: **1 cafe ≈ 5 RPS at peak lunch hour** (POS polling + KOT polling + orders list refresh). So 300 RPS = 60 concurrent cafes at peak, or ~600 cafes total if they don't all peak at once.

---

## What to run tomorrow morning before flipping DNS

```
# On the prod VM, against the actual prod backend
API_BASE=https://api.namastepos.in/v1 \
API_TOKEN=<owner token you generated for testing> \
BIZ_ID=<your own biz uuid> \
k6 run k6-mixed-workload.js
```

If this fails on prod, DO NOT flip DNS. Investigate first. It's much cheaper than an outage during the launch push.

---

## To stress toward 1M

**1M requests/day** — trivial. The default test already covers this.

**1M requests/hour** (~278 RPS) — should pass Test 1 on 2-vCPU + PM2 + DB_POOL_MAX=50.

**1M requests/minute** (~16.7k RPS) — needs:
- 4-node API cluster behind nginx load balancer
- PG primary + 2 read replicas
- Redis (for reports cache + session store)
- Estimated cost: ~₹8,000-15,000/month for the whole stack in Mumbai region

**1M requests/second** — not a realistic pre-launch target. Google-scale problem, not a launch problem.

See `PRODUCTION_READINESS.md` for the full go/no-go.
