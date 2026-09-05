// NamastePOS backend - JWT auth + RBAC middleware
//
// We support two principals:
//   - Business users (Google sign-in) — token carries {uid, bid, role}
//   - Super admins (email/password)   — token carries {sid, isSuperAdmin: true}

const { verifyAccessToken } = require('../utils/jwt');
const {
  Unauthorized, Forbidden, NotFound, HttpError, TooManyRequests,
} = require('../utils/errors');
const cacheBus = require('../utils/cacheBus');
const env = require('../config/env');

function _verify(token) {
  try {
    return verifyAccessToken(token);
  } catch (_) {
    throw new Unauthorized('Invalid or expired token');
  }
}

/**
 * Tenant / business principals: Bearer only.
 *
 * The mobile app and the tenant dashboard are Bearer clients (the dashboard
 * holds its access token in memory and re-bootstraps from the `ff_refresh`
 * httpOnly cookie), so the Authorization header stays the tenant contract.
 */
function _decode(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw new Unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new Unauthorized('Missing or malformed Authorization header');
  return _verify(token);
}

/**
 * Platform-admin principals: the httpOnly `ff_admin` cookie ONLY.
 *
 * Security review 2026-09-04 (item 2). Admin auth moved to an httpOnly cookie
 * on 2026-08-28 precisely so the highest-privilege token in the product would
 * stop being readable by JavaScript — but this function kept accepting
 * `Authorization: Bearer` as well, and the admin SPA kept a localStorage
 * "zero-lockout" fallback that wrote the raw admin JWT there on any definitive
 * 401 from the cookie probe. That combination meant one XSS in the admin
 * console could still exfiltrate a full super-admin session, which is the exact
 * risk the cookie redesign existed to remove. Both halves are now gone: the
 * SPA no longer stores a token, and this path no longer accepts a header.
 *
 * The cookie is `httpOnly; SameSite=Strict; Secure` (prod) and Path-scoped to
 * `${API_PREFIX}/admin`, so its blast radius is the admin API alone and the
 * browser never attaches it to a cross-site request.
 */
function _decodeAdmin(req) {
  const token = req.cookies && req.cookies.ff_admin;
  if (!token) {
    throw new Unauthorized('Admin session cookie missing — sign in again');
  }
  return _verify(token);
}

// ── Tenant API keys (round-2 fix batch 2026-09-06, CONTRACTS §3) ───────────
//
// A THIRD principal: `X-API-Key: npk_live_…` on /v1/businesses/:id/* only.
//   { businessId, role: 'api_key', apiKeyId, readOnly: true, isApiKey: true }
// It is READ-ONLY by construction (non-GET → 405 API_KEY_READ_ONLY, decided
// here before any route runs), tenant-bound (another business's id → 404 in
// requireBusinessOwnership, indistinguishable from a business that does not
// exist), plan-gated on every request (403 API_ACCESS_NOT_IN_PLAN the moment
// the plan loses `api_access`, no revocation needed), and rate-limited per key.
// A revoked or unknown secret is 401. Bearer always wins when both are sent, so
// nothing about the existing two principals changes.
//
// Downstream gates and this principal (read them before changing either side):
//   • requireBusinessOwnership — 404 on mismatch, read-only enforced again.
//   • requireRole             — an api_key has no business_users row and is
//                               never in an allow-list → 403. Owner-only
//                               surfaces (billing, staff, keys) stay closed.
//   • requireStaffPerm        — GET/HEAD with a read permission in
//                               API_KEY_READ_PERMS only (orders / menu /
//                               reports / customers), else 403.
//   • featureGate (app.js)    — mounted BEFORE requireAuth and skips requests
//                               with no Bearer, so the plan gate is re-run
//                               here for the resolved business (same 402
//                               body) — a key must not read a route the plan
//                               does not include.
//   • noPlatformStaff / csrf  — keyed on isSuperAdmin / cookies; unaffected.
const API_KEY_HEADER = 'x-api-key';
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function _hasBearer(req) {
  return (req.headers.authorization || '').startsWith('Bearer ');
}

/** Path relative to the business prefix, e.g. '/orders/123' — what featureGate sees. */
function _pathWithinBusiness(req) {
  const full = (req.originalUrl || req.url || '').split('?')[0];
  const m = full.match(/\/businesses\/[^/]+(\/.*)?$/);
  return m ? (m[1] || '/') : null;
}

