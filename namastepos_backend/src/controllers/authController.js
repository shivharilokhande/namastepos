// NamastePOS backend - auth endpoints
//
// Three sign-in surfaces:
//   - POST /v1/auth/google              (Flutter mobile + customer dashboard)
//   - POST /v1/auth/refresh
//   - POST /v1/auth/logout
//   - POST /v1/auth/switch-business     (user has multiple memberships)
//   - GET  /v1/auth/me                  (current user, businesses, active role)
//   - PATCH /v1/auth/me                 (update active business)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const google = require('../services/googleService');
const auth = require('../services/authService');
const { NotFound, Forbidden } = require('../utils/errors');

// ── Schemas ──────────────────────────────────────────────────────────────
const googleLoginSchema = {
  body: Joi.object({
    idToken: Joi.string().required(),
    // Optional: when user has multiple businesses they can specify which to activate
    businessId: Joi.string().uuid().allow(null),
    // 2026-09-04: Google sign-UP is also a signup, so it carries the chosen
    // plan too — otherwise "Start free trial on Pro → Continue with Google"
    // would silently drop back to the default. Ignored for existing users
    // (only read when a first business is created).
    plan: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).allow('', null),
  }),
};

// QA-8 P1 (Lakshmi #2): refresh tokens can now come EITHER from the body
// (legacy path; localStorage on the client) or from the `ff_refresh`
// httpOnly cookie. Cookie path is XSS-proof and the recommended default
// for new clients. Body path stays for back-compat.
const refreshSchema = {
  body: Joi.object({ refreshToken: Joi.string().allow('', null) }),
};

const switchBusinessSchema = {
  body: Joi.object({ businessId: Joi.string().uuid().required() }),
};

const updateBusinessSchema = {
  body: Joi.object({
    name: Joi.string().min(1).max(255),
    phone: Joi.string().pattern(/^[0-9+\-\s]{6,20}$/).allow('', null),
    city: Joi.string().max(100).allow('', null),
    category: Joi.string().max(50).allow('', null),
    gstin: Joi.string().max(15).allow('', null),
    address: Joi.string().max(500).allow('', null),
    upi_id: Joi.string().max(100).allow('', null),
    bank_account: Joi.string().max(50).allow('', null),
    bank_ifsc: Joi.string().max(11).allow('', null),
    logo_url: Joi.string().uri().allow('', null),
    onboarded: Joi.boolean(),
    // FF-252 — chosen in the setup wizard. `hybrid` = per-table decides.
    default_service_mode: Joi.string().valid('dine_in', 'self_pickup', 'hybrid'),
    // 2026-08-25 (founder: Google reviews) — owner pastes their Google Maps
    // link (or the Place ID directly) in dashboard Settings; reviewsService
    // resolves + calls the Places Details API with it. '' clears the field,
    // same convention as logo_url. Not in OWNER_ONLY_FIELDS: a wrong value
    // only affects review fetching, not payouts.
    google_maps_url: Joi.string().uri().max(2048).allow('', null),
    google_place_id: Joi.string().max(100).allow('', null),
    // 2026-08-26 (founder: GST-compliant subscription invoices) — tax identity
    // used when NamastePOS bills the owner. Owner-only (see OWNER_ONLY_FIELDS)
    // because it appears on financial documents. All optional.
    legal_name: Joi.string().max(255).allow('', null),
    fssai: Joi.string().max(20).allow('', null),
    pan: Joi.string().max(10).allow('', null),
  }).min(1),
};

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * Verify Google ID token → find/create user → return JWT + active business.
 *
 * If the user has no business yet, we auto-create one (named after their
 * Google display name). They'll be sent to /onboarding to fill in details.
 *
 * If they have multiple businesses and `businessId` is provided, we use it;
 * otherwise the first membership is activated.
 */
