// NamastePOS backend - audit log helper for admin actions

const { query } = require('../config/db');
const logger = require('../config/logger');

async function log({
  module, action, entityType, entityId, payload,
  adminId, businessId, ip, userAgent,
}) {
  try {
    await query(
      `INSERT INTO audit_log
        (admin_id, business_id, action, entity_type, entity_id, payload,
         module, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [adminId || null, businessId || null, action, entityType || null,
        entityId || null, payload || null, module || null, ip || null,
        userAgent || null],
    );
  } catch (err) {
    // Still swallowed: an audit failure must never break a business operation
    // a restaurant is in the middle of. But it is NOT silent any more — this
    // used to be a bare `catch (_) {}`, so the audit trail could stop
    // recording for days and nothing anywhere would say so. That is the worst
    // failure mode a compliance log has: it looks complete.
    // Winston signature is (message, meta) — not pino's (obj, msg).
    logger.error('audit_log write failed', {
      err: err.message, module, action, businessId,
    });
  }
}

/**
 * Defer the response until the audit row is committed.
 *
 * Both middlewares below wrap `res.json`, which is synchronous, and used to
 * fire `log()` without awaiting it. So the client was told "201, done" while
 * the INSERT was still in flight — the row usually landed a few ms later, and
 * on a slow database it landed after the next request had already read the
 * table. That is exactly how CI run 33964654257 failed: `mark-paid` returned
 * 201, the very next test read audit_log, and the row was not there yet. The
 * local database was fast enough to hide it, which is why it passed here and
 * failed there.
 *
 * The semantics we actually want for an audit trail are "the action is not
 * acknowledged until it is recorded", so the send waits for the write.
 * `res.json` returns `res` either way, so `return res.json(x)` still chains.
 */
function _sendAfterAudit(res, oldJson, body, entry, writer) {
  writer(entry).finally(() => oldJson(body));
  return res;
}

/** Express middleware that captures the admin's action for logging. */
function middlewareLog(module, action, getEntity) {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) return oldJson(body);
      const entity = getEntity ? getEntity(req, body) : {};
      return _sendAfterAudit(res, oldJson, body, {
        module,
        action,
        entityType: entity.type,
        entityId: entity.id,
        payload: { params: req.params, body: _sanitizeBody(req.body) },
        adminId: req.user?.id,
        businessId: req.params?.businessId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }, log);
    };
    next();
  };
}

function _sanitizeBody(body = {}) {
  const out = { ...body };
  for (const k of ['password', 'password_hash', 'token', 'refreshToken', 'idToken']) {
    if (out[k]) out[k] = '[redacted]';
  }
  return out;
}

async function recent({ limit = 100, offset = 0, module, adminId, businessId } = {}) {
  const where = ['1=1'];
  const values = [];
  let idx = 1;
  if (module) { where.push(`module = $${idx++}`); values.push(module); }
  if (adminId) { where.push(`admin_id = $${idx++}`); values.push(adminId); }
  if (businessId) { where.push(`business_id = $${idx++}`); values.push(businessId); }
  values.push(limit, offset);
  const r = await query(
    `SELECT a.*, au.email AS admin_email, b.name AS business_name
       FROM audit_log a
  LEFT JOIN admin_users au ON au.id = a.admin_id
  LEFT JOIN businesses b ON b.id = a.business_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  return r.rows.map((row) => ({
    id: row.id,
    module: row.module,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    adminEmail: row.admin_email,
    businessName: row.business_name,
    payload: row.payload,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  }));
}

// ── Tenant (owner/staff) audit — money-sensitive actions ─────────────────
// Review 2026-08-28: owner/staff mutations (refunds, voids, discounts, cash
// drawer, plan changes) had no trail. Uses the existing `actor_id` column for
// the business user; best-effort (never breaks the operation).
async function logTenant({
  businessId, userId, module, action, entityType, entityId, payload, ip, userAgent,
}) {
  try {
    await query(
      `INSERT INTO audit_log
        (business_id, actor_id, action, entity_type, entity_id, payload,
         module, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [businessId || null, userId || null, action, entityType || null,
        entityId || null, payload ? _sanitizeBody(payload) : null,
        module || null, ip || null, userAgent || null],
    );
  } catch (err) {
    // Swallowed for the same reason as log() above, and logged for the same
    // reason too: a compliance trail that stops writing must not do it quietly.
    logger.error('tenant audit_log write failed', {
      err: err.message, module, action, businessId,
    });
  }
}

/** Express middleware: log a tenant (owner/staff) mutation after a 2xx.
 *  Mirrors middlewareLog but records actor_id = the business user. */
function tenantMiddlewareLog(module, action, getEntity) {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) return oldJson(body);
      const entity = getEntity ? getEntity(req, body) : {};
      return _sendAfterAudit(res, oldJson, body, {
        businessId: req.params?.businessId,
        userId: req.user?.id,
        module,
        action,
        entityType: entity.type,
        entityId: entity.id,
        payload: { params: req.params, body: _sanitizeBody(req.body || {}) },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }, logTenant);
    };
    next();
  };
}

/** Tenant-scoped audit feed (actor = business user). */
async function recentTenant({ businessId, limit = 100, offset = 0 } = {}) {
  const r = await query(
    `SELECT a.*, u.email AS actor_email, u.display_name AS actor_name
       FROM audit_log a
  LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.business_id = $1 AND a.actor_id IS NOT NULL
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3`,
    [businessId, Math.min(limit, 500), offset],
  );
  return r.rows.map((row) => ({
    id: row.id,
    module: row.module,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorEmail: row.actor_email,
    actorName: row.actor_name,
    payload: row.payload,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  }));
}

module.exports = {
  log,
  middlewareLog,
  recent,
  logTenant,
  tenantMiddlewareLog,
  recentTenant,
};
