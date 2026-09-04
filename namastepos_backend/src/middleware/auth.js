// NamastePOS backend - JWT auth + RBAC middleware
//
// We support two principals:
//   - Business users (Google sign-in) — token carries {uid, bid, role}
//   - Super admins (email/password)   — token carries {sid, isSuperAdmin: true}

const { verifyAccessToken } = require('../utils/jwt');
const { Unauthorized, Forbidden } = require('../utils/errors');

function _decode(req) {
  // Prefer the Authorization header (Bearer-mode clients). Fall back to the
  // httpOnly `ff_admin` cookie (2026-08-28 admin cookie-auth) so the token no
  // longer has to live in localStorage. Dual-mode: either source works.
  const header = req.headers.authorization || '';
  let token = null;
  if (header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else if (req.cookies && req.cookies.ff_admin) {
    token = req.cookies.ff_admin;
  }
  if (!token) {
    throw new Unauthorized('Missing or malformed Authorization header');
  }
  try {
    return verifyAccessToken(token);
  } catch (_) {
    throw new Unauthorized('Invalid or expired token');
  }
}

/** Any authenticated principal. */
function requireAuth(req, _res, next) {
  try {
    const payload = _decode(req);
    if (payload.isSuperAdmin) {
      req.user = { id: payload.sid, isSuperAdmin: true, email: payload.email };
    } else {
      req.user = {
        id: payload.uid || payload.sub,
        businessId: payload.bid,
        role: payload.role,
        email: payload.email,
        // P0-1: track impersonation so write routes can reject it.
        impersonator: payload.imp === true,
      };
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// S3 (security 2026-08-23): super-admin identity used to be trusted straight
// from the JWT with no live DB check, so a deactivated/removed admin kept full
// access until their token expired. Mirror the business-role live check: a
// short-cached lookup of admin_users.is_active on every admin-scoped request.
const _adminActiveCache = new Map(); // adminId → { active, expiresAt }
const ADMIN_CACHE_TTL_MS = 30 * 1000;

async function _adminActive(adminId) {
  if (!adminId) return false;
  const cached = _adminActiveCache.get(adminId);
  if (cached && cached.expiresAt > Date.now()) return cached.active;
  const { query } = require('../config/db');
  const r = await query(
    'SELECT 1 FROM admin_users WHERE id = $1 AND is_active = TRUE LIMIT 1',
    [adminId],
  );
  const active = r.rowCount > 0;
  _adminActiveCache.set(adminId, { active, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });
  return active;
}

/** Restrict to super admins only. */
async function requireSuperAdmin(req, _res, next) {
  try {
    const payload = _decode(req);
    if (!payload.isSuperAdmin) return next(new Forbidden('Super admin access required'));
    // S3: reject tokens whose admin account has since been deactivated.
    if (!(await _adminActive(payload.sid))) {
      return next(new Unauthorized('Admin account is no longer active'));
    }
    req.user = {
      id: payload.sid,
      isSuperAdmin: true,
      email: payload.email,
      role: payload.role || 'support',
      // 2026-08-28: enrol-only session issued under org-wide 2FA enforcement.
      // The admin.routes gate blocks everything but self + 2FA enrolment.
      enrol2fa: payload.enrol2fa === true,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Restrict to business users. Super admins are also allowed (read-only impersonation).
 * Ensures the URL-bound :businessId matches the JWT's bid.
 *
 * P0-1: Block non-GET methods when the principal is an impersonator. Impersonation
 * exists for support to look at a customer's data, not to mutate it.
 */
async function requireBusinessOwnership(req, _res, next) {
  try {
    const READ_ONLY = ['GET', 'HEAD', 'OPTIONS'];
    if (req.user?.isSuperAdmin) {
      // S2 (security 2026-08-23): a plain super-admin login token used to
      // bypass ownership AND role checks on the business API, and because
      // `imp` was false it also escaped the impersonation read-only guard —
      // so ANY admin (incl. low-privilege support/sales roles) could write
      // to ANY tenant, outside the audited /admin surface. Admins now get
      // READ-ONLY oversight here; every tenant mutation must go through the
      // /admin routes (RBAC-gated) or an explicit impersonation session.
      if (!READ_ONLY.includes(req.method)) {
        return next(new Forbidden(
          'Admin access to a business is read-only. Use the admin console or an impersonation session to make changes.',
        ));
      }
      // S3: even for reads, reject a deactivated admin's lingering token.
      if (!(await _adminActive(req.user.id))) {
        return next(new Unauthorized('Admin account is no longer active'));
      }
      // Hardening (2026-08-30): an enrol-only token (issued when org 2FA is
      // enforced but the admin hasn't enrolled yet) must not read tenant data.
      // The enrol gate only covers the /admin router; this closes the tenant
      // read path so 2FA enforcement can't be sidestepped here.
      if (req.user.enrol2fa === true) {
        return next(new Forbidden('Complete two-factor enrolment before accessing tenant data'));
      }
      // ── TENANT-DATA PRIVACY (2026-09-03, founder-driven) ────────────────
      // Read-only was NOT enough. A plain admin token could still GET a
      // restaurant's entire commercial life through the tenant API — order
      // ledger with diner names/phones, every report and register, GST tax
      // invoices, expenses, trial balance / P&L / balance sheet, wallets,
      // gift cards, membership subscribers, staff PIN roster — with no
      // ticket, no scope and no audit row, entirely outside the audited
      // /admin surface. The earlier per-route `noPlatformStaff` patch only
      // covered the diner CRM.
      //
      // Platform staff are therefore DENIED on the tenant API by default.
      // The two legitimate paths remain open:
      //   1. /v1/admin/* — RBAC-gated, audited, and deliberately redacted
      //      (aggregates instead of the sales ledger).
      //   2. An impersonation session (`imp:true`) — a tenant-scoped token,
      //      minted per support case, audit-logged, and already read-only.
      // ALLOW_PLATFORM_READ is a tiny allow-list for genuinely operational,
      // non-commercial reads. Add to it only with a written reason.
      const ALLOW_PLATFORM_READ = [
        /\/health$/, // liveness probes
        /\/billing$/, // tier + status only (no invoice data)
      ];
      const path = req.originalUrl.split('?')[0];
      if (!ALLOW_PLATFORM_READ.some((rx) => rx.test(path))) {
        return next(new Forbidden(
          'Platform staff cannot read tenant business data directly. '
          + 'Use the admin console (aggregated + audited) or start an '
          + 'impersonation session for this customer.',
        ));
      }
      return next();
    }
    const bid = req.params.businessId;
    if (!bid) return next(new Forbidden('Missing businessId'));
    if (!req.user || req.user.businessId !== bid) {
      return next(new Forbidden('You can only access your own business'));
    }
    // Impersonation = read-only.
    if (req.user.impersonator && !READ_ONLY.includes(req.method)) {
      return next(new Forbidden(
        'Impersonation is read-only. Exit impersonation to make changes.',
      ));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Role gate. Pass an array of allowed roles.
 *   requireRole(['business_owner', 'staff_manager'])
 * Super admins always pass.
 *
 * P1 (Arvind #3): The previous version read role only from the JWT, so a
 * revoked or downgraded staff member kept their privileges until their
 * 24-hour token expired. We now also check the live DB membership row when
 * the request has a businessId on the path, and reject if the user no
 * longer holds the role they claim.
 *
 * Cached for 30 seconds per (userId, businessId) to avoid an extra query
 * on every request — short enough that an owner clicking "Remove staff"
 * sees the change within half a minute.
 */
const _roleCache = new Map(); // key → { membership: {role, permissions}|null, expiresAt }
const ROLE_CACHE_TTL_MS = 30 * 1000;

/**
 * Live membership lookup (role + explicit permission list), 30s-cached per
 * (userId, businessId). NP-201: this used to select only `role`; it now also
 * carries `permissions` so requireStaffPerm can authorise without a second
 * query — one round-trip serves both the role gate and the permission gate.
 * Returns null when the user is not an active member.
 */
async function _currentMembership(userId, businessId) {
  const key = `${userId}:${businessId}`;
  const cached = _roleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.membership;

  const { query } = require('../config/db');
  const r = await query(
    `SELECT role, permissions FROM business_users
      WHERE user_id = $1 AND business_id = $2 AND is_active = TRUE
      LIMIT 1`,
    [userId, businessId],
  );
  const membership = r.rowCount > 0
    ? { role: r.rows[0].role, permissions: r.rows[0].permissions }
    : null;
  _roleCache.set(key, { membership, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  return membership;
}

async function _currentRole(userId, businessId) {
  const m = await _currentMembership(userId, businessId);
  return m ? m.role : null;
}

function requireRole(allowed) {
  const allow = Array.isArray(allowed) ? allowed : [allowed];
  return async (req, _res, next) => {
    try {
      if (req.user?.isSuperAdmin) return next();
      if (!req.user) return next(new Forbidden(`Requires one of: ${allow.join(', ')}`));

      // NP-125 follow-up: impersonation tokens carry a non-UUID uid
      // ('impersonator'), so the live business_users lookup would 22P02 →
      // 500. Impersonation is read-only by design (requireBusinessAccess
      // blocks writes); allow GET/HEAD through, reject writes explicitly.
      if (req.user.impersonator) {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        return next(new Forbidden('Impersonation is read-only. Exit impersonation to make changes.'));
      }

      const businessId = req.params.businessId || req.user.businessId;
      let effectiveRole = req.user.role;
      if (businessId && req.user.id) {
        // Re-verify against the live DB row in case the user was downgraded
        // or removed since the JWT was issued.
        const liveRole = await _currentRole(req.user.id, businessId);
        if (!liveRole) {
          return next(new Forbidden('You are no longer a member of this business'));
        }
        effectiveRole = liveRole;
        req.user.role = liveRole; // downstream handlers see the live value
      }

      if (!allow.includes(effectiveRole)) {
        return next(new Forbidden(`Requires one of: ${allow.join(', ')}`));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * NP-201 — tenant permission gate (defence in depth).
 *
 * The mobile app hides screens a staff role shouldn't have, but UI hiding is
 * not security: before this middleware existed, ANY authenticated member of a
 * business — including a `staff_kitchen` cook — could call the tenant reports,
 * expenses, billing-invoice and staff-list endpoints directly and get 200s.
 * `requireRole` only covers routes that named a role list, and the read paths
 * mostly named none.
 *
 * Semantics:
 *   • `business_owner`               → always allowed
 *   • super admin                    → allowed (requireBusinessOwnership has
 *                                      already forced their session read-only)
 *   • impersonation                  → GET/HEAD only, mirroring requireRole
 *   • staff with an explicit
 *     `business_users.permissions`   → that list is authoritative
 *   • staff with an empty list       → DEFAULT_PERMS_BY_ROLE[role]
 *   • anything else                  → 403
 *
 * Pass one permission or several; several means "any of these" (e.g. the
 * reports surface accepts `reports` OR the specific register permission).
 * The membership lookup shares the 30s role cache, so gating a route costs no
 * extra query on a warm cache and one cheap indexed lookup otherwise.
 *
 * Permission keys are the same keyspace the owner toggles per-staff:
 * see staffService.PERMISSION_KEYS / DEFAULT_PERMS_BY_ROLE.
 */
function requireStaffPerm(perm) {
  const need = Array.isArray(perm) ? perm : [perm];
  return async (req, _res, next) => {
    try {
      if (req.user?.isSuperAdmin) return next();
      if (!req.user) {
        return next(new Forbidden(`Requires permission: ${need.join(' or ')}`));
      }
      // Impersonation tokens carry a non-UUID uid, so the membership lookup
      // would blow up (22P02). Reads are already read-only by design.
      if (req.user.impersonator) {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        return next(new Forbidden('Impersonation is read-only. Exit impersonation to make changes.'));
      }

      const businessId = req.params.businessId || req.user.businessId;
      if (!businessId) return next(new Forbidden('Missing businessId'));
      if (!req.user.id) {
        return next(new Forbidden(`Requires permission: ${need.join(' or ')}`));
      }

      const membership = await _currentMembership(req.user.id, businessId);
      if (!membership) {
        return next(new Forbidden('You are no longer a member of this business'));
      }
      // Downstream handlers see the live role, not the (possibly stale) JWT one.
      req.user.role = membership.role;
      if (membership.role === 'business_owner') return next();

      const { DEFAULT_PERMS_BY_ROLE } = require('../services/staffService');
      const raw = membership.permissions;
      let explicit = [];
      if (Array.isArray(raw)) {
        explicit = raw;
      } else if (raw) {
        // jsonb normally arrives parsed; a text column or a legacy row can
        // still hand us a string. Anything that isn't an array is treated as
        // "no explicit grants" — never as a pass.
        try { explicit = JSON.parse(raw); } catch (_) { explicit = []; }
        if (!Array.isArray(explicit)) explicit = [];
      }
      const granted = explicit.length > 0
        ? explicit
        : (DEFAULT_PERMS_BY_ROLE[membership.role] || []);

      if (need.some((p) => granted.includes(p))) return next();
      return next(new Forbidden(`Requires permission: ${need.join(' or ')}`));
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * P0-1: Block writes when the request is being made via a super-admin
 * impersonation token. Impersonation is for *viewing* a customer's data
 * (support, debugging) — it must not mutate.
 *
 * Apply to every mutation route (POST/PUT/PATCH/DELETE) that runs under
 * requireAuth (i.e. business-side routes).
 */
function requireNotImpersonating(req, _res, next) {
  if (req.user?.impersonator) {
    return next(new Forbidden(
      'This is a read-only impersonation session. Exit impersonation to make changes.',
    ));
  }
  return next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  requireBusinessOwnership,
  requireRole,
  requireStaffPerm,
  requireNotImpersonating,
};