// DEV-ONLY: skip Google verification so the macOS/desktop Flutter app and
// staging environments can sign in by email alone. Gated behind
// FF_DEV_LOGIN=1 in .env so it's impossible in production.
const devLoginSchema = {
  body: Joi.object({
    email: Joi.string().email().required(),
    name: Joi.string().max(255).default('Dev User'),
    businessId: Joi.string().uuid().allow(null),
  }),
};

// ── Email + password auth (Push 4) ───────────────────────────────────────
const registerSchema = {
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(128).required(),
    name: Joi.string().max(255).allow('', null),
    businessName: Joi.string().max(255).allow('', null),
    referralCode: Joi.string().max(16).allow('', null),
    // 2026-09-04 (pricing audit F-01/F-02): the plan card the prospect
    // actually clicked, carried from the landing page's `?plan=` through the
    // register form. The trial is then provisioned on THAT plan instead of
    // silently on Starter. Same shape as billingController's changeBody so a
    // tier code is validated identically on both paths; an unknown, retired
    // or another tenant's private tier is ignored by resolveTrialPlanId and
    // the default applies, so this can never be used to grant a plan.
    plan: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).allow('', null),
  }),
};

const passwordLoginSchema = {
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
};

// Founder bug #1 (2026-08-25) — change password from the profile screen.
// currentPassword is optional at the schema level because Google-only
// accounts (no password_hash yet) set their first password without one;
// the service enforces it whenever a hash already exists.
const changePasswordSchema = {
  body: Joi.object({
    currentPassword: Joi.string().allow('', null),
    newPassword: Joi.string().min(8).required(),
  }),
};

// Push 14a — PIN-based staff login. The mobile staff-picker shows a list
// of names for a business; the user taps theirs and enters 4 digits.
const pinLoginSchema = {
  body: Joi.object({
    businessId: Joi.string().uuid().required(),
    userId: Joi.string().uuid().required(),
    pin: Joi.string().length(4).pattern(/^\d{4}$/).required(),
  }),
};
const staffPickerSchema = {
  body: Joi.object({
    businessId: Joi.string().uuid().required(),
  }),
};
// 2026-08-26 — phone-first staff login. Staff enter their own mobile number;
// we return the outlets they can sign into (so no owner has to log in first
// on the device). Digits only, 8–15 to cover +country variants stored raw.
const staffResolveSchema = {
  body: Joi.object({
    phone: Joi.string().pattern(/^[0-9+\-\s]{8,20}$/).required(),
  }),
};

// NP-126 (2026-09-03): one-time impersonation handoff code exchange.
// Codes are 32 random bytes base64url (43 chars); cap length defensively.
const impersonationExchangeSchema = {
  body: Joi.object({
    code: Joi.string().min(16).max(128).required(),
  }),
};

