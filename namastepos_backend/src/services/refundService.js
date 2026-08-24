// NamastePOS backend - refunds (Razorpay-backed)

const https = require('https');
const env = require('../config/env');
const { query, withTransaction } = require('../config/db');
const logger = require('../config/logger');
const { NotFound, BadRequest } = require('../utils/errors');

function rzCall(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      return reject(new BadRequest('Razorpay not configured'));
    }
    const data = body ? JSON.stringify(body) : null;
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com',
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const json = chunks ? JSON.parse(chunks) : {};
          if (res.statusCode >= 300) return reject(new Error(json.error?.description || 'Razorpay error'));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function serialize(r) {
  return {
    id: r.id,
    businessId: r.business_id,
    paymentId: r.payment_id,
    invoiceId: r.invoice_id,
    amount: r.amount_paise / 100,
    amountPaise: r.amount_paise,
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    razorpayRefundId: r.razorpay_refund_id,
    initiatedBy: r.initiated_by,
    createdAt: r.created_at,
    processedAt: r.processed_at,
  };
}

async function list({ businessId, status, limit = 100 } = {}) {
  const where = ['1=1']; const values = []; let idx = 1;
  if (businessId) { where.push(`r.business_id = $${idx++}`); values.push(businessId); }
  if (status) { where.push(`r.status = $${idx++}`); values.push(status); }
  values.push(limit);
  const r = await query(
    `SELECT r.*, b.name AS business_name, au.email AS admin_email
       FROM refunds r
  LEFT JOIN businesses b ON b.id = r.business_id
  LEFT JOIN admin_users au ON au.id = r.initiated_by
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC LIMIT $${idx++}`,
    values,
  );
  return r.rows.map((row) => ({
    ...serialize(row),
    businessName: row.business_name,
    adminEmail: row.admin_email,
  }));
}

