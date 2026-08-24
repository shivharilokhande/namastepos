// NamastePOS — Post-meal NPS feedback (FF-1002).
//
// Two-part flow:
//   1. Scheduler runs every 15 min via cronWorker. It finds orders
//      that were collected 60-240 minutes ago, whose customer left a
//      phone number, and that we haven't already asked. It sends a
//      short WhatsApp message asking for a 0-10 rating.
//   2. The customer replies with a number. Our WhatsApp webhook
//      pipes short numeric messages here via `handleReply()` which
//      parses + stores the score + returns a thank-you message.
//
// NPS band conventions (Bain classic):
//   9-10 = Promoter  · 7-8 = Passive · 0-6 = Detractor
//   NPS = %Promoters − %Detractors (0-100 friendly scale)

const { query } = require('../config/db');
const logger = require('../config/logger');
const wa = require('./whatsappService');

async function scheduleTick() {
  // Find candidate orders: collected 60-240m ago, has phone, not yet
  // pinged, not the null-customer case. Cap per pass so a big cafe
  // doesn't send 500 pings in one minute.
  const r = await query(
    `SELECT o.id, o.business_id, o.order_no, o.customer_phone,
            b.name AS business_name
       FROM orders o
       JOIN businesses b ON b.id = o.business_id
  LEFT JOIN nps_pings p ON p.order_id = o.id
      WHERE p.order_id IS NULL
        AND o.status = 'collected'
        AND o.customer_phone IS NOT NULL
        AND o.collected_at BETWEEN NOW() - INTERVAL '4 hours'
                              AND NOW() - INTERVAL '1 hour'
      ORDER BY o.collected_at DESC
      LIMIT 100`
  );
  for (const row of r.rows) {
    try {
      const body =
        `Hi from ${row.business_name}! How was your visit? ` +
        `Reply with a number 0-10 (10 = loved it, 0 = never again). ` +
        `Order #${row.order_no}.`;
      await wa.sendRaw({ to: row.customer_phone, body });
      await query(
        `INSERT INTO nps_pings (order_id, business_id) VALUES ($1, $2)
         ON CONFLICT (order_id) DO NOTHING`,
        [row.id, row.business_id]
      );
    } catch (e) {
      logger.warn(`[nps] ping failed for order ${row.id}: ${e.message}`);
    }
  }
  return r.rowCount;
}

/**
 * Called from whatsappService inbound path when a message is just a
 * number. Attempts to attribute it to the most recent unresponded
 * ping for that phone (within 48h). Returns a reply string the
 * conversation state machine can send back.
 */
async function handleReply({ businessId, phone, body }) {
  const score = parseInt(body.trim(), 10);
  if (Number.isNaN(score) || score < 0 || score > 10) return null;

  // Find the most recent order for this phone that was pinged and
  // hasn't been rated yet.
  const orderQ = await query(
    `SELECT o.id, o.order_no
       FROM orders o
       JOIN nps_pings p ON p.order_id = o.id
  LEFT JOIN nps_responses r ON r.order_id = o.id
      WHERE o.business_id = $1
        AND o.customer_phone = $2
        AND r.id IS NULL
        AND p.sent_at > NOW() - INTERVAL '48 hours'
      ORDER BY p.sent_at DESC LIMIT 1`,
    [businessId, phone]
  );
  if (orderQ.rowCount === 0) return null;
  const order = orderQ.rows[0];

  await query(
    `INSERT INTO nps_responses (business_id, order_id, customer_phone, score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id) DO NOTHING`,
    [businessId, order.id, phone, score]
  );

  // Hardcode-audit fix (2026-08-24): the old reply carried a broken,
  // business-less "https://g.page/r/" link. Now builds a real
  // write-review link from the per-business google_place_id (same KV the
  // reviews service uses) and omits the ask entirely when unconfigured.
  if (score >= 9) {
    const placeQ = await query(
      `SELECT value FROM platform_settings
        WHERE business_id = $1 AND key = 'google_place_id' LIMIT 1`,
      [businessId]
    );
    if (placeQ.rowCount > 0 && placeQ.rows[0].value) {
      return `Thank you — that means a lot! Would you leave us a Google review? https://search.google.com/local/writereview?placeid=${placeQ.rows[0].value}`;
    }
    return `Thank you — that means a lot!`;
  }
  if (score >= 7) return `Thanks for the feedback! We'll keep improving.`;
  return `Sorry we didn't hit the mark. What could we do better? Reply here — the owner reads every message.`;
}

/**
 * Weekly summary for the owner dashboard.
 */
async function summary(businessId, days = 30) {
  const r = await query(
    `SELECT score, COUNT(*)::int AS n
       FROM nps_responses
      WHERE business_id = $1
        AND responded_at > NOW() - ($2::text || ' days')::interval
      GROUP BY score
      ORDER BY score`,
    [businessId, String(days)]
  );
  let promoters = 0, passives = 0, detractors = 0, total = 0;
  for (const row of r.rows) {
    const n = row.n;
    total += n;
    if (row.score >= 9) promoters += n;
    else if (row.score >= 7) passives += n;
    else detractors += n;
  }
  const nps = total > 0
    ? Math.round(((promoters - detractors) / total) * 100)
    : null;
  return {
    days, total, promoters, passives, detractors, nps,
    breakdown: r.rows,
  };
}

module.exports = { scheduleTick, handleReply, summary };