/** Helper — build the standard session payload + plan summary. */
async function _sessionPayload(user, { req, name, planTier = null }) {
  let memberships = await auth.listMembershipsForUser(user.id);
  let createdBusiness = false;
  if (memberships.length === 0) {
    await auth.createBusinessForUser(user, {
      name: name || user.display_name || 'My Business',
      // The plan the signup chose — the trial runs on this one.
      planTier,
    });
    memberships = await auth.listMembershipsForUser(user.id);
    createdBusiness = true;
    // FF-223: this is the definitive "first login" checkpoint (a new
    // business was just created). Fire the D0 welcome email once,
    // non-blocking. The email dispatch log's unique index guarantees
    // we won't double-send if this runs twice for the same user.
    try {
      const active = memberships[0];
      const onboardingEmail = require('../services/onboardingEmailService');
      onboardingEmail.sendWelcome({
        userId: user.id,
        businessId: active?.businessId || null,
        email: user.email,
        name: name || user.display_name,
      }).catch((e) => require('../config/logger')
        .warn(`[email] D0 send failed: ${e.message}`));
    } catch (_) { /* never let email block auth */ }
  }
  const active = memberships[0];
  const business = await auth.getBusinessById(active.businessId);
  const { accessToken, refreshToken } = await auth.issueSession(
    { user, businessId: active.businessId, role: active.role },
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  let plan = null;
  try {
    const features = require('../services/featureService');
    plan = await features.planSummary(active.businessId);
  } catch (e) { /* B24: keep non-blocking, but log so support can trace */
    // eslint-disable-next-line no-console
    console.warn(`[authController] post-login side effect failed: ${e?.message}`);
  }
  // Push 14c — include permissions. Owner always gets the full set; for
  // staff, return whatever's in business_users.permissions (or role
  // defaults if empty).
  const staffSvc = require('../services/staffService');
  let permissions;
  if (active.role === 'business_owner') {
    permissions = staffSvc.PERMISSION_KEYS;
  } else {
    try {
      const { query } = require('../config/db');
      const r = await query(
        `SELECT permissions FROM business_users
          WHERE business_id = $1 AND user_id = $2 LIMIT 1`,
        [active.businessId, user.id],
      );
      const raw = r.rows[0]?.permissions;
      const explicit = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
      permissions = explicit.length > 0
        ? explicit
        : (staffSvc.DEFAULT_PERMS_BY_ROLE[active.role] || []);
    } catch (_) {
      permissions = staffSvc.DEFAULT_PERMS_BY_ROLE[active.role] || [];
    }
  }
  return {
    token: accessToken,
    refreshToken,
    user: auth.serializeUser(user),
    business: auth.serializeBusiness(business),
    role: active.role,
    permissions,
    memberships,
    isNewBusiness: createdBusiness,
    plan,
  };
}

const register = asyncHandler(async (req, res) => {
  const { email, password, name, businessName, referralCode, plan } = req.body;
  const { user } = await auth.registerWithPassword({ email, password, name });
  // D0 welcome email is fired inside _sessionPayload when it creates
  // the first business — same path for password + Google registrations.
  const raw = await _sessionPayload(user, {
    req, name: businessName || name, planTier: plan || null,
  });
  // L2 referral — if they signed up with a referral code, associate the new
  // business with it (FF-333: award happens later via cron after 30 active
  // days). Best-effort; never blocks registration.
  if (referralCode) {
    const newBizId = raw?.business?.id || raw?.memberships?.[0]?.businessId;
    if (newBizId) {
      try { await require('../services/referralService').associate(referralCode, newBizId); } catch (_) { /* non-fatal — stale/invalid code */ }
    }
  }
  const payload = _applyRefreshCookie(req, res, raw);
  res.status(201).json({ ...payload, isNewUser: true });
});

const passwordLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await auth.loginWithPassword({ email, password });
  const raw = await _sessionPayload(user, { req });
  const payload = _applyRefreshCookie(req, res, raw);
  res.json({ ...payload, isNewUser: false });
});

