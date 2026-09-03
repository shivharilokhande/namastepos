-- 070 — NP-121 revenue-integrity cron support (2026-09-03). Additive only.
--
-- The nightly sweep (src/services/revenueIntegrityService.js) scans for
--   • refunds stuck status='pending' older than 48h
--   • webhook_events rows with NULL response_body older than 1h
-- Both tables only had business-scoped / unique-id indexes, so each scan
-- would seq-scan as the tables grow. Partial indexes keep the sweeps
-- index-only and nearly free (the indexed subsets are tiny by design —
-- pending refunds and in-flight webhook claims are transient states).

CREATE INDEX IF NOT EXISTS idx_refunds_pending_created
  ON refunds (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_events_inflight_created
  ON webhook_events (created_at)
  WHERE response_body IS NULL;

-- NP-111 side-finding: guestController.confirmSessionPayment has been
-- INSERTing payments(..., notes) with a jsonb sessionId since FF-251, but
-- no migration ever added the column — that INSERT could only fail. The
-- column is also how the refund path (refundService / refundReconcile)
-- resolves the Razorpay payment behind a session settle-all. Additive.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS notes JSONB;
