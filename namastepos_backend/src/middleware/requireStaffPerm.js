// requireStaffPerm — thin wrapper over auth.requireStaffPerm (2026-09-06,
// round-2 review CONTRACTS §7 + §3).
//
// Why a wrapper and not an edit of middleware/auth.js: the tenant permission
// gate lives in auth.js, which the API-access fixer is editing in the same
// batch (X-API-Key principal). This file owns the two behaviours the POS
// surfaces (orders / tables / customers) need on top of it, so both changes
// can land without touching the same lines:
//
//   1. `perm` may be a string OR an array — an array means ANY-OF. auth.js
//      already accepts arrays; this wrapper keeps the same contract so callers
//      can import from either place without a behaviour change.
//   2. An `api_key` principal (`req.user.role === 'api_key'`, minted by
//      auth.js from an X-API-Key header) has no business_users row, so the
//      live-membership lookup in auth.js would refuse it. Per CONTRACTS §3 an
//      API key is READ-ONLY and is treated as holding the read permissions
//      for orders / menu / reports / customers only. Anything else — a write,
//      or a read of staff, billing, expenses, P&L — is 403. auth.js already
//      405s non-GET requests for that principal before we get here; the
//      method check below is belt-and-braces so this file is safe on its own.
//
// Owner always passes (handled in auth.js). Super-admin passes (auth.js).

const auth = require('./auth');
const { Forbidden } = require('../utils/errors');

// The permission keys an API key is deemed to hold, read-only. Keys are the
// same keyspace as staffService.PERMISSION_KEYS. `pos` is deliberately NOT
// here: it is the bill-creating permission, and a key can never create.
const API_KEY_READ_PERMS = new Set(['orders', 'menu_editor', 'reports', 'customers']);

function requireStaffPerm(perm) {
  const need = Array.isArray(perm) ? perm : [perm];
  const inner = auth.requireStaffPerm(need);
  return (req, res, next) => {
    if (req.user && req.user.role === 'api_key') {
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      if (isRead && need.some((p) => API_KEY_READ_PERMS.has(p))) return next();
      return next(new Forbidden(
        isRead
          ? `API keys may not read this resource (requires permission: ${need.join(' or ')})`
          : 'API keys are read-only',
      ));
    }
    return inner(req, res, next);
  };
}

module.exports = requireStaffPerm;
module.exports.requireStaffPerm = requireStaffPerm;
module.exports.API_KEY_READ_PERMS = API_KEY_READ_PERMS;
