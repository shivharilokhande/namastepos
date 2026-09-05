// NamastePOS backend - auth service
//
// Model: users (decoupled identity) + business_users (membership + role).
// Google Sign-In flow:
//   1. Verify Google ID token → {sub, email, name, picture}
//   2. Find or create users row (keyed by google_sub then email)
//   3. If user has no business yet → create one + business_users(owner)
//   4. Pick "active" business: explicit param if user has multiple, else
//      their first/only one
//   5. Issue JWT with {sub: userId, bid: activeBusinessId, role}
//
// Refresh tokens are stored as sha256 hashes and rotate on every use.

const { query } = require('../config/db');
const env = require('../config/env');
const {
  issueAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
} = require('../utils/jwt');
const { Unauthorized, NotFound, Forbidden } = require('../utils/errors');

// ── Users ────────────────────────────────────────────────────────────────

// ── Email/password auth (Push 4) ────────────────────────────────────────
// `password_hash` is bcrypt(plaintext, 12). Existing Google accounts can
// opt into a password from the profile screen later; brand-new email
// registrations are inserted via registerWithPassword().

const bcrypt = require('../utils/bcrypt');
const { BadRequest } = require('../utils/errors');
// Unauthorized already imported above
const PWD_SALT_ROUNDS = 12;

async function registerWithPassword({ email, password, name }) {
  if (!email || !password) throw new BadRequest('Email and password required');
  if (password.length < 8) throw new BadRequest('Password must be at least 8 characters');

  // Block re-registration with an existing email — friendlier message
  // than a SQL unique-violation explosion.
  const existing = await query(
    'SELECT id, password_hash FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  if (existing.rowCount > 0 && existing.rows[0].password_hash) {
    throw new BadRequest('That email is already registered. Try logging in.');
  }

  const hash = await bcrypt.hash(password, PWD_SALT_ROUNDS);
  let user;
  if (existing.rowCount > 0) {
    // Add password to an existing Google-only account.
    const r = await query(
      `UPDATE users SET password_hash = $1, display_name = COALESCE($2, display_name),
                         last_login_method = 'password', last_seen_at = NOW()
        WHERE id = $3 RETURNING *`,
      [hash, name, existing.rows[0].id],
    );
    user = r.rows[0];
  } else {
    const r = await query(
      `INSERT INTO users (email, display_name, password_hash, last_login_method, last_seen_at)
       VALUES ($1, $2, $3, 'password', NOW()) RETURNING *`,
      [email, name || email.split('@')[0], hash],
    );
    user = r.rows[0];
  }
  return { user, created: existing.rowCount === 0 };
}

async function loginWithPassword({ email, password }) {
  if (!email || !password) throw new BadRequest('Email and password required');
  const r = await query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  if (r.rowCount === 0 || !r.rows[0].password_hash) {
    throw new Unauthorized('Invalid email or password');
  }
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) throw new Unauthorized('Invalid email or password');
  await query(
    'UPDATE users SET last_seen_at = NOW(), last_login_method = \'password\' WHERE id = $1',
    [r.rows[0].id],
  );
  return r.rows[0];
}

async function setPasswordForUser(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new BadRequest('Password must be at least 8 characters');
  const hash = await bcrypt.hash(newPassword, PWD_SALT_ROUNDS);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
}

// Founder bug #1 (2026-08-25): change password from the profile screen.
// Two modes:
//   - Account already has a password → currentPassword is mandatory and
//     must bcrypt-match, otherwise anyone holding a stolen access token
//     could silently lock the owner out.
//   - Google-only account (password_hash IS NULL) → first-time password
//     set, no currentPassword needed (there is nothing to compare).
async function changePassword(userId, { currentPassword, newPassword } = {}) {
  if (!newPassword || newPassword.length < 8) {
    throw new BadRequest('Password must be at least 8 characters');
  }
  const r = await query(
    'SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1',
    [userId],
  );
  if (r.rowCount === 0) throw new NotFound('User not found');

  const existingHash = r.rows[0].password_hash;
  if (existingHash) {
    if (!currentPassword) throw new BadRequest('Current password is required');
    const ok = await bcrypt.compare(currentPassword, existingHash);
    if (!ok) throw new BadRequest('Current password is incorrect');
  }

  const hash = await bcrypt.hash(newPassword, PWD_SALT_ROUNDS);
  await query(
    'UPDATE users SET password_hash = $1, last_login_method = \'password\' WHERE id = $2',
    [hash, userId],
  );
}

