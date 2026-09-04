// NamastePOS backend - super-admin RBAC
// Roles: super_admin, finance, support, sales
//
// Permission matrix:
//   super_admin  → everything
//   finance      → revenue/refunds/GST/invoices; read-only on others
//   support      → customer CRUD + impersonation + notes; read-only on others
//   sales        → customers (create + plan change) + coupons; read-only on others

const { Forbidden } = require('../utils/errors');
const { query } = require('../config/db');

const PERMISSIONS = {
  super_admin: ['*'],
  // P0-12: finance/support/sales must NOT have settings.write. Only super_admin
  // can mutate platform settings (Razorpay keys, GST defaults, feature flags).
  finance: [
    'revenue.read', 'revenue.write',
    'refunds.read', 'refunds.write',
    'gst.read', 'gst.write',
    'invoices.read', 'invoices.write',
    'customers.read', 'plans.read', 'coupons.read',
    'audit.read', 'reports.read', 'settings.read',
    'compliance.read',
  ],
  support: [
    'customers.read', 'customers.write', 'customers.impersonate',
    'notes.read', 'notes.write',
    'staff.read', 'menu.read', 'orders.read',
    'reports.read', 'audit.read',
    'plans.read', 'coupons.read', 'invoices.read', 'refunds.read', 'gst.read',
    // DPDP DSR + grievance handling is a support function.
    'compliance.read', 'compliance.write',
  ],
  sales: [
    'customers.read', 'customers.write',
    'plans.read', 'plans.change',
    'coupons.read', 'coupons.write',
    'reports.read',
  ],
};

function can(role, perm) {
  const grants = PERMISSIONS[role] || [];
  return grants.includes('*') || grants.includes(perm);
}

// Hardening (2026-08-30): resolve the admin's role LIVE from the DB, not from
// the (up-to-1h-lived) JWT claim. Without this, a demoted admin kept their old
// permissions — e.g. settings.write / team management — until their access
// token expired. A tiny TTL cache keeps this to ~1 DB read per admin per
// window instead of one per request. Returns null when the admin is no longer
// active, which denies every permission.
const ROLE_TTL_MS = 30_000;
const _roleCache = new Map(); // adminId → { role, exp }

async function _liveRole(adminId) {
  const hit = _roleCache.get(adminId);
  if (hit && hit.exp > Date.now()) return hit.role;
  const r = await query(
    'SELECT role FROM admin_users WHERE id = $1 AND is_active = TRUE LIMIT 1',
    [adminId],
  );
  const role = r.rows[0]?.role || null; // null = deactivated / gone → deny all
  _roleCache.set(adminId, { role, exp: Date.now() + ROLE_TTL_MS });
  return role;
}

// Let callers (e.g. role change / deactivation handlers) drop a stale entry so
// the change takes effect immediately rather than after the TTL.
function invalidateRole(adminId) { _roleCache.delete(adminId); }

/**
 * Express middleware factory.
 *   requirePermission('refunds.write') → only finance and super_admin pass.
 */
function requirePermission(perm) {
  return async (req, _res, next) => {
    if (!req.user?.isSuperAdmin) {
      return next(new Forbidden('Admin access required'));
    }
    let role;
    try {
      role = await _liveRole(req.user.id);
    } catch (e) {
      return next(e);
    }
    if (!role) {
      return next(new Forbidden('Admin account is no longer active'));
    }
    req.user.role = role; // reflect the live role downstream
    if (!can(role, perm)) {
      return next(new Forbidden(`Permission denied: ${perm}. Your role: ${role}`));
    }
    return next();
  };
}

module.exports = { requirePermission, can, PERMISSIONS, invalidateRole };
