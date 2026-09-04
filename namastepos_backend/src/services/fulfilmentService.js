// NamastePOS backend — delivery order fulfilment lifecycle (2026-09-03).
//
// The flow a delivery order actually goes through, whether it came from an
// aggregator webhook or our own channel:
//
//   placed → accepted → preparing → food_ready → rider_assigned
//          → picked_up (OTP handover) → delivered
//   placed → rejected                                    (terminal)
//   any-non-terminal → cancelled                          (terminal)
//
// Two rules shape this file:
//
// 1. Fulfilment is SEPARATE from `orders.status`. That enum drives revenue,
//    loyalty and every report; this track drives the delivery board. Where the
//    two genuinely coincide we mirror deliberately and narrowly (food_ready →
//    status 'ready', delivered → status 'collected') so reports stay correct
//    without the money machine learning new states.
//
// 2. Every outbound transition is QUEUED before it is sent
//    (aggregator_outbound_events, migration 079). Aggregators enforce SLAs on
//    accept/reject and food-ready callbacks, so a dropped fire-and-forget HTTP
//    call is a real commercial failure. With no partner credentials the drain
//    marks events `skipped` — the flow is fully usable for own-fleet delivery
//    today and starts pushing the moment credentials exist.

const { query, withTransaction } = require('../config/db');
const logger = require('../config/logger');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

const STATES = [
  'placed', 'accepted', 'rejected', 'preparing', 'food_ready',
  'rider_assigned', 'picked_up', 'delivered', 'cancelled',
];

// Transition matrix. Kept deliberately strict: a board that can jump from
// `placed` to `delivered` hides missed steps and breaks the prep-time SLA
// reporting the aggregators grade us on.
const TRANSITIONS = {
  placed: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'food_ready', 'cancelled'],
  preparing: ['food_ready', 'cancelled'],
  food_ready: ['rider_assigned', 'picked_up', 'cancelled'],
  rider_assigned: ['picked_up', 'cancelled'],
  picked_up: ['delivered', 'cancelled'],
  delivered: [],
  rejected: [],
  cancelled: [],
};

