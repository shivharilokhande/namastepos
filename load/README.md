# Load test — the read path a live restaurant hammers

One script: [`orders-delta-poll.js`](./orders-delta-poll.js).

It drives the two reads that dominate authenticated traffic in production:

| Request | Real-world cadence | Modelled as |
| --- | --- | --- |
| `GET /businesses/:id/orders?updatedSince=…&limit=500` | every **10 s** per device (`orders_screen.dart:45`) | every iteration |
| `GET /businesses/:id/menu` | POS launch + pull-to-refresh | every 12th iteration (≈2 min) |

Profile: **50 concurrent devices spread across tenants**, dinner-rush shaped —
2 min fill to 15 VUs, 3 min ramp to 50, **10 min sustained peak**, then a drain.
~18 minutes total.

> This is a different test from `../load-test/k6-mixed-workload.js`, which is a
> broad seven-endpoint mix for capacity sizing. This one is narrow on purpose: it
> exists to characterise the delta poll, which is the query most likely to fall
> over first.

---

## Prerequisites

```bash
brew install k6      # macOS
```

You need a token + business id per tenant you want to simulate. Mint them
against the environment you are testing (**not** prod):

```bash
curl -s -X POST "$TARGET_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"loadtest@example.com","password":"…"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["token"], d["business"]["id"])'
```

Write them to `load/tenants.json` (git-ignored — do not commit tokens):

```json
[
  { "token": "eyJhbGciOi…", "businessId": "62512465-6a63-49b4-82dc-9a9d387ac55e" },
  { "token": "eyJhbGciOi…", "businessId": "9b1f0c22-7d31-4a6e-9f10-2c4e8a7b5d33" }
]
```

Use **at least 3–4 tenants**. With one tenant you are measuring a single hot
`business_id` and Postgres will keep its whole working set in shared buffers —
which flatters the result and hides exactly the problem described below.

## Running it

```bash
cd load

# against staging / a review environment — note the /v1 suffix
TARGET_URL=https://staging-api.example.com/v1 k6 run orders-delta-poll.js

# inline tenants instead of the file
TARGET_URL=https://staging-api.example.com/v1 \
TENANTS='[{"token":"…","businessId":"…"}]' \
  k6 run orders-delta-poll.js

# shorter smoke run to check wiring before committing to 18 minutes
TARGET_URL=https://staging-api.example.com/v1 \
  k6 run --stage 30s:10 --stage 1m:10 --stage 10s:0 orders-delta-poll.js
```

| Env var | Required | Purpose |
| --- | --- | --- |
| `TARGET_URL` | **yes** | Deployed API origin **including `/v1`**. No default — the script aborts without it. |
| `TENANTS` | one of these | Inline JSON array of `{token, businessId}`. |
| `TENANTS_FILE` | one of these | Path to the same JSON. Default `./tenants.json`. |
| `ALLOW_PROD` | only for prod | Must be exactly `yes-i-mean-it`. |

### Safety behaviour

- **No default URL.** Missing `TARGET_URL` aborts with an explanation.
- **Prod is refused.** `api.namastepos.in` and `namastepos-api.onrender.com`
  abort unless `ALLOW_PROD=yes-i-mean-it`. If you do override, stay out of
  11:00–15:00 and 18:00–23:00 IST — those are lunch and dinner service.
- **Pre-flight.** `setup()` does one `GET /menu` and aborts on a non-200, so a
  bad token or a missing `/v1` fails in seconds rather than after 18 minutes of
  401s.

---

## Reading the result

Thresholds are hard gates — a breach exits non-zero, so this is CI-usable.

| Metric | Gate | Meaning |
| --- | --- | --- |
| `delta_poll_ms` | p95 < 500 ms, p99 < 1500 ms | The 10 s poll. |
| `menu_read_ms` | p95 < 800 ms, p99 < 2000 ms | Bigger payload, read rarely. |
| `http_req_failed` | rate < 1 % | Transport/status failures. |
| `checks` | rate > 99 % | Body-shape assertions. |

Also printed, and the most diagnostic numbers in the run:

- `delta_empty` vs `delta_with_rows` — how many polls had nothing to report.
  In a healthy run `delta_empty` should **dominate** (that is the point of a
  delta poll). Which means `delta_poll_ms` is largely *the cost of returning
  nothing*.

### What a bad result looks like

**1. `delta_poll_ms` p95 breaches while `menu_read_ms` is comfortable.**
The headline failure. Menu reads are indexed and small; if they are fine and
the delta poll is not, the problem is the orders query, not the network, not
Node, not the pool.

**2. `delta_poll_ms` climbs across the 10-minute plateau instead of flattening.**
Latency that rises under *constant* VU count means work is accumulating —
connection-pool queueing, or the scan getting longer as the test itself writes
rows. Flat-but-slow is a fixed cost; rising-and-slow is a leak.

**3. p99 ≫ p95 (say p95 320 ms, p99 4 s).**
Tail-only pain is queueing, not query cost: `DB_POOL_MAX` is too low for the
concurrency, so requests wait for a connection. Check pool saturation before
touching SQL.

