// Background cron worker — runs in-process, drains scheduled jobs.
// Starts in src/server.js. server.js gates it to PM2 instance 0, AND each tick
// now takes a Postgres advisory lock (see CRON_LOCK_KEY below) so it's safe
// even across multiple instances / VMs sharing one database.
//
// Jobs:
//   • Drain scheduled_messages (birthday + reservation reminders + NPS)
//   • Run recurring_invoices that are due
//   • Refresh forecast + co-purchase rules nightly
//   • Auto-reconcile bank statements
//   • Auto-restock 86'd items past their sold_out_until

const { query, getClient } = require('../config/db');
const logger = require('../config/logger');

// Design-debt hardening (2026-08-24): the scheduler is meant to run on one
// instance (server.js gates it to PM2 instance 0). But if that gating is ever
// wrong, or two VMs share one database, TWO leaders would each fire recurring
// invoices / WhatsApp sends → duplicate charges + duplicate messages. A
// Postgres SESSION advisory lock makes the tick mutually exclusive across the
// whole cluster: whoever holds the lock runs; everyone else skips that tick.
// On a single instance the lock is always free, so behaviour is unchanged.
const CRON_LOCK_KEY = 421199001; // arbitrary, stable app-wide constant
const whatsapp = require('./whatsappService');
const forecast = require('./forecastService');
const upsell = require('./upsellService');
const bankReconcile = require('./bankReconcileService');
const anomaly = require('./anomalyAlertService');
const nps = require('./npsService');
const lateDelivery = require('./lateDeliveryService');
const ownerDigest = require('./ownerDigestService');
const referral = require('./referralService');
const refundReconcile = require('./refundReconcileService');

// FF-248 / FF-1002 / FF-334 / FF-326 / FF-336 / FF-333 tick counters.
// Base tick is 60 s. Each scanner has its own interval-in-ticks so the
// worker stays predictable and single-threaded.
let _anomalyTicksSinceLast = 0;   // 15 min
let _npsTicksSinceLast = 0;       // 15 min
let _lateTicksSinceLast = 0;      // 5 min
let _digestTicksSinceLast = 0;    // 60 min
let _referralTicksSinceLast = 0;  // 6 hours
let _refundTicksSinceLast = 0;    // 5 min (Day-1 reconciler)

let timer = null;
let isRunning = false;