// Which transitions the aggregator must hear about, and under what event name.
const OUTBOUND_FOR = {
  accepted: 'accepted',
  rejected: 'rejected',
  preparing: 'preparing',
  food_ready: 'food_ready',
  picked_up: 'picked_up',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

const TIMESTAMP_COLUMN = {
  accepted: 'accepted_at',
  rejected: 'rejected_at',
  food_ready: 'food_ready_at',
  picked_up: 'picked_up_at',
  delivered: 'delivered_at',
};

function _digits(n = 4) {
  const max = 10 ** n;
  return String(Math.floor(Math.random() * max)).padStart(n, '0');
}

/** The live delivery board for an outlet (open orders only). */
async function board(businessId) {
  const r = await query(
    `SELECT id, order_no, source, channel, status, fulfilment_state,
            prep_minutes, customer_name, customer_phone, total,
            rider_name, rider_phone, rider_otp_expected, rider_otp_verified_at,
            aggregator_order_id, created_at, accepted_at, food_ready_at,
            picked_up_at
       FROM orders
      WHERE business_id = $1
        AND fulfilment_state IS NOT NULL
        AND fulfilment_state NOT IN ('delivered', 'rejected', 'cancelled')
      ORDER BY created_at ASC`,
    [businessId],
  );
  return r.rows.map((o) => ({
    id: o.id,
    orderNo: o.order_no,
    source: o.source,
    channel: o.channel,
    posStatus: o.status,
    state: o.fulfilment_state,
    prepMinutes: o.prep_minutes,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    total: o.total == null ? null : Number(o.total),
    rider: o.rider_name || o.rider_phone
      ? { name: o.rider_name, phone: o.rider_phone }
      : null,
    // Never leak the expected OTP to the client — staff TYPE it, they don't
    // read it off our screen (that would defeat the handover check). We only
    // say whether one is required and whether it has been satisfied.
    otpRequired: !!o.rider_otp_expected,
    otpVerified: !!o.rider_otp_verified_at,
    aggregatorOrderId: o.aggregator_order_id,
    createdAt: o.created_at,
    acceptedAt: o.accepted_at,
    foodReadyAt: o.food_ready_at,
    pickedUpAt: o.picked_up_at,
    nextStates: TRANSITIONS[o.fulfilment_state] || [],
  }));
}

/** Enqueue an outbound status callback (idempotent per order+event). */
async function _enqueueOutbound(client, { businessId, orderId, provider, event, payload }) {
  await client.query(
    `INSERT INTO aggregator_outbound_events
       (business_id, order_id, provider, event, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (order_id, event) DO NOTHING`,
    [businessId, orderId, provider || 'own', event, JSON.stringify(payload || {})],
  );
}

/**
 * Move an order along the fulfilment track.
 *
 * @param {object} opts
 *  - state: target state
 *  - prepMinutes: required when accepting (the kitchen's promise, and what the
 *    aggregator shows the diner)
 *  - reason: required when rejecting
 *  - rider: { name, phone, otp } when assigning a rider — `otp` is the code
 *    the aggregator/rider presents, stored for the handover check
 *  - otp: the code STAFF typed, required to move to picked_up when the order
 *    carries an expected OTP
 *  - actor: for the audit trail
 */
async function transition(businessId, orderId, opts = {}) {
  const target = opts.state;
  if (!STATES.includes(target)) throw new BadRequest(`Unknown fulfilment state: ${target}`);

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT id, order_no, status, fulfilment_state, channel, source,
              rider_otp_expected, rider_otp_verified_at, aggregator_order_id
         FROM orders
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [businessId, orderId],
    );
    if (cur.rowCount === 0) throw new NotFound('Order not found');
    const o = cur.rows[0];
    const from = o.fulfilment_state || 'placed';

    // Idempotent: re-sending the current state is a no-op, not an error. Both
    // a double-tap in the app and an aggregator retry land here. EXCEPTION:
    // rider_assigned carries new rider details on every assignment, so a
    // re-assignment must be applied rather than swallowed.
    if (from === target && target !== 'rider_assigned') {
      return _serialize(o, { unchanged: true });
    }

    // Re-assigning a rider is NOT a no-op: the new partner brings a new name,
    // phone and pickup OTP, and staff must be able to record them or the
    // handover check will reject a legitimate rider. Handled above the
    // same-state early return via `from === target` allowance below.
    const allowed = TRANSITIONS[from] || [];
    const sameStateUpdate = from === target && target === 'rider_assigned';
    if (!allowed.includes(target) && !sameStateUpdate) {
      // `force` exists for ONE caller: an aggregator webhook. Their fleet is
      // the source of truth for pickup/delivery, and real providers routinely
      // send only new-order + delivered — so refusing the jump would leave the
      // order stuck and its revenue unrecognised. We still refuse to move OUT
      // of a terminal state, so a cancelled order can never become delivered.
      const TERMINAL = ['cancelled', 'rejected'];
      if (!opts.force || TERMINAL.includes(from)) {
        throw new Conflict(
          `Cannot move order #${o.order_no} from ${from} to ${target}. `
          + `Allowed: ${allowed.join(', ') || '(terminal)'}.`,
        );
      }
      logger.info(
        `[fulfilment] forced ${from} → ${target} for order ${orderId} (aggregator authority)`,
      );
    }

    const sets = ['fulfilment_state = $1'];
    const vals = [target];
    const push = (frag, val) => { vals.push(val); sets.push(`${frag} = $${vals.length}`); };

    if (TIMESTAMP_COLUMN[target]) sets.push(`${TIMESTAMP_COLUMN[target]} = NOW()`);

    if (target === 'accepted') {
      const mins = Number(opts.prepMinutes);
      if (!Number.isFinite(mins) || mins <= 0 || mins > 240) {
        throw new BadRequest('prepMinutes (1-240) is required when accepting an order');
      }
      push('prep_minutes', Math.round(mins));
    }

    if (target === 'rejected') {
      if (!opts.reason || !String(opts.reason).trim()) {
        throw new BadRequest('A reason is required when rejecting an order');
      }
      push('reject_reason', String(opts.reason).trim().slice(0, 500));
    }

    if (target === 'rider_assigned') {
      if (opts.rider?.name) push('rider_name', String(opts.rider.name).slice(0, 120));
      if (opts.rider?.phone) push('rider_phone', String(opts.rider.phone).slice(0, 20));
      // Aggregator-supplied OTP wins; for own-fleet we mint one so the
      // handover is still verified.
      const otp = opts.rider?.otp || o.rider_otp_expected || _digits(4);
      push('rider_otp_expected', String(otp).slice(0, 8));
    }

    if (target === 'picked_up') {
      if (o.rider_otp_expected) {
        const typed = String(opts.otp || '').trim();
        if (!typed) throw new BadRequest('The delivery partner\'s OTP is required to hand over this order');
        if (typed !== String(o.rider_otp_expected)) throw new BadRequest('Incorrect OTP — check with the delivery partner');
        sets.push('rider_otp_verified_at = NOW()');
      }
    }

    // Narrow, deliberate mirroring into the money state machine (see header).
    // food_ready → 'ready' so KDS/reports agree the kitchen is done;
    // delivered → 'collected' so revenue is recognised exactly once.
    let posStatus = null;
    if (target === 'food_ready' && o.status === 'pending') posStatus = 'ready';
    if (target === 'delivered' && o.status !== 'collected' && o.status !== 'cancelled') posStatus = 'collected';

    vals.push(businessId, orderId);
    const upd = await client.query(
      `UPDATE orders SET ${sets.join(', ')}, updated_at = NOW()
        WHERE business_id = $${vals.length - 1} AND id = $${vals.length}
        RETURNING *`,
      vals,
    );
    const row = upd.rows[0];

    if (OUTBOUND_FOR[target]) {
      await _enqueueOutbound(client, {
        businessId,
        orderId,
        provider: o.channel || o.source || 'own',
        event: OUTBOUND_FOR[target],
        payload: {
          orderNo: o.order_no,
          aggregatorOrderId: o.aggregator_order_id,
          prepMinutes: row.prep_minutes,
          reason: row.reject_reason,
        },
      });
    }

    return { ..._serialize(row), posStatusApplied: posStatus };
  }).then(async (out) => {
    // Mirror into orders.status AFTER the fulfilment txn commits, reusing
    // orderService.updateStatus so loyalty/revenue side effects run exactly
    // as they do for a counter order — never duplicated here.
    if (out.posStatusApplied) {
      const ok = await _mirrorPosStatus(businessId, orderId, out.posStatusApplied);
      out.posStatusMirrored = ok;
    }
    return out;
  });
}