**4. `http_req_failed` spikes at the *end* of the ramp, not the plateau.**
Classic cold-start/scale-up artefact on Render, or Neon waking a suspended
compute. Re-run with the same profile; if it only ever appears in the first
ramp, it is the platform, not the code.

**5. Errors are 402/403 rather than 5xx.** Not a load problem at all — the
token's plan lost a feature or the staff role lacks a permission. Fix the
fixture.

**Rule of thumb for capacity:** 50 devices at a 10 s cadence is only ~5 req/s of
delta poll. If p95 is already near the gate at 5 req/s, the ceiling is far
closer than the request rate suggests — because the cost is per-scan, and the
scan grows with order history rather than with traffic.

---

## Expected first bottleneck

**`orderService.list()` with `updatedSince` set — i.e. the 10-second delta poll
itself** (`namastepos_backend/src/services/orderService.js:1666-1747`).

The query it builds for a delta caller is:

```sql
SELECT *, COUNT(*) OVER ()::int AS _total
  FROM orders
 WHERE business_id = $1
   AND updated_at > ($2::timestamptz - INTERVAL '1 millisecond')
   AND date_trunc('milliseconds', updated_at) > $2
 ORDER BY created_at DESC
 LIMIT $3 OFFSET $4
```

### The known history is genuinely fixed

The unbounded `COUNT(*) + GROUP BY` over the tenant's entire order history is
**gone**. `orderService.js:1726` now reads `if (!updatedSince)` — delta callers
skip the `channelCounts` query altogether (they never render the chips), and an
undated call is bounded to `created_at >= NOW() - INTERVAL '90 days'`, which
`idx_orders_business_date (business_id, created_at DESC)` covers. That fix holds.

### But the `updated_at` predicate still cannot use an index

The code comments at lines 1683–1691 say the truncated predicate was left
non-indexable on purpose and a plain `updated_at > $n - 1ms` was added
alongside it *"so the plain half can use an index"*.

**That index does not exist.** Every index on `orders` is on `created_at` or a
partial error flag:

| Index | Columns |
| --- | --- |
| `idx_orders_business_date` | `(business_id, created_at DESC)` |
| `idx_orders_business_status` | `(business_id, status, created_at DESC)` |
| `idx_orders_created_at`, `idx_orders_created_live`, `idx_orders_active_by_date` | `created_at`-leading |
| `idx_orders_server_created` | `(server_user_id, created_at DESC)` |
| `idx_orders_customer`, `idx_orders_session`, `idx_orders_customer_date` | other leading columns |
| `idx_orders_kot_error`, `idx_orders_inventory_error`, `idx_orders_pos_mirror_stuck`, `idx_orders_price_adjustments`, `idx_orders_fulfilment_live` | partial, `created_at`-leading |

`grep -rn "updated_at" db/migrations/*.sql | grep -i index` returns **nothing**.
The indexable half of the predicate has no index to use — so the planner's only
option is `idx_orders_business_date` (or a seq scan), walking the tenant's rows
and filtering each one on `updated_at`.

### Why `LIMIT 500` does not save it

`COUNT(*) OVER ()` is a window function over the **whole** filtered result set.
Postgres has to produce every matching row before the `LIMIT` node can run, so
the LIMIT gives **no early termination**. The scan is unconditional.

### Why the steady state is the worst case

Most polls return **zero rows** — that is the entire purpose of delta polling.
So the common path walks the tenant's full order history to prove that nothing
changed. The cost is therefore a function of **lifetime order count, not of how
much changed**, and it grows every day a restaurant trades. A tenant's Orders
tab gets measurably slower the longer they are a customer, which is the worst
possible shape for a scaling problem.

Amplification: 10 s cadence × every logged-in device × `limit=500`. A six-device
restaurant issues ~36 polls/minute ≈ **52,000 full-history scans per day** for
one tenant, nearly all of them returning nothing.

### The fix, in order of value

1. **Add the missing composite index** so the predicate the code already wrote
   becomes usable:

   ```sql
   CREATE INDEX IF NOT EXISTS idx_orders_business_updated
     ON orders (business_id, updated_at DESC);
   ```

   Operational caveat: `scripts/migrate.js` wraps each migration file in a
   transaction, and `CREATE INDEX CONCURRENTLY` **cannot** run inside one (the
   runner's own comment notes no migration currently uses it). On a large
   `orders` table a plain `CREATE INDEX` takes a write lock for the duration —
   so either apply this one out-of-band during a quiet window, or add a
   documented non-transactional escape hatch to the runner. Do not paste
   `CONCURRENTLY` into a normal migration file and expect it to work.

2. **Drop `COUNT(*) OVER ()` for delta callers.** They ignore `.total`
   entirely, and removing it lets the `LIMIT` terminate early — which matters
   even *with* the index on the rare poll that does return rows.

3. **Reconsider `limit=500` on the mobile poll**
   (`orders_provider.dart:181`). With a correct index and an early-terminating
   LIMIT it is harmless; without both it sets the ceiling on how much work one
   tick can do.

Secondary reads were checked and are **not** suspects: the follow-up
`order_items WHERE order_id = ANY(...)` is covered by
`idx_order_items_order (order_id)`, and the menu read is covered by
`idx_menu_business (business_id)` / `idx_menu_active`.