// PIN-based staff login. Verifies PIN against business_users.pin_hash,
// then issues the same session payload as Google/password — except the
// active business + role come from the existing membership, not from
// memberships[0] (since staff have exactly one membership per device).
const pinLogin = asyncHandler(async (req, res) => {
  const staff = require('../services/staffService');
  const features = require('../services/featureService');
  const { businessId, userId, pin } = req.body;
  const row = await staff.verifyPin(businessId, userId, pin);
  const user = await auth.getUserById(userId);
  const business = await auth.getBusinessById(businessId);
  const { accessToken, refreshToken } = await auth.issueSession(
    { user, businessId, role: row.role },
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  let plan = null;
  try { plan = await features.planSummary(businessId); } catch (e) { console.warn(`[authController] planSummary failed biz=${businessId}: ${e?.message}`); }
  // Resolve effective permissions for this staff (Push 14c)
  const rawPerms = row.permissions;
  const explicitPerms = Array.isArray(rawPerms)
    ? rawPerms : (rawPerms ? JSON.parse(rawPerms) : []);
  const effectivePerms = explicitPerms.length > 0
    ? explicitPerms
    : (staff.DEFAULT_PERMS_BY_ROLE?.[row.role] || []);
  const payload = _applyRefreshCookie(req, res, {
    token: accessToken,
    refreshToken,
    user: auth.serializeUser(user),
    business: auth.serializeBusiness(business),
    role: row.role,
    permissions: effectivePerms,
    memberships: [{ businessId, role: row.role, displayName: row.display_name }],
    isNewUser: false,
    plan,
  });
  res.json(payload);
});

const devLogin = asyncHandler(async (req, res) => {
  // P1 fix (2026-08-22): hard-disabled in production regardless of env —
  // one stray FF_DEV_LOGIN=1 in prod would allow passwordless login as
  // any email.
  const env = require('../config/env');
  if (env.isProd() || process.env.FF_DEV_LOGIN !== '1') {
    return res.status(404).json({ error: 'DEV_LOGIN_DISABLED' });
  }
  const { email, name, businessId } = req.body;
  // Re-use the Google findOrCreateUser path; pass a synthetic `sub`
  // derived from the email so the row is stable across logins.
  const { user, created } = await auth.findOrCreateUser({
    sub: `dev-${email}`,
    email,
    name,
    picture: null,
  });

  let memberships = await auth.listMembershipsForUser(user.id);
  let createdBusiness = false;
  if (memberships.length === 0) {
    await auth.createBusinessForUser(user, { name: name || 'Dev Business' });
    memberships = await auth.listMembershipsForUser(user.id);
    createdBusiness = true;
  }

  let active = memberships[0];
  if (businessId) {
    const found = memberships.find((m) => m.businessId === businessId);
    if (found) active = found;
  }
  const business = await auth.getBusinessById(active.businessId);
  const { accessToken, refreshToken } = await auth.issueSession(
    { user, businessId: active.businessId, role: active.role },
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );

  let plan = null;
  try {
    const features = require('../services/featureService');
    plan = await features.planSummary(active.businessId);
  } catch (e) { /* B24: keep non-blocking, but log so support can trace */
    // eslint-disable-next-line no-console
    console.warn(`[authController] post-login side effect failed: ${e?.message}`);
  }
  const payload = _applyRefreshCookie(req, res, {
    token: accessToken,
    refreshToken,
    user: auth.serializeUser(user),
    business: auth.serializeBusiness(business),
    role: active.role,
    memberships,
    isNewUser: created,
    isNewBusiness: createdBusiness,
    plan,
  });
  res.json(payload);
});

const googleLogin = asyncHandler(async (req, res) => {
  const profile = await google.verifyIdToken(req.body.idToken);
  const { user, created } = await auth.findOrCreateUser(profile);

  // Memberships
  let memberships = await auth.listMembershipsForUser(user.id);
  let createdBusiness = false;

  // First-time user: bootstrap a business owned by them
  if (memberships.length === 0) {
    await auth.createBusinessForUser(user, {
      name: profile.name,
      planTier: req.body.plan || null,
    });
    memberships = await auth.listMembershipsForUser(user.id);
    createdBusiness = true;
  }

  // Pick active business
  let active = memberships[0];
  if (req.body.businessId) {
    const found = memberships.find((m) => m.businessId === req.body.businessId);
    if (!found) throw new Forbidden('You are not a member of that business');
    active = found;
  }

  const business = await auth.getBusinessById(active.businessId);
  const { accessToken, refreshToken } = await auth.issueSession(
    { user, businessId: active.businessId, role: active.role },
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );

  let planSum = null;
  try {
    const features = require('../services/featureService');
    planSum = await features.planSummary(active.businessId);
  } catch (e) { /* B24: keep non-blocking, but log so support can trace */
    // eslint-disable-next-line no-console
    console.warn(`[authController] post-login side effect failed: ${e?.message}`);
  }
  const payload = _applyRefreshCookie(req, res, {
    token: accessToken,
    refreshToken,
    user: auth.serializeUser(user),
    business: auth.serializeBusiness(business),
    role: active.role,
    memberships, // so the client can offer a switcher
    isNewUser: created,
    isNewBusiness: createdBusiness,
    plan: planSum,
  });
  res.json(payload);
});

const REFRESH_COOKIE = 'ff_refresh';

// FF-213 Cookie flags audit:
//   - httpOnly     → JS can't read the refresh token (XSS-safe).
//   - sameSite=strict → refresh cookie never sent on cross-site nav (CSRF-safe).
//   - secure=prod  → HTTPS only in prod; must be false in dev over HTTP or the
//                    browser silently drops the cookie.
//   - path=/v1/auth → cookie only sent to auth endpoints (blast-radius).
//   - maxAge 30 d  → matches the refresh-token TTL in auth.service.
// `app.set('trust proxy', 1)` in app.js ensures `req.secure` is correct
// behind the nginx TLS terminator.
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/v1/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

/// Task-99: opt-in refresh-token-as-cookie helper for login endpoints.
/// The client says "I want cookie auth" by sending
///   X-Auth-Mode: cookie   (request header)   OR
///   ?cookieAuth=1         (query param)
/// on the login request. On opt-in we Set-Cookie the refresh token and
/// blank it out of the JSON body so it can't be picked up by any
/// leftover localStorage code. Legacy clients that don't opt in keep
/// receiving the refresh token in the body — no behaviour change for
/// them, no cookie set → CSRF middleware stays inert for Bearer-only
/// requests.
function _applyRefreshCookie(req, res, payload) {
  const wantsCookie = req.headers['x-auth-mode'] === 'cookie'
    || req.query.cookieAuth === '1'
    || req.query.cookieAuth === 'true';
  if (!wantsCookie || !payload?.refreshToken) return payload;
  res.cookie(REFRESH_COOKIE, payload.refreshToken, COOKIE_OPTS);
  // Redact so the client doesn't accidentally persist it and defeat
  // the point of moving to a cookie.
  return { ...payload, refreshToken: undefined };
}

// clearCookie must repeat the same attributes or some browsers keep the
// cookie alive (spec §5.3.11 — the (name,domain,path) triple identifies it,
// but Chrome+Safari also require matching sameSite/secure to actually remove).
const COOKIE_CLEAR_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/v1/auth',
};

