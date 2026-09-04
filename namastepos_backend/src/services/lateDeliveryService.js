// NamastePOS — Late-delivery early warning (FF-334).
//
// Runs every 5 minutes from cronWorker. Finds aggregator orders
// whose `expected_ready_at` is more than 10 minutes past NOW but
// still status = 'pending'. Pings the owner via push + WhatsApp so
// they can nudge the kitchen before the aggregator marks the order
// LATE and refunds the customer (which hits their SLA rating).
//
// Dedupe via `anomaly_alerts` (reuse the same table introduced in
// migration 045) with kind = 'LATE_AGGREGATOR'.

const { query } = require('../config/db');
const logger = require('../config/logger');
const wa = require('./whatsappService');
const push = require('./pushService');

async function scan() {
  const r = await query(
    `SELECT o.id, o.order_no, o.source, o.expected_ready_at, o.customer_phone,
            b.id AS business_id, b.name AS business_name,
            u.phone AS owner_phone
       FROM orders o
       JOIN businesses b ON b.id = o.business_id
  LEFT JOIN business_users bu ON bu.business_id = b.id AND bu.role = 'business_owner'
  LEFT JOIN users u ON u.id = bu.user_id
      WHERE o.status = 'pending'
        AND o.source IN ('zomato', 'swiggy')
        AND o.expected_ready_at IS NOT NULL
        AND o.expected_ready_at < NOW() - INTERVAL '10 minutes'`,
  );
  for (const row of r.rows) {
    try {
      // Dedupe per (biz, order, hour) — a slow order can't spam owner.
      const dedupe = await query(
        `INSERT INTO anomaly_alerts (business_id, kind, bucket_hour)
         VALUES ($1, 'LATE_AGGREGATOR:' || $2, DATE_TRUNC('hour', NOW()))
         ON CONFLICT (business_id, kind, bucket_hour) DO NOTHING
         RETURNING id`,
        [row.business_id, row.id],
      ).catch(() => ({ rowCount: 0 }));
      if (dedupe.rowCount === 0) continue;
      const msg = `⚠️ ${row.business_name}: ${row.source.toUpperCase()} order #${row.order_no} is late. Kitchen should mark ready NOW or you'll take a rating hit.`;
      if (row.owner_phone) {
        await wa.sendRaw({ to: row.owner_phone, body: msg });
      }
      await push.sendToBusinessOwners(row.business_id, {
        title: 'Aggregator order late',
        body: `${row.source} #${row.order_no} — check the kitchen`,
        data: { orderId: row.id, kind: 'LATE_AGGREGATOR' },
      });
    } catch (e) {
      logger.warn(`[late-delivery] alert failed for ${row.id}: ${e.message}`);
    }
  }
  return r.rowCount;
}

module.exports = { scan };
