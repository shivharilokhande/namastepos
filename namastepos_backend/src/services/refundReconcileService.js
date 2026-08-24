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
      `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`
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
          { statusCode: res.statusCode, body: json, isTransient: res.statusCode >= 500 }
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

async function tick() {
  // Only draw refunds that:
  //   • are actually pending
  //   • have an order + a payment method that means gateway
  //   • are older than 30s (avoid racing with the initial insert)
  const due = await query(
    `SELECT r.*, o.payment_method, p.razorpay_payment_id, p.amount_paise AS payment_amount
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
  LEFT JOIN payments p ON p.id = r.payment_id
      WHERE r.status = 'pending'
        AND r.created_at < NOW() - INTERVAL '30 seconds'
        AND o.payment_method IN ('card', 'online')
      ORDER BY r.created_at
      LIMIT $1`,
    [MAX_BATCH]
  );

  if (due.rowCount === 0) return { processed: 0, failed: 0, deferred: 0 };

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
                                    'no razorpay_payment_id on payment row')
          WHERE id = $1`,
        [row.id]
      );
      continue;
    }

    try {
      const rz = await rzRefund(
        row.razorpay_payment_id, row.amount_paise, row.reason
      );
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
        [rz.body.id || null, rz.body, row.id]
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
          [attempts, err.message || 'transient', flagged, row.id]
        );
        if (flagged) {
          logger.warn(
            `[refund-reconciler] refund ${row.id} flagged for review after ${attempts} transient failures`
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
          [err.message || 'unknown', err.body || {}, row.id]
        );
      }
    }
  }

  if (processed || failed || deferred) {
    logger.info(
      `[refund-reconciler] processed=${processed} failed=${failed} deferred=${deferred}`
    );
  }
  return { processed, failed, deferred };
}

module.exports = { tick };