const refresh = asyncHandler(async (req, res) => {
  // QA-8 P1: read refresh token from cookie OR body (back-compat). The
  // SOURCE matters — if the client sent the token in the body, they're
  // a legacy/Bearer-mode client and we must NOT push them into cookie
  // mode by silently Set-Cookie'ing the response. Doing that broke the
  // CSRF middleware because every dashboard client started carrying
  // an `ff_refresh` cookie they never asked for.
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  const fromBody = req.body.refreshToken;
  const refreshToken = fromCookie || fromBody;
  if (!refreshToken) throw new (require('../utils/errors').Unauthorized)('No refresh token');

  const tokens = await auth.refreshSession(refreshToken, {
    userAgent: req.headers['user-agent'], ip: req.ip,
  });

  // Only set the cookie if the client was already using cookies — this
  // preserves opt-in mode. Legacy clients keep getting the token in the body.
  if (fromCookie) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, COOKIE_OPTS);
  }
  res.json({ token: tokens.accessToken, refreshToken: tokens.refreshToken });
});

const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body.refreshToken;
  if (refreshToken) await auth.revokeRefreshToken(refreshToken);
  res.clearCookie(REFRESH_COOKIE, COOKIE_CLEAR_OPTS);
  res.json({ success: true });
});

const me = asyncHandler(async (req, res) => {
  const user = await auth.getUserById(req.user.id);
  if (!user) throw new NotFound('User not found');
  const memberships = await auth.listMembershipsForUser(req.user.id);
  const business = req.user.businessId
    ? await auth.getBusinessById(req.user.businessId)
    : null;
  // Bootstrap the client with the active plan tier + feature list so it
  // can hide/show UI affordances without an extra round-trip.
  let plan = null;
  if (req.user.businessId) {
    try {
      const features = require('../services/featureService');
      plan = await features.planSummary(req.user.businessId);
    } catch (_) { /* fail open — feature gating still enforces server-side */ }
  }
  // Push 16i — also surface the effective permission list so the mobile
  // can refresh staff drawer state without a sign-out when the owner
  // toggles checkboxes on the dashboard.
  let permissions = null;
  if (req.user.businessId && req.user.role !== 'business_owner') {
    try {
      const staff = require('../services/staffService');
      const r = await require('../config/db').query(
        `SELECT permissions, role FROM business_users
          WHERE business_id = $1 AND user_id = $2 LIMIT 1`,
        [req.user.businessId, req.user.id],
      );
      if (r.rowCount > 0) {
        const row = r.rows[0];
        // Explicit list overrides role defaults; falls back to defaults.
        const explicit = Array.isArray(row.permissions) ? row.permissions : null;
        permissions = (explicit && explicit.length > 0)
          ? explicit
          : (staff.DEFAULT_PERMS_BY_ROLE[row.role] || []);
      }
    } catch (_) { /* fail open */ }
  }
  res.json({
    user: auth.serializeUser(user),
    business: auth.serializeBusiness(business),
    role: req.user.role,
    memberships,
    plan, // { tierKind, features: [...] }
    permissions, // null for owner = "all"; array for staff
    // Founder bug #1 (2026-08-25): the profile screen needs to know
    // whether to ask for the current password (has one) or offer a
    // first-time "set password" flow (Google-only account). Boolean
    // only — the hash itself must never leave the server.
    hasPassword: !!user.password_hash,
  });
});

