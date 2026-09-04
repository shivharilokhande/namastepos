// NamastePOS — Owner digests (FF-326 daily WhatsApp + FF-336 weekly email).
//
// Daily digest fires at 9am local (best-effort — we run every hour and
// send when it's currently 9-10am IST for the business owner's phone).
// Weekly digest fires every Monday 9am and emails the last 7 days.
// Both are dedupe'd via `weekly_digest_log` / `email_dispatch_log`.

const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const wa = require('./whatsappService');
const email = require('./emailService');

// Format ₹ ergonomically for owner-facing messages.
const rupee = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

async function _dayStats(businessId, dayOffset) {
  // dayOffset = 0 for today, -1 for yesterday, -7 for a week ago, etc.
  const r = await query(
    `SELECT COUNT(*)::int                        AS orders,
            COALESCE(SUM(total), 0)::float       AS revenue,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0)::int AS cancels,
            (SELECT name FROM (
               SELECT oi.name, SUM(oi.qty) AS q
                 FROM order_items oi
                 JOIN orders o2 ON o2.id = oi.order_id
                WHERE o2.business_id = $1
                  AND o2.created_at::date = (NOW()::date + $2::int)
                  AND o2.status <> 'cancelled'
                GROUP BY oi.name ORDER BY q DESC LIMIT 1
            ) t)                                 AS top_item
       FROM orders
      WHERE business_id = $1
        AND created_at::date = (NOW()::date + $2::int)`,
    [businessId, dayOffset],
  );
  return r.rows[0];
}

/** Daily — WhatsApp to the owner phone at ~9am local. */
async function dailyTick() {
  // Every hour we scan for businesses whose owner phone's IST hour is
  // currently 9. This is a light approximation; full timezone support
  // would attach a tz per business.
  const now = new Date();
  const istHour = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60 * 1000).getUTCHours();
  if (istHour !== 9) return { skipped: true };

  const bizs = await query(
    `SELECT b.id, b.name, u.phone AS owner_phone
       FROM businesses b
       JOIN business_users bu ON bu.business_id = b.id AND bu.role = 'business_owner'
       JOIN users u ON u.id = bu.user_id
      WHERE b.deleted_at IS NULL AND u.phone IS NOT NULL`,
  );
  for (const biz of bizs.rows) {
    try {
      const s = await _dayStats(biz.id, -1);
      if (!s || s.orders === 0) continue;
      const body = `Good morning ${biz.name} 👋\n\n`
        + `Yesterday: ${s.orders} orders · ${rupee(s.revenue)}\n${
          s.top_item ? `Top item: ${s.top_item}\n` : ''
        }${s.cancels > 0 ? `Cancellations: ${s.cancels}\n` : ''
        }\nOpen NamastePOS → Overview for the full report.`;
      await wa.sendRaw({ to: biz.owner_phone, body });
    } catch (e) {
      logger.warn(`[digest daily] failed for ${biz.id}: ${e.message}`);
    }
  }
}

/** Weekly — email every Monday morning. */
async function weeklyTick() {
  const now = new Date();
  if (now.getUTCDay() !== 1) return { skipped: 'not-monday' }; // 1 = Monday UTC (good enough for IST)
  const istHour = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60 * 1000).getUTCHours();
  if (istHour !== 9) return { skipped: 'not-9am' };

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  const bizs = await query(
    `SELECT b.id, b.name, b.email AS biz_email, u.display_name AS owner_name
       FROM businesses b
       JOIN business_users bu ON bu.business_id = b.id AND bu.role = 'business_owner'
       JOIN users u ON u.id = bu.user_id
  LEFT JOIN weekly_digest_log w ON w.business_id = b.id AND w.week_start = $1::date
      WHERE b.deleted_at IS NULL
        AND b.email IS NOT NULL
        AND w.business_id IS NULL`,
    [weekStartStr],
  );

  for (const biz of bizs.rows) {
    try {
      const totals = await query(
        `SELECT COUNT(*)::int AS orders,
                COALESCE(SUM(total), 0)::float AS revenue,
                COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END), 0)::int AS cancels
           FROM orders
          WHERE business_id = $1
            AND created_at::date > NOW()::date - INTERVAL '7 days'`,
        [biz.id],
      );
      const s = totals.rows[0];
      if (s.orders === 0) continue;
      const html = `
<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <h1 style="color:#FF6B35;margin:0 0 12px">Your week at ${biz.name}</h1>
  <p>Hi ${biz.owner_name || 'there'}, here's the recap for the past 7 days.</p>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px;border-bottom:1px solid #eee">Orders</td><td style="text-align:right"><strong>${s.orders}</strong></td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee">Revenue</td><td style="text-align:right"><strong>${rupee(s.revenue)}</strong></td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee">Cancellations</td><td style="text-align:right">${s.cancels}</td></tr>
  </table>
  <p style="margin-top:20px"><a href="${env.APP_URL || 'https://app.namastepos.in'}" style="background:#FF6B35;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Open the full report</a></p>
</body></html>`.trim();
      await email.sendMail({
        template: 'weekly_digest',
        recipient: biz.biz_email,
        subject: `${biz.name} — last week: ${rupee(s.revenue)}`,
        html,
        text: `Hi ${biz.owner_name || 'there'}, last week at ${biz.name}: ${s.orders} orders totalling ${rupee(s.revenue)}.`,
        businessId: biz.id,
      });
      await query(
        `INSERT INTO weekly_digest_log (business_id, week_start)
         VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
        [biz.id, weekStartStr],
      );
    } catch (e) {
      logger.warn(`[digest weekly] failed for ${biz.id}: ${e.message}`);
    }
  }
}

module.exports = { dailyTick, weeklyTick };
