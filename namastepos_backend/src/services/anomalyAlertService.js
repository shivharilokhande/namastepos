// NamastePOS — Anomaly alerts to the owner's WhatsApp (FF-248).
//
// Runs every 15 minutes via cronWorker and looks for events an owner
// would want to know about immediately, even when they're not at the
// dashboard. Sends one WhatsApp per anomaly, dedupes via
// `anomaly_alerts` so a single spike doesn't spam the owner.
//
// Three anomaly types shipped in MVP:
//   1. VOID_SPIKE   — > 5 cancellations after KOT-print in one hour
//   2. AFTER_HOURS  — an order placed 12am-5am local time
//   3. LOW_STOCK    — an item hit stock <= 0 (not just reorder level)
//
// The dedupe key is (business_id + type + hourly_bucket) so we alert
// at most once per hour per anomaly type per business.

const { query } = require('../config/db');
const logger = require('../config/logger');

async function scan() {
  // Grab all businesses with an owner phone we could actually message.
  const bizs = await query(
    `SELECT b.id, b.name, u.phone AS owner_phone
       FROM businesses b
  LEFT JOIN business_users bu ON bu.business_id = b.id AND bu.role = 'business_owner'
  LEFT JOIN users u ON u.id = bu.user_id
      WHERE b.deleted_at IS NULL AND u.phone IS NOT NULL`,
  );

  for (const biz of bizs.rows) {
    try {
      await checkVoidSpike(biz);
      await checkAfterHours(biz);
      await checkStockOut(biz);
    } catch (e) {
      logger.warn(`[anomaly] scan for ${biz.id} failed: ${e.message}`);
    }
  }
}

async function checkVoidSpike(biz) {
  const r = await query(
    `SELECT COUNT(*)::int AS n
       FROM orders
      WHERE business_id = $1
        AND status = 'cancelled'
        AND printed = TRUE
        AND updated_at > NOW() - INTERVAL '1 hour'`,
    [biz.id],
  );
  const { n } = r.rows[0];
  if (n < 5) return;
  await maybeAlert(
    biz,
    'VOID_SPIKE',
    `⚠️ NamastePOS alert for ${biz.name}: ${n} cancellations in the last hour after KOT print. Check Revenue Leakage on the dashboard.`,
  );
}

async function checkAfterHours(biz) {
  // Simple version: any order between 12:00 and 05:00 IST. Skip if
  // the business self-identifies as a late-night joint (would need a
  // flag on businesses — leave for a future ticket).
  const r = await query(
    `SELECT COUNT(*)::int AS n, MAX(order_no) AS latest
       FROM orders
      WHERE business_id = $1
        AND created_at > NOW() - INTERVAL '15 minutes'
        AND EXTRACT(hour FROM created_at AT TIME ZONE 'Asia/Kolkata') BETWEEN 0 AND 4`,
    [biz.id],
  );
  const { n } = r.rows[0];
  if (n === 0) return;
  await maybeAlert(
    biz,
    'AFTER_HOURS',
    `⚠️ NamastePOS alert for ${biz.name}: order #${r.rows[0].latest} was placed after midnight. If this wasn't you, review who has staff PIN access.`,
  );
}

async function checkStockOut(biz) {
  const r = await query(
    // Bug fix (B6): menu_items has no `deleted_at` column;
    // `is_active` is the soft-delete flag we already check.
    // NP-205 (2026-09-04): `AND track_stock = TRUE`. Without it this alert
    // fired on every item whose stock nobody had ever entered — the whole
    // menu of a restaurant that doesn't do dish-level inventory sits at 0 —
    // so the owner got a nightly WhatsApp naming five perfectly available
    // dishes and learned to ignore the channel. Zero only means "out" when
    // the owner said they were counting (migration 084).
    `SELECT name FROM menu_items
      WHERE business_id = $1
        AND track_stock = TRUE
        AND stock <= 0
        AND is_active = TRUE
        AND (sold_out_until IS NULL OR sold_out_until <= NOW())
      LIMIT 5`,
    [biz.id],
  );
  if (r.rowCount === 0) return;
  const names = r.rows.map((x) => x.name).join(', ');
  await maybeAlert(
    biz,
    'STOCK_OUT',
    `📦 NamastePOS alert for ${biz.name}: ${names} at zero stock but still marked active. Mark sold-out or restock from the Menu screen.`,
  );
}

async function maybeAlert(biz, kind, message) {
  // Dedupe: one message per (biz, kind, hour).
  const r = await query(
    `INSERT INTO anomaly_alerts (business_id, kind, bucket_hour)
     VALUES ($1, $2, DATE_TRUNC('hour', NOW()))
     ON CONFLICT (business_id, kind, bucket_hour) DO NOTHING
     RETURNING id`,
    [biz.id, kind],
  ).catch((e) => {
    // Bug fix (B23): don't fully swallow — log so a real DB error
    // (bad column, disk full, unique index rebuild) surfaces in the
    // terminal instead of silently killing every alert forever.
    // A missing anomaly_alerts table just means migration 045 hasn't
    // run yet; that's the expected quiet path.
    if (!/does not exist/i.test(e.message || '')) {
      logger.warn(`[anomaly] alert insert failed ${biz.id} ${kind}: ${e.message}`);
    }
    return { rowCount: 0 };
  });

  if (r.rowCount === 0) return; // already alerted this hour

  try {
    const wa = require('./whatsappService');
    await wa.sendRaw({ to: biz.owner_phone, body: message });
  } catch (e) {
    logger.warn(`[anomaly] WA send failed for ${biz.id} ${kind}: ${e.message}`);
  }
}

// Called from cronWorker — soft-schedule every 15 minutes.
async function tick() {
  try { await scan(); } catch (e) { logger.error(`[anomaly] tick error: ${e.message}`); }
}

module.exports = { tick, scan };
