// NamastePOS · CRM service (FF-402).
//
// Powers the admin CRM primitives:
//   • Activity timeline per tenant (one scrollable feed)
//   • Follow-up tasks with owner + due date
//   • Lifecycle stage + health score (auto-computed, nightly refresh)
//   • Renewal / trial-ending alerts (queryable on demand)
//
// Design notes:
//   – Every write is best-effort. If activity logging fails we NEVER
//     block the underlying business action (plan change etc.). CRM is
//     observation, not enforcement.
//   – Health score is a bounded 0-100 int cached on `businesses`.
//     Computation is idempotent so we can re-run any time.
//   – Lifecycle stages are exclusive: trial → active → at_risk → churned.
//     No stage revives on its own — the nightly job promotes/demotes.

const { query } = require('../config/db');

// ── Activity feed ────────────────────────────────────────────────────

async function logActivity({
  businessId, kind, title, body, meta = {},
  actorType = 'system', actorEmail = null,
}) {
  if (!businessId || !kind || !title) return null;
  try {
    const r = await query(
      `INSERT INTO admin_activities
         (business_id, kind, title, body, meta, actor_type, actor_email)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING id`,
      [businessId, kind, title, body || null, JSON.stringify(meta),
       actorType, actorEmail]
    );
    return r.rows[0].id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[crmService] logActivity failed:', e?.message);
    return null;
  }
}

async function listActivities(businessId, { limit = 100, kind = null } = {}) {
  const where = ['business_id = $1']; const values = [businessId]; let idx = 2;
  if (kind) { where.push(`kind = $${idx++}`); values.push(kind); }
  values.push(Math.min(500, +limit || 100));
  const r = await query(
    `SELECT id, kind, title, body, meta, actor_type, actor_email, created_at
       FROM admin_activities
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${idx}`,
    values
  );
  return r.rows.map(serializeActivity);
}

function serializeActivity(a) {
  return {
    id: a.id, kind: a.kind, title: a.title, body: a.body,
    meta: a.meta, actorType: a.actor_type, actorEmail: a.actor_email,
    createdAt: a.created_at,
  };
}

// ── Tasks ────────────────────────────────────────────────────────────

