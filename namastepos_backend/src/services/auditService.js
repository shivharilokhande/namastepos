// NamastePOS backend - audit log helper for admin actions

const { query } = require('../config/db');

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
       userAgent || null]
    );
  } catch (_) {
    /* audit failures must never break business operations */
  }
}

/** Express middleware that captures the admin's action for logging. */
function middlewareLog(module, action, getEntity) {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        const entity = getEntity ? getEntity(req, body) : {};
        log({
          module, action,
          entityType: entity.type, entityId: entity.id,
          payload: { params: req.params, body: _sanitizeBody(req.body) },
          adminId: req.user?.id, businessId: req.params?.businessId,
          ip: req.ip, userAgent: req.headers['user-agent'],
        });
      }
      return oldJson(body);
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
  if (module)     { where.push(`module = $${idx++}`);     values.push(module); }
  if (adminId)    { where.push(`admin_id = $${idx++}`);   values.push(adminId); }
  if (businessId) { where.push(`business_id = $${idx++}`);values.push(businessId); }
  values.push(limit, offset);
  const r = await query(
    `SELECT a.*, au.email AS admin_email, b.name AS business_name
       FROM audit_log a
  LEFT JOIN admin_users au ON au.id = a.admin_id
  LEFT JOIN businesses b ON b.id = a.business_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    values
  );
  return r.rows.map((row) => ({
    id: row.id, module: row.module, action: row.action,
    entityType: row.entity_type, entityId: row.entity_id,
    adminEmail: row.admin_email, businessName: row.business_name,
    payload: row.payload, ipAddress: row.ip_address,
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
       module || null, ip || null, userAgent || null]
    );
  } catch (_) { /* audit must never break business ops */ }
}

/** Express middleware: log a tenant (owner/staff) mutation after a 2xx.
 *  Mirrors middlewareLog but records actor_id = the business user. */
function tenantMiddlewareLog(module, action, getEntity) {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        const entity = getEntity ? getEntity(req, body) : {};
        logTenant({
          businessId: req.params?.businessId,
          userId: req.user?.id,
          module, action,
          entityType: entity.type, entityId: entity.id,
          payload: { params: req.params, body: _sanitizeBody(req.body || {}) },
          ip: req.ip, userAgent: req.headers['user-agent'],
        });
      }
      return oldJson(body);
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
    [businessId, Math.min(limit, 500), offset]
  );
  return r.rows.map((row) => ({
    id: row.id, module: row.module, action: row.action,
    entityType: row.entity_type, entityId: row.entity_id,
    actorEmail: row.actor_email, actorName: row.actor_name,
    payload: row.payload, ipAddress: row.ip_address, createdAt: row.created_at,
  }));
}

module.exports = {
  log, middlewareLog, recent,
  logTenant, tenantMiddlewareLog, recentTenant,
};
