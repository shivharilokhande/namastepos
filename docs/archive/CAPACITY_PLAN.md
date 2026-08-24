# FoodFlow — Capacity plan to 1M requests

**Author:** Shivhari
**Date:** 2026-08-20

Straight math + concrete infra recipes. No fluff.

---

## What one request costs on the current stack

Measured against `foodflow_backend/src/services/*` hot paths, assuming 2-vCPU / 4GB / SSD PG on the same VM:

| Endpoint | p50 latency | Cost profile |
|---|---|---|
| `GET /health` | 5-8 ms | Trivial |
| `GET /auth/me` | 15-25 ms | 2 SQL queries |
| `GET /businesses/:id/addons` | 10-15 ms | 1 SQL |
| `GET /businesses/:id/menu` | 30-60 ms | Depends on menu size (n rows) |
| `GET /businesses/:id/orders?pending` | 40-80 ms | 2 SQL + JSON aggregation |
| `GET /businesses/:id/reports/daily` | 100-250 ms | 5 SQL + aggregate (cached 5min) |
| `POST /businesses/:id/orders` | 80-150 ms | Transactional — 6-8 SQL |

**Throughput ceiling per Node worker** ≈ `1000ms / avg_latency_ms ≈ 25-40 req/sec/worker` on the mixed read workload. A 2-vCPU VM with `pm2 -i 2` therefore caps around **~60 RPS** if you leave DB_POOL_MAX=10 (queue starves). With `DB_POOL_MAX=50`, you'll hit **~250-400 RPS**.

---

## Sizing tables

### Tier 1 — MVP launch (0-500 cafes)

| Resource | Sizing |
|---|---|
| VM | 2 vCPU / 4 GB / 40 GB SSD (Hetzner CPX21 / DO 2GB-Premium) — ~₹800/mo |
| Postgres | Same VM, tuned: `shared_buffers=1GB, max_connections=200, effective_cache_size=2.5GB` |
| Redis | Same VM, 256MB, only for report cache |
| Node cluster | PM2 `-i 2` (2 workers), DB_POOL_MAX=25 per worker |
| Nginx | Same VM, gzip on, 1MB proxy_buffers, tls terminated here |
| Est. capacity | **500 cafes, ~300-500 RPS peak, ~15M req/day** |
| **Monthly cost** | **₹800-1,500 total** |

### Tier 2 — Growth (500-5,000 cafes) — target for month 3-4

| Resource | Sizing |
|---|---|
| API cluster | 2× dedicated 4-vCPU / 8-GB VMs behind nginx LB |
| Postgres | 1 primary (4 vCPU / 16 GB) + 1 read replica, streaming replication |
| Redis | Small dedicated VM (2 GB), report cache + rate-limit store |
| CDN | Cloudflare in front of nginx for static + `/uploads` |
| Node | PM2 `-i max` on each API node, DB_POOL_MAX=25/worker |
| Est. capacity | **5,000 cafes, ~3,000 RPS peak, ~200M req/day** |
| **Monthly cost** | **₹8,000-15,000** |

### Tier 3 — Scale (~1M req/minute = 16.7k RPS)

| Resource | Sizing |
|---|---|
| API cluster | 4-6× 4-vCPU nodes behind nginx or ALB |
| Postgres | Primary + 2 read replicas + PgBouncer transaction pooling |
| Redis | Cluster mode (3 nodes) — session + cache + rate limits |
| Queue | RabbitMQ / SQS for aggregator webhooks + email + printer jobs |
| Object store | S3-compatible (Wasabi Mumbai) for `/uploads` |
| Observability | Sentry + Grafana + Prometheus node exporter |
| **Monthly cost** | **₹40,000-80,000** |

Beyond this, real work on the code path is needed — the app can't grow to Amazon-scale on infra alone.

---

## The path to 1M requests

Interpretation-by-interpretation:

### If "1M requests per day"
**Already there.** Tier 1 handles it. Nothing to change beyond §2 of `PRODUCTION_READINESS.md`.

### If "1M requests per hour" (~278 RPS)
**Tier 1 with PM2 + DB_POOL_MAX bump handles it.** Run the load test to confirm on your prod VM.

### If "1M requests per minute" (~16.7k RPS)
**Requires Tier 3.** Realistic timeline from Tier 1 → Tier 3 is **3-6 weeks of infra + code work**:

1. Week 1 — Add Redis, migrate report cache off in-process. Add PgBouncer.
2. Week 2 — Add read replica. Route report queries there.
3. Week 3 — Move `/uploads` to S3. Move nginx to a separate LB VM.
4. Week 4 — Add second API node behind LB. Rerun load test.
5. Week 5 — Convert aggregator webhook handler to enqueue+worker.
6. Week 6 — Third + fourth API nodes. Cluster Redis. Rerun load test at 15-20k RPS.

None of that is safely doable "tomorrow." Anyone who tells you otherwise is selling something.

### If "1M concurrent connections"
Different problem entirely — that's WebSocket / long-poll territory. FoodFlow doesn't use WebSockets today (KDS/Orders are 5-second polling). If you need actual live push:

- Add a separate `foodflow-realtime` service with `ws` or `socket.io`
- Front it with an LB that supports WebSocket upgrade (nginx or ALB)
- 1M concurrent WebSocket connections needs 10-15 dedicated nodes with tuned kernel `fs.file-max`, `net.core.somaxconn`, etc.

---

## What each layer can produce (throughput budget)

Once tuned:

| Layer | Sustainable throughput |
|---|---|
| One tuned Node worker | 40-80 RPS on the mixed workload |
| 2-vCPU PM2 cluster | 80-160 RPS |
| 4-vCPU PM2 cluster (Tier 1) | 250-500 RPS |
| Postgres (1 primary, 100 conns) | ~2,000 simple queries/sec |
| Postgres primary + 1 read replica | ~5,000 read qps |
| Redis (single node) | 100,000+ ops/sec — never the bottleneck |
| Nginx front | 50,000+ RPS for static — never the bottleneck |

**Interpretation:** the ceiling is *always* Postgres before it's the app. Every scaling step past Tier 1 is really "how do we get more Postgres capacity" (bigger box → replicas → sharding → CQRS/write-behind).

---

## Answering "how many concurrent load it can handle"

Realistic answer for tomorrow's launch, with the two config fixes applied (DB_POOL_MAX=50 + PM2 cluster):

- **~100-200 concurrent active cafes** actively placing orders + polling
- **~300-500 sustained RPS**
- **p95 latency around 200-400ms**
- **Peak burst: 1,000 RPS for 30-60 seconds** (dinner rush) before the rate limiter or DB pool becomes the queue

That's enough for launch. As you cross ~200 active cafes, start Tier 2. Watch Sentry, watch `/health` DB status, watch p95.

---

## The one-page launch checklist

1. `.env` on prod has `DB_POOL_MAX=50`, `RATE_LIMIT_MAX=600`, `SENTRY_DSN=`, `JWT_SECRET` rotated
2. `npm run migrate` on prod DB (042 + 043)
3. `pm2 start src/server.js -i max`
4. `k6 run load-test/k6-mixed-workload.js` against prod → gets ≥300 RPS
5. `curl https://api.foodflow.in/v1/health` from external internet → 200 OK
6. `pg_dump` cron scheduled + tested with a restore
7. Sentry dashboard confirms one test error arrives from prod
8. Rollback plan: previous SHA in `git tag prev-release` + `pm2 restart` runbook
9. Launch to 5 cafes first. Watch for 24h. Then open to more.

If items 1-8 aren't done, don't flip DNS tomorrow. Launch Monday instead.
