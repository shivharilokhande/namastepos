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
const env = require('../config/env'); // NP-121: gates the revenue-integrity sweep

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

// ── Ops visibility (2026-09-03) ─────────────────────────────────────────
// The admin health panel needs "when did each job last run, and did it
// work". There is no cron-run table (and inventing one for a 60s tick would
// be a write amplification we don't want), so we keep the last outcome per
// job in process memory. It resets on deploy — which is exactly the window
// an operator cares about ("is the worker alive on THIS instance?").
const _lastRun = Object.create(null);   // job name → { at, ms, ok, error }
let _lastTickAt = null;
let _lastTickMs = null;
let _startedAt = null;
let _ticks = 0;
let _skippedTicks = 0;

async function _track(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    _lastRun[name] = { at: new Date().toISOString(), ms: Date.now() - t0, ok: true, error: null };
    return out;
  } catch (e) {
    _lastRun[name] = {
      at: new Date().toISOString(), ms: Date.now() - t0, ok: false, error: e.message,
    };
    throw e;   // preserve the existing per-job .catch() logging
  }
}

/** Read-only snapshot for the admin health panel. */
function stats() {
  return {
    running: !!timer,
    startedAt: _startedAt,
    lastTickAt: _lastTickAt,
    lastTickMs: _lastTickMs,
    ticks: _ticks,
    skippedTicks: _skippedTicks,
    jobs: { ..._lastRun },
  };
}

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
      // Bug fix (2026-09-03): this branch used to `return` straight out of
      // _runOnce, leaving `isRunning = true` and the pooled client checked
      // out FOREVER — so a follower instance that lost the advisory lock
      // once never ran another tick (and leaked one pool connection). Only
      // reachable on multi-instance deploys, which is exactly where the
      // advisory lock matters. Release + clear the guard before bailing.
      _skippedTicks += 1;
      logger.info('Cron tick skipped — another instance holds the scheduler lock');
      try { lockClient.release(); } catch (_) {}
      isRunning = false;
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

  const tickStartedAt = Date.now();
  try {
    // P2 fix (2026-08-22): each job catches its own errors so one
    // failure can't starve the later jobs (or the tick counters below).
    await _track('scheduled-messages', () => drainScheduledMessages()).catch((e) =>
      logger.warn(`[scheduled-messages] tick error: ${e.message}`));
    await _track('wa-outbound', () => drainOutboundWaMessages()).catch((e) =>
      logger.warn(`[wa-outbound] tick error: ${e.message}`));
    await _track('recurring-invoices', () => dueRecurringInvoices()).catch((e) =>
      logger.warn(`[recurring-invoices] tick error: ${e.message}`));
    await _track('auto-restock', () => autoRestock86()).catch((e) =>
      logger.warn(`[auto-restock] tick error: ${e.message}`));
    // FF-248 anomaly scan every 15 ticks (~15 min at 60s cadence).
    if (++_anomalyTicksSinceLast >= 15) {
      _anomalyTicksSinceLast = 0;
      await _track('anomaly-scan', () => anomaly.tick()).catch((e) =>
        logger.warn(`[anomaly] tick error: ${e.message}`));
    }
    // FF-1002 NPS post-meal ping — every 15 ticks (~15 min).
    if (++_npsTicksSinceLast >= 15) {
      _npsTicksSinceLast = 0;
      await _track('nps', () => nps.scheduleTick()).catch((e) =>
        logger.warn(`[nps] tick error: ${e.message}`));
    }
    // FF-334 late aggregator delivery — every 5 ticks (~5 min).
    if (++_lateTicksSinceLast >= 5) {
      _lateTicksSinceLast = 0;
      await _track('late-delivery', () => lateDelivery.scan()).catch((e) =>
        logger.warn(`[late-delivery] tick error: ${e.message}`));
    }
    // FF-326 / FF-336 owner digests — every 60 ticks (~1 h) so both
    // the "am I at 9am now?" checks in ownerDigestService fire hourly.
    if (++_digestTicksSinceLast >= 60) {
      _digestTicksSinceLast = 0;
      await _track('digest-daily', () => ownerDigest.dailyTick()).catch((e) =>
        logger.warn(`[digest daily] ${e.message}`));
      await _track('digest-weekly', () => ownerDigest.weeklyTick()).catch((e) =>
        logger.warn(`[digest weekly] ${e.message}`));
    }
    // FF-333 referral awarding — every 360 ticks (~6 h).
    if (++_referralTicksSinceLast >= 360) {
      _referralTicksSinceLast = 0;
      await _track('referral-award', () => referral.awardEligible()).catch((e) =>
        logger.warn(`[referral] ${e.message}`));
    }
    // Day-1 CTO ask — drain pending gateway refunds every 5 ticks (~5 min).
    if (++_refundTicksSinceLast >= 5) {
      _refundTicksSinceLast = 0;
      await _track('refund-reconciler', () => refundReconcile.tick()).catch((e) =>
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
    // Bug fix (2026-08-30): was `istMin < 5`, which — with a 60s tick — fired
    // the heavy block 5×/night (02:00–02:04), duplicating CRM activity rows.
    // Pin to a single minute so it runs exactly once.
    if (istHour === 2 && istMin === 2) {
      await _track('analytics-refresh', () => refreshAllBusinessAnalytics());
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
      // 2026-09-03 (plans/addons audit #4b) — addon expiry reminders: paid
      // add-ons expiring within 3 days (or expired in the last day) push a
      // renewal nudge to the business owners, once per activation
      // (business_addons.notified_expiry_at guard, migration 074).
      try {
        const r = await require('./addonService').notifyExpiringActivations();
        if (r.notified > 0) {
          logger.info(`[addon-expiry] notified ${r.notified} activation(s)`);
        }
      } catch (e) {
        logger.warn(`[addon-expiry] nightly scan failed: ${e.message}`);
      }
      // DPDP data-retention sweep (2026-08-28). All windows are opt-in and
      // default to disabled, so this is a no-op until a super-admin configures
      // retention.* in the admin Compliance → Retention tab.
      try {
        await _track('retention-sweep', () => require('./retentionService').sweep());
      } catch (e) {
        logger.warn(`[retention] nightly sweep failed: ${e.message}`);
      }
      // NP-121 (2026-09-03): revenue-integrity sweep — plan-price drift,
      // refunds stuck pending >48h, webhook deliveries dead in-flight >1h.
      // DEFAULT OFF: runs only when REVENUE_INTEGRITY_CRON=true. Emails
      // PLATFORM_ALERT_EMAIL only when something actually drifted; a
      // missing recipient while enabled is a loud error (service throws).
      if (env.REVENUE_INTEGRITY_CRON) {
        try {
          await _track('revenue-integrity', () => require('./revenueIntegrityService').runDaily());
        } catch (e) {
          logger.error(`[revenue-integrity] nightly sweep failed: ${e.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Cron worker run failed: ${err.message}`);
  } finally {
    _ticks += 1;
    _lastTickAt = new Date().toISOString();
    _lastTickMs = Date.now() - tickStartedAt;
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

// NP-142 (2026-09-03): the nightly analytics refresh used to walk every
// business strictly serially — 3 sequential awaits per tenant meant the tick
// duration grew linearly with tenant count and one slow tenant delayed all
// the rest. Process in small concurrent batches instead. Tuning constants
// (not env — batching size isn't config/secret, same pattern as CRON_LOCK_KEY):
const ANALYTICS_BATCH_SIZE = 5;       // tenants refreshed concurrently
const ANALYTICS_JITTER_MIN_MS = 50;   // per-tenant start jitter so a batch's
const ANALYTICS_JITTER_MAX_MS = 250;  // first queries don't hit the pool at once

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshAllBusinessAnalytics() {
  const startedAt = Date.now();
  const biz = await query(`SELECT id FROM businesses WHERE deleted_at IS NULL`);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < biz.rows.length; i += ANALYTICS_BATCH_SIZE) {
    const batch = biz.rows.slice(i, i + ANALYTICS_BATCH_SIZE);
    // Per-tenant failures are isolated inside the map callback (log +
    // continue), so Promise.all here can never reject the whole batch.
    await Promise.all(batch.map(async (b) => {
      const jitter = ANALYTICS_JITTER_MIN_MS + Math.floor(
        Math.random() * (ANALYTICS_JITTER_MAX_MS - ANALYTICS_JITTER_MIN_MS + 1));
      await _sleep(jitter);
      try {
        await forecast.refreshForecast(b.id);
        await upsell.refreshRules(b.id);
        await bankReconcile.autoMatch(b.id).catch(() => {});
        ok += 1;
      } catch (err) {
        failed += 1;
        logger.warn(`Analytics refresh failed for ${b.id}: ${err.message}`);
      }
    }));
  }
  logger.info(
    `[analytics-refresh] tick done in ${Date.now() - startedAt}ms — `
    + `${biz.rows.length} businesses (${ok} ok, ${failed} failed, `
    + `batch size ${ANALYTICS_BATCH_SIZE})`);
}

function start({ intervalMs = 60 * 1000 } = {}) {
  if (timer) return;
  timer = setInterval(_runOnce, intervalMs);
  _startedAt = new Date().toISOString();
  logger.info(`Cron worker started — interval ${intervalMs}ms`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, stats, _runOnce };
