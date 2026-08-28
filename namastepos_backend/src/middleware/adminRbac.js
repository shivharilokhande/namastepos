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

/**
 * Express middleware factory.
 *   requirePermission('refunds.write') → only finance and super_admin pass.
 */
function requirePermission(perm) {
  return async (req, _res, next) => {
    if (!req.user?.isSuperAdmin) {
      return next(new Forbidden('Admin access required'));
    }
    let role = req.user.role;
    if (!role) {
      const r = await query(
        `SELECT role FROM admin_users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
        [req.user.id]
      );
      role = r.rows[0]?.role || 'support';
      req.user.role = role;
    }
    if (!can(role, perm)) {
      return next(new Forbidden(`Permission denied: ${perm}. Your role: ${role}`));
    }
    return next();
  };
}

module.exports = { requirePermission, can, PERMISSIONS };
