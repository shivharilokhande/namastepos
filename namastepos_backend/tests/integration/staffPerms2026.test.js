// NP-201 — tenant staff permission gate (requireStaffPerm).
//
// The founder added a `staff_kitchen` member, signed in on the mobile app with
// phone + PIN, and saw the full OWNER UI. The mobile fail-open role default was
// the visible half of the bug; the invisible half was that the tenant API had
// no permission gate at all on its read paths. `requireRole` only covered
// routes that named a role list, and reports / expenses / staff-list /
// billing-invoices named none — so ANY active member of a business could fetch
// revenue, P&L, the expense ledger, the team roster and every GST subscription
// invoice straight from the API, whatever the app chose to render.
//
// These tests pin the gate from both directions: a kitchen cook is refused on
// the owner/manager surfaces, keeps the KDS feed they actually need, and an
// owner is refused nowhere. They also pin the two resolution rules the
// middleware implements — DEFAULT_PERMS_BY_ROLE when the staff row carries no
// explicit list, and the explicit list winning when it does.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const buildApp = require('../../src/app');

let app;
let biz;
let ownerToken;
let kitchenToken;
let cashierToken;
let grantedKitchenToken;

/**
 * Add an active staff member and return a Bearer token for them.
 * `permissions === null` leaves the column NULL so the middleware has to fall
 * back to DEFAULT_PERMS_BY_ROLE — the exact shape of the founder's staff row.
 */
async function makeStaff(role, { permissions = null, tag = role } = {}) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await query(
    `INSERT INTO users (email, display_name, google_sub)
     VALUES ($1, $2, $3) RETURNING *`,
    [`${tag}-${uniq}@example.com`, tag, `sub-${tag}-${uniq}`],
  );
  const user = u.rows[0];
  if (permissions === null) {
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [biz.id, user.id, role],
    );
  } else {
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active, permissions)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [biz.id, user.id, role, JSON.stringify(permissions)],
    );
  }
  return issueAccessToken({
    sub: user.id,
    bid: biz.id,
    email: user.email,
    role,
  });
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `np201-owner-${Date.now()}`, name: 'Perm Gate Test' });
  ownerToken = tokenFor(biz);
  kitchenToken = await makeStaff('staff_kitchen', { tag: 'cook' });
  cashierToken = await makeStaff('staff_cashier', { tag: 'till' });
  // Same role, but the owner ticked `reports` explicitly. The explicit list is
  // authoritative, so this cook CAN read the summary report.
  grantedKitchenToken = await makeStaff('staff_kitchen', {
    tag: 'cook2',
    permissions: ['home', 'kds', 'reports'],
  });
});
afterAll(async () => { await closePool(); });

const url = (p) => `/v1/businesses/${biz.id}${p}`;
const as = (t) => ({ Authorization: `Bearer ${t}` });

// Routes a `staff_kitchen` cook must NOT reach. Their default grants are
// ['home', 'kds'] — nothing here is in that set.
const FORBIDDEN_FOR_KITCHEN = [
  ['reports — daily revenue', '/reports/daily'],
  ['reports — monthly revenue', '/reports/monthly'],
  ['reports — P&L', '/reports/income-statement'],
  ['reports — income register', '/reports/income-register'],
  ['reports — expense register', '/reports/expense-register'],
  ['reports — invoice register', '/reports/invoice-register'],
  ['reports — GSTR-1 CSV', '/reports/gstr1.csv?from=2026-01-01&to=2026-01-31'],
  ['reports — menu engineering', '/reports/menu-engineering'],
  ['reports — NPS', '/reports/nps'],
  ['action centre', '/action-center'],
  ['accounting — export history', '/exports'],
  ['expenses ledger', '/expenses'],
  ['staff management — roster', '/staff'],
  ['billing — subscription invoices', '/billing/invoices'],
  ['daily closing — history', '/daily-closings'],
  ['daily closing — Z preview', '/daily-closings/preview'],
];