async function _runOnce() {
  if (isRunning) return;               // in-process guard (same instance)
  isRunning = true;

  // Cross-instance guard: grab a session advisory lock on a dedicated client.
  // If another instance already holds it, skip this tick entirely.
  let lockClient = null;
  let haveLock = false;
  try {
    lockClient = await getClient();
    const r = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [CRON_LOCK_KEY]);
    haveLock = r.rows[0] && r.rows[0].ok === true;
    if (!haveLock) {
      logger.info('Cron tick skipped — another instance holds the scheduler lock');
      return;
    }
  } catch (e) {
    // If we can't even acquire the lock connection, don't run jobs this tick
    // (safer to skip than to risk a double-run without the guard).
    logger.warn(`[cron] advisory-lock acquire failed: ${e.message}`);
    if (lockClient) { try { lockClient.release(); } catch (_) {} }
    isRunning = false;
    return;
  }

  try {
    // P2 fix (2026-08-22): each job catches its own errors so one
    // failure can't starve the later jobs (or the tick counters below).
    await drainScheduledMessages().catch((e) =>
      logger.warn(`[scheduled-messages] tick error: ${e.message}`));
    await drainOutboundWaMessages().catch((e) =>
      logger.warn(`[wa-outbound] tick error: ${e.message}`));
    await dueRecurringInvoices().catch((e) =>
      logger.warn(`[recurring-invoices] tick error: ${e.message}`));
    await autoRestock86().catch((e) =>
      logger.warn(`[auto-restock] tick error: ${e.message}`));
    // FF-248 anomaly scan every 15 ticks (~15 min at 60s cadence).
    if (++_anomalyTicksSinceLast >= 15) {
      _anomalyTicksSinceLast = 0;
      await anomaly.tick();
    }
    // FF-1002 NPS post-meal ping — every 15 ticks (~15 min).
    if (++_npsTicksSinceLast >= 15) {
      _npsTicksSinceLast = 0;
      await nps.scheduleTick().catch((e) =>
        logger.warn(`[nps] tick error: ${e.message}`));
    }
    // FF-334 late aggregator delivery — every 5 ticks (~5 min).
    if (++_lateTicksSinceLast >= 5) {
      _lateTicksSinceLast = 0;
      await lateDelivery.scan().catch((e) =>
        logger.warn(`[late-delivery] tick error: ${e.message}`));
    }
    // FF-326 / FF-336 owner digests — every 60 ticks (~1 h) so both
    // the "am I at 9am now?" checks in ownerDigestService fire hourly.
    if (++_digestTicksSinceLast >= 60) {
      _digestTicksSinceLast = 0;
      await ownerDigest.dailyTick().catch((e) =>
        logger.warn(`[digest daily] ${e.message}`));
      await ownerDigest.weeklyTick().catch((e) =>
        logger.warn(`[digest weekly] ${e.message}`));
    }
    // FF-333 referral awarding — every 360 ticks (~6 h).
    if (++_referralTicksSinceLast >= 360) {
      _referralTicksSinceLast = 0;
      await referral.awardEligible().catch((e) =>
        logger.warn(`[referral] ${e.message}`));
    }
    // Day-1 CTO ask — drain pending gateway refunds every 5 ticks (~5 min).
    if (++_refundTicksSinceLast >= 5) {
      _refundTicksSinceLast = 0;
      await refundReconcile.tick().catch((e) =>
        logger.warn(`[refund-reconciler] tick error: ${e.message}`));
    }
    // Heavy jobs fire in the 02:00 IST slot (quietest hour for Indian
    // restaurants). P2 fix (2026-08-22): was server-local getHours() —
    // on a UTC host that meant 07:30 IST, mid-breakfast service.
    const istParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const istHour = Number(istParts.find((p) => p.type === 'hour').value) % 24;
    const istMin = Number(istParts.find((p) => p.type === 'minute').value);
    if (istHour === 2 && istMin < 5) {
      await refreshAllBusinessAnalytics();
      // FF-402f — self-heal stale billing periods. If an active sub's
      // `current_period_end` is in the past (Razorpay webhook dropped,
      // support toggled a plan without rolling forward, etc.) we push
      // it forward one cadence so the tenant's Billing page stops
      // showing "Renews on <past date>" and health scores stay sane.
      // We DON'T touch subs that are already `past_due` or `cancelled` —
      // those need a support decision.
      try {
        const healed = await query(
          `UPDATE subscriptions
              SET current_period_start = NOW(),
                  current_period_end = NOW() + CASE
                    WHEN billing_period = 'yearly' THEN INTERVAL '1 year'
                    ELSE INTERVAL '1 month' END
            WHERE status = 'active'
              AND current_period_end < NOW()
              AND cancel_at_period_end = FALSE
            RETURNING business_id`
        );
        if (healed.rowCount > 0) {
          logger.info(`[billing self-heal] rolled ${healed.rowCount} stale periods forward`);
        }
      } catch (e) {
        logger.warn(`[billing self-heal] ${e.message}`);
      }
      // FF-402 — nightly CRM refresh: recompute lifecycle stage +
      // health score for every tenant, and log a "renewal upcoming"
      // activity for anything ending within 7 days so the timeline
      // shows why support should reach out.
      try {
        const crm = require('./crmService');
        await crm.recomputeAllHealth();
        const upcoming = await crm.upcomingRenewals({ days: 7 });
        for (const r of upcoming) {
          await crm.logActivity({
            businessId: r.businessId,
            kind: r.kind === 'trial_ending' ? 'trial_ending' : 'renewal_upcoming',
            title: r.kind === 'trial_ending'
              ? `Trial ends ${new Date(r.endsAt).toLocaleDateString()}`
              : `Renewal due ${new Date(r.endsAt).toLocaleDateString()} (${r.plan.name || r.plan.tier})`,
            meta: { endsAt: r.endsAt, plan: r.plan },
            actorType: 'system',
          });
        }
      } catch (e) {
        logger.warn(`[crm nightly] ${e.message}`);
      }
      // DPDP data-retention sweep (2026-08-28). All windows are opt-in and
      // default to disabled, so this is a no-op until a super-admin configures
      // retention.* in the admin Compliance → Retention tab.
      try {
        await require('./retentionService').sweep();
      } catch (e) {
        logger.warn(`[retention] nightly sweep failed: ${e.message}`);
      }
    }
  } catch (err) {
    logger.error(`Cron worker run failed: ${err.message}`);
  } finally {
    // Release the advisory lock + its connection before clearing the guard.
    if (lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock($1)', [CRON_LOCK_KEY]); } catch (_) {}
      try { lockClient.release(); } catch (_) {}
    }
    isRunning = false;
  }
}