async function _authenticateApiKey(req, res) {
  const full = (req.originalUrl || '').split('?')[0];
  if (!full.startsWith(`${env.API_PREFIX}/businesses/`)) {
    throw new Unauthorized('API keys are accepted on /businesses/:businessId routes only');
  }
  if (!READ_METHODS.includes(req.method)) {
    throw new HttpError(
      405,
      'API keys are read-only. Use the dashboard or the mobile app to make changes.',
      'API_KEY_READ_ONLY',
    );
  }
  const apiKeys = require('../services/apiKeyService');
  const key = await apiKeys.resolve(req.headers[API_KEY_HEADER]);
  // Tenant scope FIRST — a key for business A probing business B learns
  // nothing (404), not even whether B's plan has API access.
  const bid = req.params?.businessId;
  if (bid && bid !== key.businessId) throw new NotFound('Business not found');
  await apiKeys.assertPlanAllows(key.businessId);
  const rl = apiKeys.checkRateLimit(key.id);
  if (res) {
    res.setHeader('X-RateLimit-Limit', String(apiKeys.RATE_LIMIT_PER_MIN));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));
  }
  if (!rl.allowed) {
    throw new TooManyRequests(`API key rate limit is ${apiKeys.RATE_LIMIT_PER_MIN} requests per minute`);
  }
  apiKeys.touchLastUsed(key.id);
  // Plan gate for the path (featureGate ran before us and skipped, see above).
  const rel = _pathWithinBusiness(req);
  if (rel) {
    const featureGate = require('./featureGate');
    const needKey = featureGate.requiredFeature(rel);
    if (needKey) {
      const features = require('../services/featureService');
      if (!(await features.hasFeature(key.businessId, needKey))) {
        const err = new HttpError(402, 'This feature is not included in your plan.', 'FEATURE_LOCKED');
        err.details = { feature: needKey, upgradeUrl: '/billing' };
        throw err;
      }
    }
  }
  return {
    id: null,
    businessId: key.businessId,
    role: 'api_key',
    apiKeyId: key.id,
    readOnly: true,
    isApiKey: true,
    impersonator: false,
  };
}