async function findOrCreateUser({ sub, email, name, picture }) {
  // Prefer google_sub (stable identifier)
  let r = await query('SELECT * FROM users WHERE google_sub = $1 LIMIT 1', [sub]);
  if (r.rowCount > 0) {
    // Touch last_seen
    await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [r.rows[0].id]);
    return { user: r.rows[0], created: false };
  }
  // Fall back to email (first link or returning after a Google account swap)
  r = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  if (r.rowCount > 0) {
    const upd = await query(
      `UPDATE users
          SET google_sub = $1,
              display_name = COALESCE($2, display_name),
              photo_url = COALESCE($3, photo_url),
              last_seen_at = NOW()
        WHERE id = $4 RETURNING *`,
      [sub, name, picture, r.rows[0].id],
    );
    return { user: upd.rows[0], created: false };
  }
  const ins = await query(
    `INSERT INTO users (google_sub, email, display_name, photo_url, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
    [sub, email, name, picture],
  );
  return { user: ins.rows[0], created: true };
}

async function getUserById(id) {
  const r = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return r.rows[0] || null;
}

// ── Memberships ──────────────────────────────────────────────────────────

async function listMembershipsForUser(userId) {
  const r = await query(
    `SELECT bu.business_id, bu.role, bu.is_active,
            b.name, b.email AS business_email, b.photo_url AS business_photo, b.onboarded
       FROM business_users bu
       JOIN businesses b ON b.id = bu.business_id
      WHERE bu.user_id = $1 AND bu.is_active = TRUE
      ORDER BY bu.joined_at ASC`,
    [userId],
  );
  return r.rows.map((row) => ({
    businessId: row.business_id,
    name: row.name,
    role: row.role,
    onboarded: row.onboarded,
    photoUrl: row.business_photo,
  }));
}

async function getMembership(userId, businessId) {
  const r = await query(
    `SELECT * FROM business_users
      WHERE user_id = $1 AND business_id = $2 AND is_active = TRUE
      LIMIT 1`,
    [userId, businessId],
  );
  return r.rows[0] || null;
}

// ── First-time business setup ────────────────────────────────────────────

/**
 * Resolve which plan a brand-new signup's trial runs on.
 *
 * VERIFIED BUG THIS FIXES (pricing audit F-01, 2026-09-04): this used to be a
 * literal `(SELECT id FROM plans WHERE tier = 'free')`. Every "Start free
 * trial" button — including the ones on the Growth / Pro / Advanced /
 * Enterprise cards — produced a Starter account: 10 menu items, 2 tables, 200
 * orders/month. The prospect evaluated a plan nobody sells to their segment
 * and never saw the product they would have paid for.
 *
 * Selection order:
 *   1. `requestedTier` — the tier the signup actually chose (the plan card
 *      they clicked, carried through `?plan=` → register body).
 *   2. `env.TRIAL_PLAN_TIER` — the operator's default, set on Render.
 *   3. The cheapest PAID public shared plan. Resolved at runtime rather than
 *      hardcoded: the live ladder is admin-editable and the tier codes are
 *      genuinely confusing (`pro_plan` is the plan named "Pro", while `pro` is
 *      Enterprise), so any literal here would rot or mis-assign.
 *   4. The free plan. Last resort — signup must never fail because the plan
 *      table is in an odd state.
 *
 * A candidate is only eligible if it is active, public, and shared
 * (`business_id IS NULL`). That is what stops a signup query string from
 * attaching another tenant's bespoke custom plan (migration 074) or a retired
 * internal plan to a stranger's trial.
 */
async function resolveTrialPlanId(requestedTier) {
  const eligible = async (tier) => {
    if (!tier || typeof tier !== 'string') return null;
    const r = await query(
      `SELECT id FROM plans
        WHERE tier = $1
          AND is_active = TRUE
          AND business_id IS NULL
          AND is_public IS NOT FALSE
        LIMIT 1`,
      [tier],
    );
    return r.rows[0]?.id || null;
  };

  // 1 + 2 — an explicit choice, then the operator default.
  for (const tier of [requestedTier, env.TRIAL_PLAN_TIER]) {
    const id = await eligible(tier);
    if (id) return id;
  }
  // 3 — cheapest paid shared public plan.
  const paid = await query(
    `SELECT id FROM plans
      WHERE is_active = TRUE
        AND business_id IS NULL
        AND is_public IS NOT FALSE
        AND price_inr_paise > 0
      ORDER BY price_inr_paise ASC
      LIMIT 1`,
  );
  if (paid.rows[0]?.id) return paid.rows[0].id;
  // 4 — free plan fallback (pre-2026-09-04 behaviour).
  const free = await eligible('free');
  return free;
}

async function createBusinessForUser(user, { name, planTier = null }) {
  // Create both a businesses row (legacy, identifies tenant) AND link via
  // business_users with role=business_owner.
  // Legacy `businesses` table also stores google_sub/email so existing
  // foreign keys keep working; we mirror from `users` for the owner.
  // Explicit onboarded=false so the client-side wizard fires for
  // brand-new signups. Migration 043 flipped every existing business
  // to TRUE, and 043 also set the column default to TRUE, so we have
  // to be explicit here.
  const r = await query(
    `INSERT INTO businesses (google_sub, email, display_name, photo_url, name, onboarded)
     VALUES ($1, $2, $3, $4, $5, FALSE)
     RETURNING *`,
    [user.google_sub || `user-${user.id}`, user.email,
      user.display_name, user.photo_url, name || (user.display_name || 'My Business')],
  );
  const business = r.rows[0];
  await query(
    `INSERT INTO business_users (business_id, user_id, role)
     VALUES ($1, $2, 'business_owner')
     ON CONFLICT (business_id, user_id) DO NOTHING`,
    [business.id, user.id],
  );
  // Default subscription = a TRIAL OF THE CHOSEN PLAN. Hardcode-audit fix
  // (2026-08-24): trial length is env.TRIAL_DAYS (single source of truth),
  // not an inline SQL literal. Plan-choice fix (2026-09-04): the plan is
  // resolved by resolveTrialPlanId() instead of being pinned to `tier='free'`.
  //
  // WHY THIS DOES NOT VIOLATE THE "never activate a paid plan for free in
  // production" GUARD (billingController.changePlan → PAYMENTS_UNAVAILABLE
  // when Razorpay is not live). That guard exists so a rotated or missing
  // Razorpay key can never turn a paid *purchase* into a free permanent
  // entitlement. What we write here is deliberately different in all three
  // respects that matter:
  //   • status is 'trialing', never 'active' — the paid-subscription state is
  //     only ever reached through the Razorpay webhook or an explicit
  //     super-admin assignment,
  //   • it is time-boxed by a non-null trial_ends_at, and
  //     planEntitlement.entitledSql() stops honouring it the moment that
  //     passes, so entitlement expires without anyone having to remember to
  //     revoke it,
  //   • no charge, mandate or invoice is created, and no gateway call is made.
  // A time-boxed trial of an advertised plan is the product we sell; it is not
  // a free activation of one. The guard on the purchase path is untouched.
  const trialPlanId = await resolveTrialPlanId(planTier);
  await query(
    `INSERT INTO subscriptions
       (business_id, plan_id, trial_plan_id, status, trial_ends_at, current_period_end)
     VALUES ($1, $3, $3,
             'trialing', NOW() + make_interval(days => $2), NOW() + make_interval(days => $2))
     ON CONFLICT (business_id) DO NOTHING`,
    [business.id, env.TRIAL_DAYS, trialPlanId],
  );
  return business;
}

/**
 * Explicit trial-expiry downgrade (retention audit F-01, 2026-09-04).
 *
 * Expiry used to be a SILENT resolution change: once `trial_ends_at` passed,
 * featureService fell through to starter while the subscription row still said
 * "trialing on Pro". Nothing was written, nothing was told to the owner, and
 * `subscriptionService.get()` — which the limit gate reads — still handed out
 * the trialled plan's caps.
 *
 * This moves the row itself: onto the free/starter plan, status 'active' (a
 * genuine free plan, not a lapsed trial), with `trial_downgraded_at` stamped
 * and `trial_plan_id` preserved so we can say what lapsed and re-offer it.
 * Returns one row per downgraded business for the caller to notify.
 *
 * Idempotent: the WHERE clause excludes anything already downgraded or already
 * on the free plan, so re-running it is a no-op.
 */
async function expireLapsedTrials({ limit = 500 } = {}) {
  const free = await query(
    `SELECT id, tier FROM plans
      WHERE is_active = TRUE AND business_id IS NULL AND price_inr_paise = 0
      ORDER BY created_at ASC LIMIT 1`,
  );
  const freePlan = free.rows[0];
  if (!freePlan) return [];
  const r = await query(
    `UPDATE subscriptions s
        SET plan_id = $1,
            status = 'active',
            trial_downgraded_at = NOW(),
            -- Roll the period forward with the downgrade. Without this the
            -- tenant's Billing page reads "Renews on <yesterday>" until the
            -- nightly self-heal picks it up, and the self-heal runs BEFORE
            -- this sweep in the 02:00 block — so it would be a full day late.
            current_period_start = NOW(),
            current_period_end = NOW() + INTERVAL '1 month',
            updated_at = NOW()
      WHERE s.business_id IN (
              SELECT business_id FROM subscriptions
               WHERE status = 'trialing'
                 AND trial_ends_at IS NOT NULL
                 AND trial_ends_at <= NOW()
                 AND trial_downgraded_at IS NULL
                 AND plan_id <> $1
               ORDER BY trial_ends_at ASC
               LIMIT $2
            )
      RETURNING s.business_id, s.trial_plan_id, s.trial_ends_at`,
    [freePlan.id, limit],
  );
  // Entitlement changed for these tenants — drop the per-business feature
  // cache (and tell peer nodes) so the downgrade is visible immediately
  // rather than on the next TTL sweep.
  for (const row of r.rows) {
    try { require('./featureService').clearCache(row.business_id); } catch (_) { /* non-fatal */ }
  }
  return r.rows;
}

// ── Sessions / tokens ────────────────────────────────────────────────────

async function issueSession({ user, businessId, role }, { userAgent, ip } = {}) {
  const accessToken = issueAccessToken({
    sub: user.id,
    uid: user.id,
    bid: businessId || null,
    role: role || null,
    email: user.email,
  });
  const refreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const expiresAt = refreshTokenExpiry();
  // S1 (security 2026-08-23): store WHICH user this token belongs to, so the
  // consume path can no longer be tricked into minting another member's role.
  await query(
    `INSERT INTO refresh_tokens (business_id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [businessId, user.id, refreshHash, userAgent || null, ip || null, expiresAt],
  );
  return { accessToken, refreshToken };
}