async function initiate({ paymentId, amountPaise, reason, adminId }) {
  // Fetch payment
  const pay = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (pay.rowCount === 0) throw new NotFound('Payment not found');
  const p = pay.rows[0];
  if (!p.razorpay_payment_id) throw new BadRequest('Cannot refund a non-Razorpay payment');

  const refundAmount = amountPaise || p.amount_paise;
  if (refundAmount > p.amount_paise) {
    throw new BadRequest('Refund amount exceeds payment amount');
  }

  // Create our row first (status pending)
  const ins = await query(
    `INSERT INTO refunds (business_id, payment_id, invoice_id, amount_paise,
                          reason, initiated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [p.business_id, paymentId, p.invoice_id, refundAmount, reason, adminId],
  );
  const ourRefund = ins.rows[0];

  // Call Razorpay
  try {
    const rz = await rzCall('POST', `/v1/payments/${p.razorpay_payment_id}/refund`, {
      amount: refundAmount, notes: { reason: reason || '' },
    });
    await query(
      `UPDATE refunds
          SET razorpay_refund_id = $1, status = 'processed',
              processed_at = NOW(), raw_payload = $2
        WHERE id = $3`,
      [rz.id, rz, ourRefund.id],
    );
    return serialize({ ...ourRefund, status: 'processed', razorpay_refund_id: rz.id });
  } catch (err) {
    await query(
      'UPDATE refunds SET status = \'failed\', raw_payload = $1 WHERE id = $2',
      [{ error: err.message }, ourRefund.id],
    );
    logger.error(`Refund failed: ${err.message}`);
    throw new BadRequest(`Razorpay refund failed: ${err.message}`);
  }
}

/**
 * FF-304 — Owner-side refund from within an order.
 *
 * Two modes:
 *   1. Line-item refund: pass `itemIds:[]` and we sum those items'
 *      totals to compute the refund amount.
 *   2. Custom-amount refund: pass `amountInr` for anything else.
 *
 * Falls through to `initiate()` once we've resolved payment + amount.
 * Callers are already gated by requireBusinessOwnership; we double-
 * check `payment.business_id` matches to be safe.
 */
async function refundOrder({
  businessId, orderId, itemIds = [], items = [], amountInr, reason, ownerId,
}) {
  // Bug fix (B4): customer orders don't route through the platform
  // `payments` table (that table is for SaaS subscription charges).
  // Migration 051 added `refunds.order_id` so we log the refund row
  // directly against the order, without a payment intermediary.

  // P1 fix (2026-08-22): the whole read-then-insert runs inside one
  // transaction with the order row locked (FOR UPDATE), so two
  // concurrent refund requests can't both read the same prior sum and
  // jointly exceed the order total.
  return withTransaction(async (client) => {
  // 1. Verify the order belongs to this tenant (tenant scoping) and
  //    that it's in a state where refunding makes sense.
  const orderQ = await client.query(
    `SELECT id, order_no, total, status, payment_method, table_session_id,
            customer_id, points_earned
       FROM orders
      WHERE id = $1 AND business_id = $2 LIMIT 1
      FOR UPDATE`,
    [orderId, businessId],
  );
  if (orderQ.rowCount === 0) throw new NotFound('Order not found');
  const order = orderQ.rows[0];
  if (order.status === 'cancelled') {
    throw new BadRequest('Cannot refund a cancelled order — the total was never captured');
  }

  // 2. Compute refund amount in paise.
  // Fix (2026-08-22): the mobile app shows multi-KOT table sessions as
  // one "bill" whose id is the FIRST KOT's order id. Item refunds picked
  // from a later KOT used to sum to zero (WHERE order_id = first KOT).
  // Accept items from ANY order in the same session (tenant-scoped).
  let amountPaise;
  let cogsPaise = 0; // making-cost of refunded prepared food (2026-08-23)
  if (Array.isArray(items) && items.length > 0) {
    // Partial-qty item refund: [{id, qty}] — value each line at its
    // ordered unit price, qty capped at the ordered qty. Also derive the
    // making cost from menu_items.cost_price for the expense mirror.
    const ids = items.map((it) => it.id);
    const r = await client.query(
      `SELECT oi.id, oi.qty, oi.price, oi.menu_item_id,
              COALESCE(mi.cost_price, 0)::float AS cost_price
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE oi.id = ANY($2::uuid[])
          AND o.business_id = $3
          AND (oi.order_id = $1
               OR ($4::uuid IS NOT NULL AND o.table_session_id = $4::uuid))`,
      [orderId, ids, businessId, order.table_session_id || null],
    );
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    // H3 fix (2026-08-23): cap each line at ordered − ALREADY refunded
    // qty (from prior refunds' raw_payload), so "1 of 2 chai" can't be
    // refunded three times.
    const priorItems = await client.query(
      `SELECT elem->>'id' AS item_id,
              COALESCE(SUM((elem->>'qty')::numeric), 0) AS qty
         FROM refunds r,
              jsonb_array_elements(r.raw_payload->'items') elem
        WHERE r.business_id = $1
          AND r.status IN ('pending', 'processed')
          AND elem->>'id' = ANY($2::text[])
        GROUP BY 1`,
      [businessId, ids],
    );
    const refundedQty = new Map(
      priorItems.rows.map((row) => [row.item_id, parseFloat(row.qty)]),
    );
    let sumInr = 0;
    let costInr = 0;
    const cappedItems = [];
    for (const it of items) {
      const row = byId.get(it.id);
      if (!row) continue;
      const remainingQty = Math.max(
        0, parseFloat(row.qty) - (refundedQty.get(it.id) || 0),
      );
      const qty = Math.min(Number(it.qty) || 0, remainingQty);
      if (qty <= 0) continue;
      sumInr += qty * parseFloat(row.price);
      costInr += qty * (parseFloat(row.cost_price) || 0);
      cappedItems.push({ id: it.id, qty });
    }
    // Persist the CAPPED quantities so future caps stay accurate.
    items = cappedItems;
    amountPaise = Math.round(sumInr * 100);
    cogsPaise = Math.round(costInr * 100);
    if (amountPaise <= 0) {
      throw new BadRequest('Selected items add up to zero — nothing to refund');
    }
  } else if (Array.isArray(itemIds) && itemIds.length > 0) {
    const r = await client.query(
      `SELECT COALESCE(SUM(oi.qty * oi.price), 0)::float AS total_inr
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = ANY($2::uuid[])
          AND o.business_id = $3
          AND (oi.order_id = $1
               OR ($4::uuid IS NOT NULL AND o.table_session_id = $4::uuid))`,
      [orderId, itemIds, businessId, order.table_session_id || null],
    );
    amountPaise = Math.round(parseFloat(r.rows[0].total_inr) * 100);
    if (amountPaise <= 0) {
      throw new BadRequest('Selected items add up to zero — nothing to refund');
    }
  } else if (typeof amountInr === 'number' && amountInr > 0) {
    amountPaise = Math.round(amountInr * 100);
  } else {
    throw new BadRequest('Provide either itemIds[] or amountInr > 0');
  }

  // For session bills, cap against the WHOLE bill (all non-cancelled
  // KOTs in the session), and count prior refunds across the session.
  let orderTotalPaise = Math.round(parseFloat(order.total) * 100);
  if (order.table_session_id) {
    const billQ = await client.query(
      `SELECT COALESCE(SUM(total), 0)::float AS bill_total
         FROM orders
        WHERE business_id = $1 AND table_session_id = $2
          AND status <> 'cancelled'`,
      [businessId, order.table_session_id],
    );
    const billPaise = Math.round(parseFloat(billQ.rows[0].bill_total) * 100);
    if (billPaise > orderTotalPaise) orderTotalPaise = billPaise;
  }
  // P1 fix (2026-08-22): cap only checked against orderTotal in
  // isolation — same order could be refunded again and again past
  // total. Sum all prior refunds on this order and reject if the new
  // one would push the sum above total.
  // P0 fix (2026-08-22): 'succeeded' is not a value of the
  // refund_status enum ('pending','processed','failed','cancelled') —
  // including it made Postgres reject the query on every refund.
  // H2 fix (2026-08-23): when the cap was raised to the whole session
  // total, prior refunds still only counted the head order — refunding
  // against two different KOT ids in one session could reach ~2× the
  // bill. Sum prior refunds across ALL orders in the session.
  const priorQ = order.table_session_id
    ? await client.query(
      `SELECT COALESCE(SUM(r.amount_paise), 0)::bigint AS prior_paise
         FROM refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE r.business_id = $1
          AND o.table_session_id = $2
          AND r.status IN ('pending', 'processed')`,
      [businessId, order.table_session_id],
    )
    : await client.query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS prior_paise
         FROM refunds
        WHERE business_id = $1 AND order_id = $2
          AND status IN ('pending', 'processed')`,
      [businessId, orderId],
    );
  const priorPaise = Number(priorQ.rows[0]?.prior_paise || 0);
  if (priorPaise + amountPaise > orderTotalPaise) {
    const remaining = Math.max(0, orderTotalPaise - priorPaise) / 100;
    throw new BadRequest(
      `Refund would exceed order total. ₹${remaining.toFixed(2)} remaining to refund.`,
    );
  }
  if (amountPaise > orderTotalPaise) {
    throw new BadRequest('Refund amount exceeds order total');
  }

  // 3. Insert directly into refunds with order_id set.
  // P1 fix (2026-08-22): was inserted as status='pending' with no
  // worker to complete it — refunds sat forever, owners had no
  // recourse. For the cash-book path (payment_method='cash'|'upi',
  // no Razorpay involvement) we mark 'processed' immediately since
  // there's nothing to reconcile with an external gateway. For
  // gateway-backed methods ('online'|'card') we keep 'pending' but
  // TODO: enqueue Razorpay refund call. Owners can see the status
  // via GET /admin/refunds.
  const isCashBook = ['cash', 'upi'].includes(order.payment_method);
  const finalStatus = isCashBook ? 'processed' : 'pending';
  const refundRow = await client.query(
    `INSERT INTO refunds
       (business_id, order_id, amount_paise, currency, reason, status, raw_payload)
     VALUES ($1, $2, $3, 'INR', $4, $5, $6::jsonb)
     RETURNING *`,
    [
      businessId, orderId, amountPaise,
      reason || null,
      finalStatus,
      JSON.stringify({
        source: 'owner-order-refund',
        ownerUserId: ownerId || null,
        orderNo: order.order_no,
        paymentMethod: order.payment_method,
        itemIds: itemIds.length > 0 ? itemIds : undefined,
        items: (items && items.length > 0) ? items : undefined,
        cogsPaise: cogsPaise || undefined,
      }),
    ],
  );
  // Loyalty clawback (2026-08-23, founder): points earned on this order
  // shrink proportionally with the refund. ₹200 refunded on a ₹400 order
  // that earned 40 pts → 20 pts reversed. Done inside the txn so the
  // customer balance and the refund commit together.
  let _pointsReversed = 0;
  if (order.customer_id && (order.points_earned || 0) > 0
      && orderTotalPaise > 0) {
    const reversal = Math.min(
      order.points_earned,
      Math.round(order.points_earned * (amountPaise / orderTotalPaise)),
    );
    if (reversal > 0) {
      const bal = await client.query(
        `UPDATE customers
            SET points_balance  = GREATEST(0, points_balance - $1),
                lifetime_points = GREATEST(0, lifetime_points - $1)
          WHERE id = $2 AND business_id = $3
          RETURNING points_balance`,
        [reversal, order.customer_id, businessId],
      );
      if (bal.rowCount > 0) {
        await client.query(
          `INSERT INTO loyalty_transactions
             (business_id, customer_id, kind, points, balance_after, order_id, note)
           VALUES ($1, $2, 'reverse', $3, $4, $5, 'Refund clawback')`,
          [businessId, order.customer_id, -reversal,
            bal.rows[0].points_balance, orderId],
        );
        await client.query(
          `UPDATE orders SET points_earned = GREATEST(0, points_earned - $1)
            WHERE id = $2`,
          [reversal, orderId],
        );
        _pointsReversed = reversal;
      }
    }
  }

  return {
    refund: serialize(refundRow.rows[0]),
    _cogsPaise: cogsPaise,
    _pointsReversed,
  };
  }).then(async ({ refund, _cogsPaise, _pointsReversed }) => {
    // 2026-08-23 (founder): when prepared food is refunded, its making
    // cost is a real loss — mirror it into expenses (category
    // 'refund_cogs', added in migration 055) so daily reports and the
    // P&L reflect it. Post-commit + best-effort.
    if (_cogsPaise > 0) {
      try {
        await query(
          `INSERT INTO expenses (business_id, category, amount, description, date)
           VALUES ($1, 'refund_cogs', $2, $3,
                   (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
          [businessId, _cogsPaise / 100,
            `Refund — prepared food cost (order ${orderId})`],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[refund] cogs expense mirror failed: ${e?.message}`);
      }
    }
    return refund;
  });
}

module.exports = { list, initiate, refundOrder, serialize };