// P0-9: Banking + tax-identity fields can only be changed by business_owner.
// Mass-assignment of these from a staff_manager (let alone staff_cashier) request
// would let an internal user redirect Razorpay payouts to their own account.
const OWNER_ONLY_FIELDS = new Set([
  'upi_id', 'bank_account', 'bank_ifsc', 'gstin',
  // Tax identity shown on the subscription invoice we bill the owner for.
  'legal_name', 'fssai', 'pan',
]);

const patchMe = asyncHandler(async (req, res) => {
  // Hardening (2026-08-30): editing the business profile (name, phone, address,
  // logo, service mode, Google links) is an owner/manager action. Previously
  // only staff_cashier was blocked, so waiters/kitchen/captains/drivers could
  // rename the restaurant or change its address. Restrict to owner + manager.
  if (!['business_owner', 'staff_manager'].includes(req.user.role)) {
    throw new Forbidden('Only the owner or a manager can edit the business profile');
  }

  const protectedKeysInBody = Object.keys(req.body).filter((k) => OWNER_ONLY_FIELDS.has(k));
  if (protectedKeysInBody.length > 0 && req.user.role !== 'business_owner') {
    throw new Forbidden(
      `Only the business owner can change: ${protectedKeysInBody.join(', ')}`,
    );
  }

  const business = await auth.updateBusiness(req.user.businessId, req.body);
  res.json({ business: auth.serializeBusiness(business) });
});

// Founder bug #1 (2026-08-25): POST /v1/auth/change-password.
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await auth.changePassword(req.user.id, { currentPassword, newPassword });
  res.json({ success: true });
});

/**
 * Switch the active business/OUTLET. auth.switchBusiness re-verifies the
 * business_users membership server-side, so a session for outlet A can never
 * be traded for outlet B without a live membership row.
 *
 * 2026-09-03 — the outlet switcher needs the new plan + role in the same
 * round trip (the target outlet may sit on a different plan), and honours the
 * cookie-auth mode so switching doesn't silently drop a cookie session back
 * to a body token.
 */