async function refreshSession(refreshToken, { userAgent, ip } = {}) {
  if (!refreshToken) throw new Unauthorized('Missing refresh token');
  const hash = hashRefreshToken(refreshToken);

  // S5 (security 2026-08-23): reuse detection. If this exact token hash exists
  // but is already revoked, it means a rotated/stolen token was replayed —
  // revoke the whole family (this user's tokens in this business) and refuse.
  const seen = await query(
    'SELECT business_id, user_id, revoked_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1',
    [hash],
  );
  if (seen.rowCount > 0 && seen.rows[0].revoked_at !== null) {
    const { business_id, user_id } = seen.rows[0];
    if (user_id) {
      await query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
          WHERE business_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [business_id, user_id],
      );
    }
    throw new Unauthorized('Session reuse detected — please sign in again');
  }

  // S1: identity now comes from the token's own user_id, joined to that
  // specific membership row for the live role. No more arbitrary LIMIT 1.
  const r = await query(
    `SELECT rt.*, bu.role
       FROM refresh_tokens rt
       JOIN business_users bu
         ON bu.business_id = rt.business_id
        AND bu.user_id = rt.user_id
        AND bu.is_active = TRUE
      WHERE rt.token_hash = $1
        AND rt.revoked_at IS NULL
        AND rt.expires_at > NOW()
        AND rt.user_id IS NOT NULL
      LIMIT 1`,
    [hash],
  );
  if (r.rowCount === 0) throw new Unauthorized('Refresh token invalid or expired');
  const row = r.rows[0];
  // 2026-09-06 (review #17, P3): the rotation used to be read-then-revoke, so
  // two concurrent refreshes with the SAME token both passed the SELECT above
  // and both minted a session — the reuse detector never saw the second one.
  // Make the revoke conditional: exactly one caller flips revoked_at; the
  // loser's rowCount is 0, which is a replay by definition → same family
  // revoke + refusal as the `seen.revoked_at !== null` branch.
  const rotated = await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [row.id],
  );
  if (rotated.rowCount === 0) {
    if (row.user_id) {
      await query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
          WHERE business_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [row.business_id, row.user_id],
      );
    }
    throw new Unauthorized('Session reuse detected — please sign in again');
  }
  const user = await getUserById(row.user_id);
  return issueSession(
    { user, businessId: row.business_id, role: row.role },
    { userAgent, ip },
  );
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  const hash = hashRefreshToken(refreshToken);
  await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [hash]);
}