/**
 * Apply the POS-status mirror. Returns true on success.
 *
 * This carries MONEY: `delivered` → `collected` is what recognises revenue and
 * awards loyalty. The mirror runs after the fulfilment transaction commits (so
 * orderService owns its own side effects exactly once), which means it can
 * fail on its own — a pool blip, or a human cancelling in the POS between the
 * two steps. A silent warn would leave the order delivered with the money
 * never booked, so a failure is recorded on the order and swept by
 * `repairPosMirrors` (cron) and reported by the revenue-integrity email.
 */
async function _mirrorPosStatus(businessId, orderId, posStatus) {
  try {
    await require('./orderService').updateStatus(businessId, orderId, posStatus);
    await query(
      'UPDATE orders SET pos_mirror_error = NULL WHERE business_id = $1 AND id = $2',
      [businessId, orderId],
    ).catch(() => {});
    return true;
  } catch (e) {
    logger.warn(
      `[fulfilment] POS mirror → ${posStatus} FAILED for ${orderId}: ${e.message} (queued for repair)`,
    );
    await query(
      'UPDATE orders SET pos_mirror_error = $1 WHERE business_id = $2 AND id = $3',
      [String(e.message).slice(0, 300), businessId, orderId],
    ).catch(() => {});
    return false;
  }
}

/**
 * Sweep orders whose fulfilment says delivered but whose POS status never
 * caught up, and retry the mirror. Cheap: the set is normally empty, and it is
 * bounded by the partial index added in migration 080.
 */