const switchBusiness = asyncHandler(async (req, res) => {
  const user = await auth.getUserById(req.user.id);
  const tokens = await auth.switchBusiness(
    { user, businessId: req.body.businessId },
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  const business = await auth.getBusinessById(req.body.businessId);
  let plan = null;
  try { plan = await require('../services/featureService').planSummary(req.body.businessId); } catch (_) { /* non-fatal — dashboard refetches /auth/me anyway */ }
  const memberships = await auth.listMembershipsForUser(req.user.id);
  const active = memberships.find((m) => m.businessId === req.body.businessId);
  const payload = _applyRefreshCookie(req, res, {
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    business: auth.serializeBusiness(business),
    role: active?.role || null,
    plan,
    memberships,
  });
  res.json(payload);
});

module.exports = {
  googleLogin: [validate(googleLoginSchema), googleLogin],
  devLogin: [validate(devLoginSchema), devLogin],
  register: [validate(registerSchema), register],
  passwordLogin: [validate(passwordLoginSchema), passwordLogin],
  pinLogin: [validate(pinLoginSchema), pinLogin],
  staffPicker: [validate(staffPickerSchema), asyncHandler(async (req, res) => {
    // NP-102 (2026-09-03): requireAuth alone still let ANY signed-in tenant
    // pull ANY other tenant's roster (userId + role + name) by posting a
    // foreign businessId — a cross-tenant IDOR that hands out valid userIds
    // for PIN brute-forcing. Owner and staff tokens both carry the active
    // business as `bid` → req.user.businessId (see middleware/auth.js), so
    // scope the lookup to the caller's own business. Super-admin tokens have
    // no businessId and are rejected too — admin roster access goes through
    // the audited /admin surface, not this mobile picker.
    if (!req.user.businessId || req.user.businessId !== req.body.businessId) {
      throw new Forbidden('You can only list staff for your own business');
    }
    const staff = require('../services/staffService');
    res.json({ staff: await staff.listForPicker(req.body.businessId) });
  })],
  // Phone-first staff login step 1: resolve the outlets a phone can sign into.
  // Returns [] for an unknown phone (never reveals whether a number exists via
  // a different status code — same 200 + empty list either way). The client
  // then shows an outlet picker if >1, or jumps straight to PIN if exactly 1,
  // and finishes with the existing POST /auth/pin-login (which owns lockout).
  staffResolve: [validate(staffResolveSchema), asyncHandler(async (req, res) => {
    const staff = require('../services/staffService');
    const phone = String(req.body.phone).trim();
    res.json({ outlets: await staff.resolveStaffByPhone(phone) });
  })],
  // NP-126 (2026-09-03): swap a one-time admin-minted handoff code for the
  // same short-lived read-only impersonation token the legacy /admin
  // .../impersonate endpoint returns. The claim is a single atomic UPDATE in
  // adminService — used/expired/unknown codes all 401 uniformly. Rate-limited
  // per-IP in auth.routes.js.
  impersonationExchange: [validate(impersonationExchangeSchema), asyncHandler(async (req, res) => {
    const adminSvc = require('../services/adminService');
    res.json(await adminSvc.exchangeImpersonationCode(req.body.code));
  })],
  refresh: [validate(refreshSchema), refresh],
  // Bug fix: there used to be a stub here that overrode the rich `logout` defined
  // earlier in this file. The stub didn't read the ff_refresh cookie or clear it,
  // so cookie-based clients kept their session after POST /auth/logout. Export the
  // canonical version from line ~348 instead.
  logout,
  me,
  changePassword: [validate(changePasswordSchema), changePassword],
  patchMe: [validate(updateBusinessSchema), patchMe],
  switchBusiness: [validate(switchBusinessSchema), switchBusiness],
};