async function listTasks({ businessId = null, ownerEmail = null, openOnly = true } = {}) {
  const where = []; const values = []; let idx = 1;
  if (businessId) { where.push(`business_id = $${idx++}`); values.push(businessId); }
  if (ownerEmail) { where.push(`owner_email = $${idx++}`); values.push(ownerEmail); }
  if (openOnly)   { where.push(`done_at IS NULL`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query(
    `SELECT t.*, b.name AS business_name
       FROM admin_tasks t
  LEFT JOIN businesses b ON b.id = t.business_id
      ${w}
      ORDER BY (t.due_at IS NULL), t.due_at ASC, t.created_at DESC`,
    values
  );
  return r.rows.map(serializeTask);
}

async function createTask({ businessId, title, notes, ownerEmail, dueAt, createdBy }) {
  const r = await query(
    `INSERT INTO admin_tasks (business_id, title, notes, owner_email, due_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [businessId || null, title, notes || null, ownerEmail || null,
     dueAt || null, createdBy || null]
  );
  const task = serializeTask(r.rows[0]);
  // Fan out to the tenant's activity feed so support sees "task created"
  // on the same timeline they read history from.
  if (businessId) {
    await logActivity({
      businessId, kind: 'task_created',
      title: `Task: ${title}`,
      meta: { taskId: task.id, ownerEmail, dueAt },
      actorType: 'admin', actorEmail: createdBy,
    });
  }
  return task;
}

async function completeTask(taskId, actorEmail) {
  const r = await query(
    `UPDATE admin_tasks
        SET done_at = NOW()
      WHERE id = $1 AND done_at IS NULL
      RETURNING *`,
    [taskId]
  );
  if (r.rowCount === 0) return null;
  const t = r.rows[0];
  if (t.business_id) {
    await logActivity({
      businessId: t.business_id, kind: 'task_done',
      title: `Task done: ${t.title}`,
      meta: { taskId: t.id },
      actorType: 'admin', actorEmail,
    });
  }
  return serializeTask(t);
}

function serializeTask(t) {
  return {
    id: t.id, businessId: t.business_id, businessName: t.business_name || null,
    title: t.title, notes: t.notes, ownerEmail: t.owner_email,
    dueAt: t.due_at, doneAt: t.done_at, createdBy: t.created_by,
    createdAt: t.created_at,
  };
}

// ── Health score + lifecycle stage ───────────────────────────────────
//
// Score components (weights sum to 100):
//   – Last order recency:   40 pts (0 days = 40, 30+ days = 0, linear)
//   – Last login recency:   20 pts (0 days = 20, 30+ days = 0, linear)
//   – Unpaid invoices:     -15 pts if any subscription past_due
//   – Aggregator health:   -10 pts if any aggregator is DOWN
//   – Open critical ticket:-15 pts
//   – Onboarded:            15 pts static (0 until wizard done)
//   – Placed 1st order:     10 pts static
//   – Recent anomaly alert:-10 pts (last 24 h)
//
// Baseline before penalties: 40 + 20 + 15 + 10 = 85 for a fully-active,
// onboarded, ordering business. Penalties can push down to 0 (clamped).
//
// Stage assignment:
//   score ≥ 60         → active
//   score 30-59        → at_risk
//   score < 30 + no orders for 30+ days → churned
//   subscription.status = 'trialing'    → trial (overrides score)

async function computeHealth(businessId) {
  const q = await query(
    `WITH latest_order AS (
       SELECT MAX(created_at) AS at FROM orders WHERE business_id = $1
     ), latest_login AS (
       -- Bug fix: the users table stores recency as last_seen_at
       -- (migration 002); no last_login_at column exists. Join
       -- through business_users.user_id to get the most recent
       -- activity across everyone on this tenant.
       SELECT MAX(u.last_seen_at) AS at
         FROM business_users bu
         JOIN users u ON u.id = bu.user_id
        WHERE bu.business_id = $1
     ), sub AS (
       SELECT status FROM subscriptions WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 1
     ), agg AS (
       -- Bug fix: aggregator_health has no status column. A provider
       -- is considered DOWN when its most recent error is newer than
       -- its last successful sync (migration 044 schema).
       SELECT COUNT(*) FILTER (
         WHERE last_error_at IS NOT NULL
           AND (last_ok_at IS NULL OR last_error_at > last_ok_at)
       ) AS down_count
         FROM aggregator_health WHERE business_id = $1
     )
     SELECT
       (SELECT at FROM latest_order) AS last_order_at,
       (SELECT at FROM latest_login) AS last_login_at,
       (SELECT status FROM sub)      AS sub_status,
       COALESCE((SELECT down_count FROM agg), 0) AS agg_down,
       (SELECT onboarded FROM businesses WHERE id = $1) AS onboarded`,
    [businessId]
  );
  const row = q.rows[0] || {};
  const daysSince = (ts) => ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : 999;
  const lastOrderDays = daysSince(row.last_order_at);
  const lastLoginDays = daysSince(row.last_login_at);

  let score = 0;
  score += Math.max(0, 40 * (1 - Math.min(lastOrderDays, 30) / 30));
  score += Math.max(0, 20 * (1 - Math.min(lastLoginDays, 30) / 30));
  if (row.onboarded) score += 15;
  if (row.last_order_at) score += 10;
  if (row.sub_status === 'past_due') score -= 15;
  if (Number(row.agg_down) > 0) score -= 10;

  // Recent anomaly / critical ticket penalties are best-effort — if
  // those tables aren't yet populated (fresh DB), skip silently.
  try {
    const a = await query(
      `SELECT 1 FROM anomaly_alerts
        WHERE business_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`, [businessId]);
    if (a.rowCount > 0) score -= 10;
  } catch (_) { /* table absent */ }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let stage;
  if (row.sub_status === 'trialing')       stage = 'trial';
  else if (score < 30 && lastOrderDays > 30) stage = 'churned';
  else if (score < 60)                     stage = 'at_risk';
  else                                     stage = 'active';

  await query(
    `UPDATE businesses
        SET health_score = $1, lifecycle_stage = $2, health_computed_at = NOW()
      WHERE id = $3`,
    [score, stage, businessId]
  );
  return { score, stage, lastOrderDays: Math.round(lastOrderDays),
           lastLoginDays: Math.round(lastLoginDays) };
}

// Iterates every business — cheap enough at any scale we care about
// (10-10k tenants). Used by the nightly cron and by the admin refresh
// button.
async function recomputeAllHealth() {
  const r = await query(`SELECT id FROM businesses`);
  const results = [];
  for (const row of r.rows) {
    // Sequential on purpose — health computation is small but the
    // JOINed sub-queries can chunk-scan orders; parallelising would
    // just fight the pool. 500 tenants ≈ 30s total.
    try {
      const h = await computeHealth(row.id);
      results.push({ businessId: row.id, ...h });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[crmService] health recompute failed for', row.id, e?.message);
    }
  }
  return { count: results.length };
}

// ── Renewals / trial-ending alerts ───────────────────────────────────
//
// Returns everything expiring in the next `days` days (default 7).
// Includes: monthly renewals, yearly renewals, and trials.

async function upcomingRenewals({ days = 7 } = {}) {
  // Bug fix: subscriptions has `trial_ends_at` (not `trial_end`) and
  // `plan_id UUID` referencing plans.id (not `plan_tier`). Joining
  // `plans p ON p.tier = s.plan_tier` errored out with "column
  // s.plan_tier does not exist".
  const r = await query(
    `SELECT s.business_id, s.status, s.current_period_end, s.trial_ends_at,
            b.name AS business_name, b.email AS business_email,
            b.phone, b.lifecycle_stage,
            p.tier, p.name AS plan_name, p.billing_period
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
  LEFT JOIN plans      p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'trialing')
        AND (
             (s.status = 'trialing' AND s.trial_ends_at BETWEEN NOW() AND NOW() + ($1 || ' days')::INTERVAL)
          OR (s.status = 'active'   AND s.current_period_end BETWEEN NOW() AND NOW() + ($1 || ' days')::INTERVAL)
        )
      ORDER BY COALESCE(s.trial_ends_at, s.current_period_end) ASC`,
    [days]
  );
  return r.rows.map((row) => ({
    businessId: row.business_id, businessName: row.business_name,
    businessEmail: row.business_email, phone: row.phone,
    lifecycleStage: row.lifecycle_stage,
    plan: { tier: row.tier, name: row.plan_name, billingPeriod: row.billing_period },
    subscriptionStatus: row.status,
    endsAt: row.status === 'trialing' ? row.trial_ends_at : row.current_period_end,
    kind: row.status === 'trialing' ? 'trial_ending' : 'renewal',
  }));
}

module.exports = {
  logActivity, listActivities,
  listTasks, createTask, completeTask,
  computeHealth, recomputeAllHealth,
  upcomingRenewals,
};
