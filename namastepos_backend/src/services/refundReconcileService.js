// NamastePOS backend — gateway refund reconciler (Day-1 CTO recommendation).
//
// Background context: `refundService.refundOrder` inserts rows with
// status='pending' when the original payment was gateway-backed (card /
// online / Razorpay). Nothing was flipping those to 'processed', so
// owners saw refunds stuck forever. This drainer:
//   1. Picks up N=25 oldest pending gateway-backed refunds.
//   2. Looks up the original `payments.razorpay_payment_id` for each.
//   3. Calls Razorpay `/v1/payments/{pid}/refund`.
//   4. On success → status='processed', processed_at=NOW(), stores
//      the Razorpay refund id + raw payload.
//   5. On 4xx → status='failed', records the reason (idempotent — the
//      owner can retry via the dashboard).
//   6. On 5xx / network → leaves the row as 'pending', bumps a small
//      `attempt_count` in raw_payload (best-effort). Backoff comes for
//      free because we run every 5 minutes; a row that fails 12 times
//      in a row (~1 hour) is flagged for manual review.
//
// Called from cronWorker every 5 ticks (~5 min).

const https = require('https');
const env = require('../config/env');
const { query } = require('../config/db');
const logger = require('../config/logger');

const MAX_BATCH = 25;
const MAX_ATTEMPTS_BEFORE_FLAG = 12;

function rzRefund(paymentId, amountPaise, reason) {
  return new Promise((resolve, reject) => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      return reject(new Error('Razorpay not configured'));
    }
    const body = JSON.stringify({
      amount: amountPaise, notes: { reason: reason || '' },
    });
    const auth = Buffer.from(
      `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`,
    ).toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com',
      path: `/v1/payments/${paymentId}/refund`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = {};
        try { json = chunks ? JSON.parse(chunks) : {}; } catch (_) { /* keep {} */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({ statusCode: res.statusCode, body: json });
        }
        // Distinguish 4xx (permanent) from 5xx (transient).
        return reject(Object.assign(
          new Error(json.error?.description || `Razorpay HTTP ${res.statusCode}`),
          { statusCode: res.statusCode, body: json, isTransient: res.statusCode >= 500 },
        ));
      });
    });
    req.on('error', (e) => reject(Object.assign(e, { isTransient: true })));
    req.write(body);
    req.end();
  });
}

async function _attemptCount(raw) {
  const p = raw || {};
  return (p.attempt_count || 0) + 1;
}

// NP-111 follow-up: async refunds (razorpay_refund_id stamped, status still
// 'pending') were finished ONLY by the refund.processed/refund.failed
// webhook. A missed/out-of-order webhook left them pending until the 48h
// integrity alert. This poller asks Razorpay directly for rows > 10 min old.
function _rzGetRefund(refundId) {
  return new Promise((resolve, reject) => {
    const auth = Buffer
      .from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)
      .toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com',
      path: `/v1/refunds/${refundId}`,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const json = chunks ? JSON.parse(chunks) : {};
          if (res.statusCode >= 300) {
            return reject(Object.assign(
              new Error(json.error?.description || `Razorpay HTTP ${res.statusCode}`),
              { statusCode: res.statusCode, body: json, isTransient: res.statusCode >= 500 },
            ));
          }
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(Object.assign(e, { isTransient: true })));
    req.end();
  });
}

async function pollAsyncPending() {
  const due = await query(
    `SELECT id, business_id, razorpay_refund_id
       FROM refunds
      WHERE status = 'pending'
        AND razorpay_refund_id IS NOT NULL
        AND created_at < NOW() - INTERVAL '10 minutes'
      ORDER BY created_at
      LIMIT $1`,
    [MAX_BATCH],
  );
  let settled = 0;
  for (const row of due.rows) {
    try {
      const rz = await _rzGetRefund(row.razorpay_refund_id);
      if (rz.status === 'processed') {
        settled += 1;
        await query(
          `UPDATE refunds
              SET status = 'processed', processed_at = NOW(),
                  raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                                || jsonb_build_object('poller_ok', TRUE, 'rz', $1::jsonb)
            WHERE id = $2 AND status = 'pending'`,
          [rz, row.id],
        );
      } else if (rz.status === 'failed') {
        settled += 1;
        await query(
          `UPDATE refunds
              SET status = 'failed',
                  raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                                || jsonb_build_object('poller_reason', 'gateway reports failed',
                                                      'rz', $1::jsonb)
            WHERE id = $2 AND status = 'pending'`,
          [rz, row.id],
        );
      }
      // still 'pending' at the gateway → leave it; next tick re-polls.
    } catch (err) {
      // Transient or lookup error — never change state on a failed poll.
      logger.warn(`[refund-reconciler] poll ${row.razorpay_refund_id} failed: ${err.message}`);
    }
  }
  if (settled) logger.info(`[refund-reconciler] poller settled=${settled}`);
  return { settled };
}