// ── Switching active business (for users in multiple businesses) ─────────

async function switchBusiness({ user, businessId }, { userAgent, ip } = {}) {
  const membership = await getMembership(user.id, businessId);
  if (!membership) throw new Forbidden('You are not a member of that business');
  return issueSession(
    { user, businessId, role: membership.role },
    { userAgent, ip },
  );
}

// ── Updates ──────────────────────────────────────────────────────────────

async function getBusinessById(id) {
  const r = await query('SELECT * FROM businesses WHERE id = $1 LIMIT 1', [id]);
  return r.rows[0] || null;
}

async function updateBusiness(id, patch) {
  const fields = [
    'name', 'phone', 'city', 'category', 'gstin', 'address',
    'upi_id', 'bank_account', 'bank_ifsc', 'logo_url', 'onboarded',
    'default_service_mode', // FF-252
    // 2026-08-25 — Google reviews source config (migration 061). Lives on
    // businesses, NOT platform_settings: that table is platform-global KV
    // with no business_id column, so per-business rows can't exist there.
    'google_maps_url', 'google_place_id',
    // 2026-08-26 — tax identity for GST-compliant subscription invoices (062).
    'legal_name', 'fssai', 'pan',
    // 2026-09-05 — declared GST scheme (092). The owner answers this once in
    // the setup wizard; it decides the default slab on new menu items and
    // whether their bills carry GST at all. Validated against the same three
    // values by authController's updateBusinessSchema.
    'gst_scheme',
  ];
  const updates = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) {
      updates.push(`${f} = $${idx}`);
      values.push(patch[f]);
      idx += 1;
    }
  }
  if (updates.length === 0) return getBusinessById(id);
  values.push(id);
  const r = await query(
    `UPDATE businesses SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return r.rows[0];
}

// ── Serializers ──────────────────────────────────────────────────────────

function serializeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    photoUrl: u.photo_url,
    phone: u.phone,
  };
}

function serializeBusiness(b) {
  if (!b) return null;
  return {
    id: b.id,
    email: b.email,
    displayName: b.display_name,
    photoUrl: b.photo_url,
    name: b.name,
    phone: b.phone,
    city: b.city,
    category: b.category,
    gstin: b.gstin,
    address: b.address,
    // Tax identity for GST-compliant subscription invoices (migration 062).
    legalName: b.legal_name || null,
    fssai: b.fssai || null,
    pan: b.pan || null,
    upiId: b.upi_id,
    bankAccount: b.bank_account,
    bankIfsc: b.bank_ifsc,
    logoUrl: b.logo_url,
    // 2026-08-25 — surfaced so the dashboard Settings "Google reviews" card
    // can show what's currently configured (migration 061 columns).
    googleMapsUrl: b.google_maps_url || null,
    googlePlaceId: b.google_place_id || null,
    onboarded: b.onboarded,
    // FF-252 — surfaced to dashboard/wizard so owners can choose the
    // default service style once. hybrid = per-table (default).
    defaultServiceMode: b.default_service_mode || 'hybrid',
    // 2026-09-05 (092) — surfaced so the app/dashboard setup flow can show
    // the owner what they are on today, and so the mobile bill printer knows
    // to print a bill of supply rather than a tax invoice for a composition
    // dealer. 'regular' for every business that has not answered yet, which
    // is the behaviour they already have.
    gstScheme: b.gst_scheme || 'regular',
    createdAt: b.created_at,
    // R14: multi-currency. Dashboard's formatINR() picks this up from the
    // business cache and uses Intl.NumberFormat with the right locale.
    currency: b.currency_code || 'INR',
    locale: (b.currency_code === 'USD') ? 'en-US'
      : (b.currency_code === 'EUR') ? 'de-DE'
        : (b.currency_code === 'GBP') ? 'en-GB'
          : (b.currency_code === 'AED') ? 'ar-AE'
            : 'en-IN',
  };
}

module.exports = {
  findOrCreateUser,
  registerWithPassword,
  loginWithPassword,
  setPasswordForUser,
  changePassword,
  getUserById,
  listMembershipsForUser,
  getMembership,
  createBusinessForUser,
  resolveTrialPlanId,
  expireLapsedTrials,
  issueSession,
  refreshSession,
  revokeRefreshToken,
  switchBusiness,
  getBusinessById,
  updateBusiness,
  serializeUser,
  serializeBusiness,
};
