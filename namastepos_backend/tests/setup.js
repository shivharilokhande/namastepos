// NamastePOS backend - shared test setup
//
// Each test suite gets a clean schema. We stub Google verification so tests
// don't need real Google credentials, and stamp a synthetic business per test.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.GOOGLE_CLIENT_IDS = 'test-client.apps.googleusercontent.com';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://namastepos:namastepos@localhost:5432/namastepos_test';
// Review 2026-08-28: cap the pool in tests. The default DB_POOL_MAX=30 × N jest
// workers blows past Postgres max_connections ("too many clients"). Must be set
// BEFORE requiring src/config/db (which builds the pool at import time).
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '2';

const fs = require('fs');
const path = require('path');
const { query } = require('../src/config/db');
const { issueAccessToken } = require('../src/utils/jwt');

// Stub Google ID token verification → return a fake profile.
jest.mock('../src/services/googleService', () => ({
  verifyIdToken: jest.fn(async (idToken) => {
    if (!idToken || idToken === 'bad') {
      const { Unauthorized } = require('../src/utils/errors');
      throw new Unauthorized('Bad token');
    }
    // idToken format we use in tests: 'google:<sub>:<email>'
    const parts = String(idToken).split(':');
    const sub = parts[1] || 'sub-default';
    const email = parts[2] || 'test@example.com';
    return {
      sub,
      email,
      emailVerified: true,
      name: 'Test User',
      picture: 'https://example.com/avatar.png',
    };
  }),
}));

async function resetDb() {
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  // Clear the IN-PROCESS caches before the schema goes.
  //
  // Dropping the database is only half a reset: the role cache (30s TTL), the
  // admin-active cache and the feature cache (60s TTL) are Maps in this Node
  // process and survive it happily. A suite could then answer from a
  // membership belonging to a database that no longer exists — which is the
  // cross-suite flake that failed CI intermittently through 2026-09-05,
  // including GET /v1/auth/me returning 403 in a full run while the same suite
  // passed 16 of 16 in isolation. Cheap to clear, and it removes a whole class
  // of "passes alone, fails together".
  // eslint-disable-next-line global-require
  require('../src/middleware/auth')._clearAuthCachesForTests();
  // eslint-disable-next-line global-require
  require('../src/services/featureService').clearAllCaches();
  // Drop and recreate public schema for a fully clean slate.
  await query('DROP SCHEMA IF EXISTS public CASCADE');
  await query('CREATE SCHEMA public');
  await query('GRANT ALL ON SCHEMA public TO PUBLIC');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await query(sql);
  }
}

/**
 * Create a business plus the OWNER user + business_users membership row so
 * `requireBusinessOwnership` + RBAC checks pass. Older `makeBusiness` left
 * users/memberships empty which made every authenticated test 403. Returns
 * `{ business, user }` so callers can issue tokens for either.
 */
async function makeBusiness({
  email = 'owner@example.com',
  name = 'Test Stall',
} = {}) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userEmail = email.includes('@') ? email : `${email}@example.com`;

  // 1. user
  const u = await query(
    `INSERT INTO users (email, phone, display_name, google_sub)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userEmail, null, 'Owner', `sub-${uniq}`],
  );
  const user = u.rows[0];

  // 2. business — owner_user_id varies across schema versions; try a couple
  //    of common column sets, fall back to minimal.
  let business;
  try {
    const b = await query(
      `INSERT INTO businesses (google_sub, email, name, onboarded, owner_user_id)
       VALUES ($1, $2, $3, TRUE, $4) RETURNING *`,
      [`sub-${uniq}`, userEmail, name, user.id],
    );
    business = b.rows[0];
  } catch (_) {
    const b = await query(
      `INSERT INTO businesses (google_sub, email, name, onboarded)
       VALUES ($1, $2, $3, TRUE) RETURNING *`,
      [`sub-${uniq}`, userEmail, name],
    );
    business = b.rows[0];
  }

  // 3. business_users membership — owner role. Some schema versions have
  //    `permissions` / `pin_hash` / `is_active`. Insert what columns exist.
  try {
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, 'business_owner', TRUE)`,
      [business.id, user.id],
    );
  } catch (_) {
    // Fall back without is_active
    try {
      await query(
        `INSERT INTO business_users (business_id, user_id, role)
         VALUES ($1, $2, 'business_owner')`,
        [business.id, user.id],
      );
    } catch (_2) { /* schema mismatch — skip; some tests may still 403 */ }
  }

  // Decorate with user so tests can pull both off the returned object.
  business._owner = user;
  return business;
}

function tokenFor(business) {
  // Token payload mirrors what authController issues on login: sub = user id,
  // bid = business id, role = business_owner. Older signature accepted a
  // business arg only — keep that as the common case (use the embedded owner
  // user).
  const userId = business._owner?.id || business.id;
  return issueAccessToken({
    sub: userId,
    bid: business.id,
    email: business.email,
    role: 'business_owner',
  });
}

/**
 * No-op in per-suite teardown — the pool is shared across all integration
 * suites in a single Jest process (`--runInBand`). Closing it after one suite
 * makes every subsequent suite fail with "Cannot use a pool after calling
 * end on the pool". Actual teardown happens via globalTeardown.js.
 */
async function closePool() { /* see globalTeardown.js */ }

module.exports = { resetDb, makeBusiness, tokenFor, closePool };