async function tick() {
  // Only draw refunds that:
  //   • are actually pending
  //   • have an order + a payment method that means gateway
  //   • are older than 30s (avoid racing with the initial insert)
  // NP-111 (2026-09-03):
  //   • `AND r.razorpay_refund_id IS NULL` — refundService now submits the
  //     gateway refund inline and stamps the refund id when Razorpay reports
  //     it async; re-submitting such a row here would double-refund.
  //   • order refunds carry NO payment_id (they link via order_id), so the
  //     old `p.id = r.payment_id` join always came up empty and every one of
  //     them was mis-marked failed. Resolve the payment through the order
  //     (guest checkout writes payments.order_id; session settle-all writes
  //     payments.notes->>'sessionId') with payment_id kept as first choice.
  const due = await query(
    `SELECT r.*, o.payment_method,
            COALESCE(p.razorpay_payment_id, po.razorpay_payment_id) AS razorpay_payment_id
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
  LEFT JOIN payments p ON p.id = r.payment_id
  LEFT JOIN LATERAL (
        SELECT pp.razorpay_payment_id
          FROM payments pp
         WHERE pp.business_id = r.business_id
           AND pp.razorpay_payment_id IS NOT NULL
           AND (pp.order_id = r.order_id
                OR (o.table_session_id IS NOT NULL
                    AND pp.notes->>'sessionId' = o.table_session_id::text))
         ORDER BY pp.created_at DESC
         LIMIT 1
       ) po ON TRUE
      WHERE r.status = 'pending'
        AND r.razorpay_refund_id IS NULL
        AND r.created_at < NOW() - INTERVAL '30 seconds'
        AND o.payment_method IN ('card', 'online')
      ORDER BY r.created_at
      LIMIT $1`,
    [MAX_BATCH],
  );

  if (due.rowCount === 0) {
    // Still poll async-pending rows even when nothing new is due.
    try { await pollAsyncPending(); } catch (e) {
      logger.warn(`[refund-reconciler] pollAsyncPending failed: ${e.message}`);
    }
    return { processed: 0, failed: 0, deferred: 0 };
  }

  let processed = 0;
  let failed = 0;
  let deferred = 0;

  for (const row of due.rows) {
    // If we don't have a razorpay_payment_id we can't call the API — mark
    // failed with a clear reason so the owner can escalate.
    if (!row.razorpay_payment_id) {
      failed += 1;
      await query(
        `UPDATE refunds
            SET status = 'failed',
                raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                              || jsonb_build_object('reconciler_reason',
                                    'no razorpay_payment_id on payment row',
                                    'manualRequired', TRUE)
          WHERE id = $1`,
        [row.id],
      );
      continue;
    }

    try {
      const rz = await rzRefund(row.razorpay_payment_id, row.amount_paise, row.reason);
      // NP-111: only claim 'processed' when Razorpay says so. A refund the
      // API reports as 'pending' is genuinely async — stamp the refund id
      // (which also removes it from this drainer's WHERE) and let the
      // refund.processed / refund.failed webhook finish it.
      if (rz.body.status === 'pending') {
        deferred += 1;
        await query(
          `UPDATE refunds
              SET razorpay_refund_id = $1,
                  raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                                || jsonb_build_object('gatewayAsync', TRUE,
                                                      'rz', $2::jsonb)
            WHERE id = $3`,
          [rz.body.id || null, rz.body, row.id],
        );
        continue;
      }
      processed += 1;
      await query(
        `UPDATE refunds
            SET status = 'processed',
                processed_at = NOW(),
                razorpay_refund_id = $1,
                raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                              || jsonb_build_object('reconciler_ok', TRUE,
                                                    'rz', $2::jsonb)
          WHERE id = $3`,
        [rz.body.id || null, rz.body, row.id],
      );
    } catch (err) {
      if (err.isTransient) {
        deferred += 1;
        const attempts = await _attemptCount(row.raw_payload);
        const flagged = attempts >= MAX_ATTEMPTS_BEFORE_FLAG;
        await query(
          `UPDATE refunds
              SET raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                                || jsonb_build_object('attempt_count', $1::int,
                                                      'last_transient_error', $2::text,
                                                      'flagged_for_review', $3::boolean)
            WHERE id = $4`,
          [attempts, err.message || 'transient', flagged, row.id],
        );
        if (flagged) {
          logger.warn(
            `[refund-reconciler] refund ${row.id} flagged for review after ${attempts} transient failures`,
          );
        }
      } else {
        failed += 1;
        await query(
          `UPDATE refunds
              SET status = 'failed',
                  raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                                || jsonb_build_object('reconciler_reason', $1::text,
                                                      'rz_body', $2::jsonb)
            WHERE id = $3`,
          [err.message || 'unknown', err.body || {}, row.id],
        );
      }
    }
  }

  if (processed || failed || deferred) {
    logger.info(
      `[refund-reconciler] processed=${processed} failed=${failed} deferred=${deferred}`,
    );
  }
  // NP-111 follow-up: settle async-pending rows the webhook never finished.
  try { await pollAsyncPending(); } catch (e) {
    logger.warn(`[refund-reconciler] pollAsyncPending failed: ${e.message}`);
  }
  return { processed, failed, deferred };
}

module.exports = { tick, pollAsyncPending };
