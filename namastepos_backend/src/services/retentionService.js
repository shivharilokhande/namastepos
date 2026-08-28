// NamastePOS backend — DPDP data-retention sweep (2026-08-28)
//
// Data minimisation is a DPDP duty: don't keep personal data longer than you
// need it. This service runs a set of OPT-IN retention windows. Every window
// defaults to 0/disabled — nothing is ever deleted until a super-admin sets a
// positive number of days in the admin Compliance → Retention tab.
//
// Windows (platform_settings KV, integer days; 0/null = disabled):
//   retention.deleted_business_days — hard-delete tenants soft-deleted longer
//       ago than N days. We purge the tenant's audit_log first (that FK has no
//       ON DELETE rule and would otherwise block the delete), then DELETE the
//       business; every other business-scoped table cascades.
//   retention.audit_log_days        — prune platform audit_log rows older than N.
//   retention.cookie_consent_days   — prune ANONYMOUS cookie-banner consent rows
//       (session-only, no user_id/guest_phone) older than N. Registered-user and
//       guest-phone consent evidence is kept.
//
// Safety: each business hard-delete runs in its own transaction and is caught
// individually, so one bad row can't abort the whole sweep. A dry precondition
// (deleted_at IS NOT NULL) means only already-soft-deleted tenants are touched.

const { query, withTransaction } = require('../config/db');
const logger = require('../config/logger');
const settings = require('./settingsService');

const KEYS = {
  deletedBusinessDays: 'retention.deleted_business_days',
  auditLogDays:        'retention.audit_log_days',
  cookieConsentDays:   'retention.cookie_consent_days',
  lastRun:             'retention.last_run',
};

function _days(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function getConfig() {
  const m = await settings.getMany([
    KEYS.deletedBusinessDays, KEYS.auditLogDays, KEYS.cookieConsentDays, KEYS.lastRun,
  ]);
  return {
    deletedBusinessDays: _days(m[KEYS.deletedBusinessDays]),
    auditLogDays:        _days(m[KEYS.auditLogDays]),
    cookieConsentDays:   _days(m[KEYS.cookieConsentDays]),
    lastRun:             m[KEYS.lastRun] || null,
  };
}

async function saveConfig(input, { adminId } = {}) {
  const patch = {};
  if (input.deletedBusinessDays !== undefined) patch[KEYS.deletedBusinessDays] = _days(input.deletedBusinessDays);
  if (input.auditLogDays !== undefined)        patch[KEYS.auditLogDays] = _days(input.auditLogDays);
  if (input.cookieConsentDays !== undefined)   patch[KEYS.cookieConsentDays] = _days(input.cookieConsentDays);
  for (const [k, v] of Object.entries(patch)) {
    await settings.set(k, v, { adminId, description: 'DPDP data-retention window (days; 0 = disabled)' });
  }
  return getConfig();
}

// Hard-delete tenants soft-deleted longer ago than `days`.
async function _purgeDeletedBusinesses(days) {
  if (!days) return 0;
  const due = await query(
    `SELECT id FROM businesses
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' days')::interval
      LIMIT 200`,
    [String(days)]
  );
  let purged = 0;
  for (const row of due.rows) {
    try {
      await withTransaction(async (client) => {
        // audit_log.business_id has no ON DELETE rule → clear it first.
        await client.query(`DELETE FROM audit_log WHERE business_id = $1`, [row.id]);
        // Everything else business-scoped cascades on delete.
        await client.query(`DELETE FROM businesses WHERE id = $1`, [row.id]);
      });
      purged += 1;
    } catch (e) {
      logger.warn(`[retention] could not purge business ${row.id}: ${e.message}`);
    }
  }
  return purged;
}

async function _pruneAuditLog(days) {
  if (!days) return 0;
  const r = await query(
    `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return r.rowCount || 0;
}

async function _pruneCookieConsents(days) {
  if (!days) return 0;
  const r = await query(
    `DELETE FROM consent_events
      WHERE user_id IS NULL AND guest_phone IS NULL AND session_id IS NOT NULL
        AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return r.rowCount || 0;
}

/**
 * Run every enabled retention window. Safe to call repeatedly; disabled
 * windows are no-ops. Returns the counts affected.
 */
async function sweep({ adminId = null } = {}) {
  const cfg = await getConfig();
  const result = {
    businessesPurged: await _purgeDeletedBusinesses(cfg.deletedBusinessDays),
    auditRowsPruned:  await _pruneAuditLog(cfg.auditLogDays),
    consentRowsPruned: await _pruneCookieConsents(cfg.cookieConsentDays),
    ranAt: new Date().toISOString(),
  };
  await settings.set(KEYS.lastRun, result, { adminId, description: 'Last retention sweep result' });
  const any = result.businessesPurged || result.auditRowsPruned || result.consentRowsPruned;
  if (any) {
    logger.info(`[retention] sweep: ${result.businessesPurged} businesses, ${result.auditRowsPruned} audit, ${result.consentRowsPruned} consent`);
  }
  return result;
}

module.exports = { getConfig, saveConfig, sweep, KEYS };