describe('NP-201 — staff_kitchen is refused on owner/manager surfaces', () => {
  for (const [label, path] of FORBIDDEN_FOR_KITCHEN) {
    it(`denies a kitchen token on ${label}`, async () => {
      const r = await request(app).get(url(path)).set(as(kitchenToken));
      // 403 = role/permission gate. 402 = the PLAN gate fired first for a
      // feature this tenant's tier doesn't include (e.g. daily_closing) —
      // also a denial, and correct ordering: entitlement before role.
      expect([402, 403]).toContain(r.status);
    });
  }

  it('403s a kitchen token on the expenses write path too', async () => {
    const r = await request(app).post(url('/expenses')).set(as(kitchenToken))
      .send({ amountInr: 100, category: 'misc', note: 'nope' });
    expect(r.status).toBe(403);
  });

  it('403s a kitchen token on the Tally ledger export', async () => {
    const r = await request(app).post(url('/exports/tally')).set(as(kitchenToken))
      .send({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(r.status).toBe(403);
  });

  it('403s a kitchen token trying to edit the business profile', async () => {
    const r = await request(app).patch('/v1/auth/me').set(as(kitchenToken))
      .send({ name: 'Renamed By The Cook' });
    expect(r.status).toBe(403);
  });
});

describe('NP-201 — the kitchen keeps the surfaces it needs', () => {
  // The KDS/KOT feed is what a cook signs in FOR. It must never be caught by
  // the permission gate. It sits behind the plan-tier featureGate (`kds`), so
  // a 402 FEATURE_LOCKED on a starter test tenant is an acceptable outcome —
  // the assertion that matters is "not 403", i.e. not an authorisation refusal.
  it('does not 403 a kitchen token on the KOT ticket feed', async () => {
    const r = await request(app).get(url('/ops/kot/tickets')).set(as(kitchenToken));
    expect(r.status).not.toBe(403);
    expect([200, 402]).toContain(r.status);
  });

  it('does not 403 a kitchen token on the KOT stations list', async () => {
    const r = await request(app).get(url('/ops/kot/stations')).set(as(kitchenToken));
    expect(r.status).not.toBe(403);
  });

  it('does not 403 a kitchen token on the current subscription (trial banner)', async () => {
    // Deliberately left open: the app reads this on every launch to show the
    // trial-expired / past-due screen. Tier + status only, no invoice data.
    const r = await request(app).get(url('/billing')).set(as(kitchenToken));
    expect(r.status).not.toBe(403);
  });
});

describe('NP-201 — an owner is refused nowhere', () => {
  for (const [label, path] of FORBIDDEN_FOR_KITCHEN) {
    it(`allows an owner token on ${label}`, async () => {
      const r = await request(app).get(url(path)).set(as(ownerToken));
      expect(r.status).not.toBe(403);
      expect(r.status).not.toBe(401);
    });
  }

  it('returns 200 on the report, expense and roster reads that need no params', async () => {
    for (const path of ['/reports/daily?date=2026-09-03', '/expenses', '/staff', '/billing/invoices']) {
      const r = await request(app).get(url(path)).set(as(ownerToken));
      expect(r.status).toBe(200);
    }
  });
});

describe('NP-201 — permission resolution rules', () => {
  it('falls back to DEFAULT_PERMS_BY_ROLE when the staff row has no explicit list', async () => {
    // Cashier defaults include `reports` but NOT `pnl_statement` — the split
    // DEFAULT_PERMS_BY_ROLE documents ("gets reports but NOT P&L") is now
    // actually enforced instead of being a comment.
    const ok = await request(app).get(url('/reports/daily?date=2026-09-03')).set(as(cashierToken));
    expect(ok.status).toBe(200);

    const denied = await request(app).get(url('/reports/income-statement'))
      .set(as(cashierToken));
    expect(denied.status).toBe(403);
  });

  it('lets an explicit permission list override the role defaults', async () => {
    // Same staff_kitchen role, but the owner ticked `reports` for this cook.
    const r = await request(app).get(url('/reports/daily?date=2026-09-03')).set(as(grantedKitchenToken));
    expect(r.status).toBe(200);
  });

  it('ignores a JWT role that the live membership row contradicts', async () => {
    // The gate must authorise off `business_users`, never off the token. Mint a
    // token CLAIMING business_owner for a user whose live row is staff_kitchen —
    // the pre-fix failure mode this whole change exists to prevent.
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const u = await query(
      `INSERT INTO users (email, display_name, google_sub)
       VALUES ($1, 'Liar', $2) RETURNING *`,
      [`liar-${uniq}@example.com`, `sub-liar-${uniq}`],
    );
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, 'staff_kitchen', TRUE)`,
      [biz.id, u.rows[0].id],
    );
    const forgedOwnerToken = issueAccessToken({
      sub: u.rows[0].id,
      bid: biz.id,
      email: u.rows[0].email,
      role: 'business_owner', // claim we do NOT hold
    });

    const r = await request(app).get(url('/reports/income-statement'))
      .set(as(forgedOwnerToken));
    expect(r.status).toBe(403);
  });
});

describe('NP-201 — unauthenticated callers are still 401, not 403', () => {
  it('401s with no token on a gated report', async () => {
    const r = await request(app).get(url('/reports/daily'));
    expect(r.status).toBe(401);
  });
});
