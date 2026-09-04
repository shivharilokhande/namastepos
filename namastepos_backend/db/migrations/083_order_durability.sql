-- NamastePOS migration 083 — order-path operational durability (NP-301..304)
-- 2026-09-04
--
-- Four verified defects from the external audit, all in the "order committed
-- but a side effect silently vanished" family:
--
--   NP-301  KOT generation was wrapped in `catch (_) {}` — an order could
--           commit, tell the diner "accepted", and never reach the kitchen.
--           The ticket ROWS are now written inside the order transaction (a
--           bill whose kitchen record failed to write is not a valid bill), and
--           PRINTING is decoupled through the existing `print_jobs` queue,
--           enqueued in the same transaction and drained by the print agent.
--   NP-302  Recipe + liquor-FIFO deductions were swallowed the same way, so
--           sales were right while stock / food-cost / excise were wrong.
--   NP-303  (no schema change — session-level refund lock in refundService)
--   NP-304  usage_counters.monthly_orders drift (no schema change — nightly
--           reconciliation in orderDurabilityService)
--
-- Everything here is additive: two nullable repair-marker columns on `orders`
-- (mirroring the existing `pos_mirror_error` pattern from 080), one nullable
-- retry-schedule column on `print_jobs`, and indexes to keep the new sweeps
-- bounded. No backfill, no rewrite, no drop of a data-bearing column.

-- ── Repair markers on orders ────────────────────────────────────────────
-- `pos_mirror_error` (080) established the pattern: when a best-effort side
-- effect fails, STAMP the row so a cron sweep can retry it and the nightly
-- integrity email can escalate what is still broken. Silence is the bug.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS kot_error TEXT;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS inventory_error TEXT;

COMMENT ON COLUMN orders.kot_error IS
  'NP-301: set when the KOT repair sweep could not (re)create this order''s '
  'kitchen tickets. NULL = healthy. Read by orderDurabilityService.repairMissingKots '
  'and escalated by the nightly revenue-integrity email.';
COMMENT ON COLUMN orders.inventory_error IS
  'NP-302: set when a NON-critical inventory side effect could not be decided '
  'or applied (e.g. the recipe-costing entitlement lookup failed), so stock / '
  'food-cost may be under-recorded for this order. NULL = healthy. Retried by '
  'orderDurabilityService.repairInventoryEffects. A CRITICAL deduction failure '
  'never lands here — it rolls the order back instead.';

CREATE INDEX IF NOT EXISTS idx_orders_kot_error
  ON orders (created_at DESC)
  WHERE kot_error IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_inventory_error
  ON orders (created_at DESC)
  WHERE inventory_error IS NOT NULL;

-- The "committed order with no kitchen ticket" sweep is an anti-join from
-- orders to kot_tickets. kot_tickets had no index on order_id (006 indexed
-- station/business only), so that anti-join was a sequential scan per tick.
CREATE INDEX IF NOT EXISTS idx_kot_tickets_order
  ON kot_tickets (order_id);

-- Same anti-join needs the driving side bounded: recent, still-live orders.
CREATE INDEX IF NOT EXISTS idx_orders_created_live
  ON orders (created_at DESC)
  WHERE status <> 'cancelled';

-- ── print_jobs: PENDING → RETRYING → PRINTED, not a dead letter on blip ──
-- The queue already existed (021) with status queued|printing|done|failed, but
-- `failed` was TERMINAL and `dequeueNext` only ever picked `queued` — so the
-- first time a thermal printer was offline the KOT print was lost forever.
-- `next_attempt_at` turns `failed` into a genuine dead-letter that a job only
-- reaches after PRINT_JOB_MAX_ATTEMPTS; before that a failure goes back to
-- `queued` with a backoff.
-- Added nullable → defaulted → backfilled → NOT NULL rather than
-- `NOT NULL DEFAULT NOW()` in one step: a VOLATILE default forces a full table
-- rewrite under ACCESS EXCLUSIVE. print_jobs is tiny today (nothing enqueued
-- KOTs before this change), but the pattern is what the next, bigger table
-- deserves. Existing rows inherit their own created_at, so anything already
-- queued is immediately claimable.
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE print_jobs
  ALTER COLUMN next_attempt_at SET DEFAULT NOW();
UPDATE print_jobs SET next_attempt_at = created_at WHERE next_attempt_at IS NULL;
ALTER TABLE print_jobs
  ALTER COLUMN next_attempt_at SET NOT NULL;

COMMENT ON COLUMN print_jobs.next_attempt_at IS
  'NP-301: earliest time the print agent may claim this job. A failed attempt '
  'returns the job to status=queued with a backoff instead of dead-lettering it '
  'on the first offline printer; status=failed now means attempts exhausted.';

-- Claim index has to include the new gate or every poll re-reads jobs that are
-- backing off.
DROP INDEX IF EXISTS idx_print_jobs_queue;
CREATE INDEX IF NOT EXISTS idx_print_jobs_queue
  ON print_jobs (business_id, status, next_attempt_at)
  WHERE status IN ('queued', 'printing');

-- "Does this order have a print job at all?" — the other half of the KOT sweep.
CREATE INDEX IF NOT EXISTS idx_print_jobs_order
  ON print_jobs (order_id)
  WHERE order_id IS NOT NULL;

-- Dead-lettered print jobs are an operational alert (the kitchen never got
-- paper); the nightly email lists them.
CREATE INDEX IF NOT EXISTS idx_print_jobs_dead
  ON print_jobs (created_at DESC)
  WHERE status = 'failed';