/** Any authenticated principal. */
async function requireAuth(req, res, next) {
  try {
    if (!_hasBearer(req) && req.headers[API_KEY_HEADER]) {
      req.user = await _authenticateApiKey(req, res);
      return next();
    }
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

// Security review 2026-09-04 (item 1): the TTL was the ONLY thing bounding how
// long a deactivated admin kept working, and on >1 instance a deactivation
// performed on one node never reached the others' copy of this Map at all.
// adminTeamService now publishes on the shared cache bus; drop the local entry
// on receive. Without REDIS_URL this still fires locally (single-instance is
// correct immediately) and remote nodes fall back to the TTL, as before.
cacheBus.subscribe(cacheBus.TOPIC.ADMIN_USER, (adminId) => {
  if (!adminId || adminId === '*') _adminActiveCache.clear();
  else _adminActiveCache.delete(adminId);
});

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
    const payload = _decodeAdmin(req);
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
    // API-key principal (2026-09-06): another tenant's id is a 404, not a 403
    // — the key must not be able to confirm that a business id exists. Writes
    // were already refused in requireAuth (405); this is the belt.
    if (req.user?.isApiKey === true) {
      if (req.user.businessId !== bid) return next(new NotFound('Business not found'));
      if (!READ_ONLY.includes(req.method)) {
        return next(new HttpError(405, 'API keys are read-only.', 'API_KEY_READ_ONLY'));
      }
      return next();
    }
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

// ── Cross-instance membership invalidation (security review 2026-09-04) ────
// The 30s TTL was the ONLY bound on how long a revoked or downgraded staff
// member kept their old role + permissions, and it was a per-process bound:
// on a multi-instance deploy the owner's "Remove staff" click landed on one
// node, and the other nodes kept serving the sacked cook's cached permissions
// until their own TTL lapsed. Worse, there was no invalidation hook at all —
// even the node that handled the write waited out its own TTL.
//
// Every write site that changes business_users.role / .permissions /
// .is_active now calls invalidateMembership(); this drops the local entry and
// (when REDIS_URL is set) tells every other instance to do the same, using the
// same shared bus featureService uses. With no Redis the local drop still
// happens — so single-instance revocation is now INSTANT rather than ≤30s —
// and remote instances fall back to the TTL exactly as today.
function _membershipKey(userId, businessId) { return `${userId}:${businessId}`; }

function _dropMembershipLocal({ businessId, userId } = {}) {
  if (!businessId) return;
  if (!userId || userId === '*') {
    // Whole-business drop (outlet delete, plan-cap prune of many staff).
    const suffix = `:${businessId}`;
    for (const key of _roleCache.keys()) {
      if (key.endsWith(suffix)) _roleCache.delete(key);
    }
    return;
  }
  _roleCache.delete(_membershipKey(userId, businessId));
}

cacheBus.subscribe(cacheBus.TOPIC.MEMBERSHIP, _dropMembershipLocal);

/**
 * Drop the cached membership for one (userId, businessId) — or for EVERY
 * member of a business when `userId` is omitted or '*'.
 *
 * Call this from any code path that changes a `business_users` row's role,
 * permissions or is_active. Cheap, synchronous locally, best-effort remotely;
 * it must never throw into the caller's transaction, so callers wrap it in a
 * try/catch and treat failure as non-fatal (worst case we're back to the TTL).
 */
function invalidateMembership(businessId, userId = '*') {
  if (!businessId) return;
  cacheBus.publish(cacheBus.TOPIC.MEMBERSHIP, { businessId, userId: userId || '*' });
}

/**
 * Live membership lookup (role + explicit permission list), 30s-cached per
 * (userId, businessId). NP-201: this used to select only `role`; it now also
 * carries `permissions` so requireStaffPerm can authorise without a second
 * query — one round-trip serves both the role gate and the permission gate.
 * Returns null when the user is not an active member.
 */
async function _currentMembership(userId, businessId) {
  const key = _membershipKey(userId, businessId);
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
      // API-key principal (2026-09-06): no business_users row, never in a role
      // allow-list. Role-gated surfaces (billing, staff, keys, …) stay closed
      // to keys regardless of method — answer without a membership lookup.
      if (req.user.isApiKey === true) {
        return next(new Forbidden(`API keys cannot access this resource (requires one of: ${allow.join(', ')})`));
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
// The staff-permission keys an API key may READ through (CONTRACTS §3). Same
// keyspace as staffService.PERMISSION_KEYS ('menu_editor' is the menu key —
// there is no 'menu'); deliberately a short allow-list, identical to the one
// in middleware/requireStaffPerm.js (BE-A's wrapper) so the two gates agree.
const API_KEY_READ_PERMS = new Set(['orders', 'menu_editor', 'reports', 'customers']);

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
      // API-key principal (2026-09-06, CONTRACTS §3): read permissions for
      // orders / menu / reports / customers only, GET/HEAD only. Everything
      // else a staff permission guards (pos, kds, tables, expenses, staff,
      // bill_template, …) is closed to keys.
      if (req.user.isApiKey === true) {
        const readable = (req.method === 'GET' || req.method === 'HEAD')
          && need.some((p) => API_KEY_READ_PERMS.has(p));
        if (readable) return next();
        return next(new Forbidden(`API keys cannot access this resource (requires permission: ${need.join(' or ')})`));
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

/**
 * Drop every in-process auth cache. TEST-INFRA ONLY.
 *
 * `resetDb()` drops and recreates the public schema, but these Maps live in the
 * Node process and survive it — so a suite could answer from a membership or an
 * admin-active flag belonging to a database that no longer exists. That is the
 * cross-suite flake that has failed CI intermittently all day (most recently
 * GET /v1/auth/me returning 403 in a full run while passing 16/16 in
 * isolation). Clearing the DB without clearing the caches is only half a reset.
 */
function _clearAuthCachesForTests() {
  _roleCache.clear();
  _adminActiveCache.clear();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  requireBusinessOwnership,
  requireRole,
  requireStaffPerm,
  requireNotImpersonating,
  // Cache invalidation (security review 2026-09-04). Exported for the services
  // that mutate business_users, and for tests.
  invalidateMembership,
  _currentMembership,
  _clearAuthCachesForTests,
  // API-key principal (2026-09-06): the read allow-list, for tests + docs.
  API_KEY_READ_PERMS,
};