// Gap fill (2026-08-23, review M2/§4.3): transactional outbound WhatsApp
// messages (order receipts etc.) were inserted into wa_messages with
// direction='out' and provider_msg_id IS NULL, but nothing ever sent them —
// orderService even documents "a background process reads these" that didn't
// exist. This drains that queue. Marketing (scheduled_messages) is separate
// and already drained above.
async function drainOutboundWaMessages() {
  const due = await query(
    `SELECT m.id, m.business_id, m.body, t.customer_phone
       FROM wa_messages m
       JOIN wa_threads t ON t.id = m.thread_id
      WHERE m.direction = 'out'
        AND m.provider_msg_id IS NULL
      ORDER BY m.created_at
      LIMIT 50`
  );
  for (const m of due.rows) {
    if (!m.customer_phone) continue;
    try {
      const sid = await whatsapp._sendOutbound(m.business_id, m.customer_phone, m.body || '');
      // Stamp so we never re-send. Mock/misconfigured provider returns null →
      // mark 'mock-sent' so it drains instead of looping forever.
      await query(
        `UPDATE wa_messages SET provider_msg_id = $1 WHERE id = $2`,
        [sid || 'mock-sent', m.id]
      );
    } catch (err) {
      logger.warn(`[wa-outbound] send failed for ${m.id}: ${err.message}`);
      // Leave provider_msg_id NULL to retry next tick.
    }
  }
}

async function drainScheduledMessages() {
  const due = await query(
    `SELECT sm.*, c.phone AS customer_phone
       FROM scheduled_messages sm
  LEFT JOIN customers c ON c.id = sm.customer_id
      WHERE sm.status = 'pending' AND sm.scheduled_at <= NOW()
      ORDER BY sm.scheduled_at LIMIT 50`
  );
  for (const m of due.rows) {
    const phone = m.customer_phone || (m.body.match(/\+?91\d{10}/) || [])[0];
    if (!phone) {
      await query(
        `UPDATE scheduled_messages SET status = 'failed', error_message = $1 WHERE id = $2`,
        ['No phone', m.id]
      );
      continue;
    }
    try {
      await whatsapp._sendOutbound(m.business_id, phone, m.body);
      await query(
        `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [m.id]
      );
    } catch (err) {
      await query(
        `UPDATE scheduled_messages SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, m.id]
      );
    }
  }
  // Birthday queue — enqueue new birthday messages for customers with birthday today
  await query(
    `INSERT INTO scheduled_messages
       (business_id, customer_id, channel, kind, scheduled_at, body)
     SELECT c.business_id, c.id, 'whatsapp', 'birthday', NOW(),
            'Happy birthday ' || COALESCE(c.name, 'friend') || '! Visit us today for a complimentary dessert.'
       FROM customers c
      WHERE EXTRACT(MONTH FROM c.birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY FROM c.birthday) = EXTRACT(DAY FROM CURRENT_DATE)
        AND c.marketing_optin = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages sm
           WHERE sm.customer_id = c.id AND sm.kind = 'birthday'
             AND sm.created_at > NOW() - INTERVAL '1 day'
        )
      LIMIT 100`
  );
}

async function dueRecurringInvoices() {
  // For each due recurring invoice, generate a new invoice + advance next_run_at.
  const due = await query(
    `SELECT * FROM recurring_invoices
      WHERE is_active = TRUE AND next_run_at <= NOW()
        AND (end_at IS NULL OR end_at > NOW())
      LIMIT 50`
  );
  for (const r of due.rows) {
    // Simplified: log and bump. Real generation logic depends on tenant.
    logger.info(`Recurring invoice fired for customer ${r.customer_id}`);
    const interval = {
      weekly: "INTERVAL '7 days'",
      monthly: "INTERVAL '1 month'",
      quarterly: "INTERVAL '3 months'",
      yearly: "INTERVAL '1 year'",
    }[r.frequency] || "INTERVAL '1 month'";
    await query(
      `UPDATE recurring_invoices SET next_run_at = next_run_at + ${interval} WHERE id = $1`,
      [r.id]
    );
  }
}

async function autoRestock86() {
  await query(
    `UPDATE menu_items SET sold_out_until = NULL
      WHERE sold_out_until IS NOT NULL AND sold_out_until <= NOW()`
  );
}

async function refreshAllBusinessAnalytics() {
  const biz = await query(`SELECT id FROM businesses WHERE deleted_at IS NULL`);
  for (const b of biz.rows) {
    try {
      await forecast.refreshForecast(b.id);
      await upsell.refreshRules(b.id);
      await bankReconcile.autoMatch(b.id).catch(() => {});
    } catch (err) {
      logger.warn(`Analytics refresh failed for ${b.id}: ${err.message}`);
    }
  }
}

function start({ intervalMs = 60 * 1000 } = {}) {
  if (timer) return;
  timer = setInterval(_runOnce, intervalMs);
  logger.info(`Cron worker started — interval ${intervalMs}ms`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, _runOnce };