async function repairPosMirrors({ limit = 50 } = {}) {
  const stuck = await query(
    `SELECT id, business_id FROM orders
      WHERE fulfilment_state = 'delivered'
        AND status NOT IN ('collected', 'cancelled')
      ORDER BY delivered_at ASC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  let repaired = 0; let stillStuck = 0;
  for (const row of stuck.rows) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await _mirrorPosStatus(row.business_id, row.id, 'collected');
    if (ok) repaired += 1; else stillStuck += 1;
  }
  if (repaired || stillStuck) {
    logger.info(`[fulfilment] POS mirror repair: repaired=${repaired} stillStuck=${stillStuck}`);
  }
  return { repaired, stillStuck, considered: stuck.rowCount };
}

function _serialize(row, extra = {}) {
  return {
    id: row.id,
    orderNo: row.order_no,
    state: row.fulfilment_state,
    posStatus: row.status,
    prepMinutes: row.prep_minutes ?? null,
    rejectReason: row.reject_reason ?? null,
    rider: row.rider_name || row.rider_phone
      ? { name: row.rider_name, phone: row.rider_phone }
      : null,
    otpRequired: !!row.rider_otp_expected,
    otpVerified: !!row.rider_otp_verified_at,
    nextStates: TRANSITIONS[row.fulfilment_state] || [],
    ...extra,
  };
}

/**
 * Drain queued outbound events. Called from the cron worker.
 *
 * Real provider calls live in aggregatorOutboundAdapter; until partner
 * credentials exist it returns { skipped: true } and we mark the event
 * `skipped` rather than retrying forever against endpoints we can't reach.
 */
async function drainOutbound({ limit = 50 } = {}) {
  const due = await query(
    `SELECT * FROM aggregator_outbound_events
      WHERE status = 'queued' AND next_attempt_at <= NOW()
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  let sent = 0; let skipped = 0; let failed = 0;
  for (const ev of due.rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await require('./aggregatorOutboundAdapter').push(ev);
      if (out.skipped) {
        skipped += 1;
        // eslint-disable-next-line no-await-in-loop
        await query(
          `UPDATE aggregator_outbound_events
              SET status = 'skipped', last_error = $1, attempts = attempts + 1
            WHERE id = $2`,
          [out.reason || 'provider not configured', ev.id],
        );
      } else {
        sent += 1;
        // eslint-disable-next-line no-await-in-loop
        await query(
          `UPDATE aggregator_outbound_events
              SET status = 'sent', sent_at = NOW(), attempts = attempts + 1
            WHERE id = $1`,
          [ev.id],
        );
      }
    } catch (e) {
      failed += 1;
      const attempts = ev.attempts + 1;
      const dead = attempts >= 6;
      // eslint-disable-next-line no-await-in-loop
      await query(
        `UPDATE aggregator_outbound_events
            SET status = $1, attempts = $2, last_error = $3,
                next_attempt_at = NOW() + ($4 || ' seconds')::interval
          WHERE id = $5`,
        [dead ? 'failed' : 'queued', attempts, String(e.message).slice(0, 500),
          String(Math.min(3600, 30 * (2 ** attempts))), ev.id],
      );
      if (dead) {
        logger.warn(`[fulfilment] outbound ${ev.event} for order ${ev.order_id} dead-lettered: ${e.message}`);
      }
    }
  }
  if (sent || failed) {
    logger.info(`[fulfilment] outbound drain sent=${sent} skipped=${skipped} failed=${failed}`);
  }
  return { sent, skipped, failed, considered: due.rowCount };
}

/** Re-queue `skipped` callbacks once partner outbound is finally enabled. */
async function requeueSkippedOutbound({ olderThanMinutes = 0 } = {}) {
  if (require('../config/env').AGGREGATOR_OUTBOUND_ENABLED !== 'true') {
    return { requeued: 0, reason: 'outbound still disabled' };
  }
  const r = await query(
    `UPDATE aggregator_outbound_events
        SET status = 'queued', next_attempt_at = NOW(), attempts = 0, last_error = NULL
      WHERE status = 'skipped'
        AND created_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(olderThanMinutes)],
  );
  if (r.rowCount > 0) logger.info(`[fulfilment] re-queued ${r.rowCount} skipped callback(s)`);
  return { requeued: r.rowCount };
}

module.exports = {
  STATES,
  TRANSITIONS,
  board,
  transition,
  drainOutbound,
  repairPosMirrors,
  requeueSkippedOutbound,
};
