// Integration tests for the admin SaaS control plane (2026-09-03).
//
// Covers the endpoints added to close the "not a complete end-to-end SaaS
// dashboard" gap:
//   GET  /v1/admin/overview
//   GET  /v1/admin/health/platform
//   GET  /v1/admin/reports/usage
//   GET  /v1/admin/customers/:id/usage
//   GET  /v1/admin/customers/:id/notifications
//   GET  /v1/admin/dunning              (+ /:id/timeline)
//   POST /v1/admin/dunning/:id/retry | /waive | /mark-paid
//   POST /v1/admin/customers/:id/cancel-subscription
//   POST /v1/admin/customers/:id/owner-email
//   POST /v1/admin/customers/:id/reset-owner-credentials
//   POST /v1/admin/customers/:id/resend-welcome
//   PATCH/v1/admin/customers/:id/account
//   POST /v1/admin/customers/:id/anonymise
//
// Two axes per endpoint: RBAC rejection (unauthenticated, tenant-owner
// token, and a real admin whose ROLE lacks the permission — the live-role
// lookup in adminRbac means the role must exist in admin_users), then the
// happy path.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');

let app;
let biz; let ownerToken;
let dunningBiz;
let eraseBiz;
let superToken;
let supportToken;
let financeToken;

// requirePermission resolves the role LIVE from admin_users, so a token
// alone isn't enough — the row has to exist and be active.
async function makeAdmin(email, role) {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ($1, 'x-not-a-real-hash', $2, TRUE)
     RETURNING id, email, role`,
    [email, role],
  );
  return issueAccessToken({
    sid: r.rows[0].id,
    isSuperAdmin: true,
    email: r.rows[0].email,
    role: r.rows[0].role,
  });
}

// Security review 2026-09-04 (item 2): the admin API no longer accepts
// `Authorization: Bearer` — the super-admin session comes from the httpOnly
// `ff_admin` cookie only. We send BOTH here because this helper is also used
// with a TENANT token to assert that a tenant principal is refused on /admin
// (which must still reach the tenant Bearer path where relevant).
const auth = (t) => ({ Authorization: `Bearer ${t}`, Cookie: `ff_admin=${t}` });

// A paid plan + an active subscription, so MRR / usage / dunning have
// something real to report.
async function givePaidSubscription(businessId, { status = 'active' } = {}) {
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end, billing_period)
     VALUES ($1, (SELECT id FROM plans WHERE tier = 'basic'), $2::subscription_status,
             NOW() + INTERVAL '30 days', 'monthly')
     ON CONFLICT (business_id) DO UPDATE
       SET status = $2::subscription_status,
           plan_id = (SELECT id FROM plans WHERE tier = 'basic')`,
    [businessId, status],
  );
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();

  biz = await makeBusiness({ email: 'ops-main@example.com', name: 'Ops Main' });
  dunningBiz = await makeBusiness({ email: 'ops-dunning@example.com', name: 'Ops Dunning' });
  eraseBiz = await makeBusiness({ email: 'ops-erase@example.com', name: 'Ops Erase' });
  ownerToken = tokenFor(biz);

  await givePaidSubscription(biz.id, { status: 'active' });
  await givePaidSubscription(dunningBiz.id, { status: 'past_due' });
  await givePaidSubscription(eraseBiz.id, { status: 'active' });

  // Two failed charges on the dunning tenant so the queue has real context.
  await query(
    `UPDATE subscriptions SET dunning_attempts = 2, last_dunning_at = NOW() - INTERVAL '2 days'
      WHERE business_id = $1`,
    [dunningBiz.id],
  );
  await query(
    `INSERT INTO dunning_events (business_id, subscription_id, event, attempt_no, reason, emailed)
     SELECT $1, s.id, 'payment_failed', 1, 'card declined', TRUE
       FROM subscriptions s WHERE s.business_id = $1`,
    [dunningBiz.id],
  );

  superToken = await makeAdmin('ops-super@namastepos.in', 'super_admin');
  supportToken = await makeAdmin('ops-support@namastepos.in', 'support');
  financeToken = await makeAdmin('ops-finance@namastepos.in', 'finance');
});

afterAll(async () => {
  jest.restoreAllMocks();
  await closePool();
});

// ── 1. RBAC ─────────────────────────────────────────────────────────────

describe('admin SaaS ops — RBAC', () => {
  it('rejects unauthenticated reads', async () => {
    for (const path of [
      '/v1/admin/overview',
      '/v1/admin/health/platform',
      '/v1/admin/reports/usage',
      '/v1/admin/dunning',
      `/v1/admin/customers/${biz.id}/usage`,
      `/v1/admin/customers/${biz.id}/notifications`,
    ]) {
      const r = await request(app).get(path);
      expect(r.status).toBe(401);
    }
  });

  it('rejects a tenant-owner token on every new endpoint', async () => {
    const reads = await Promise.all([
      request(app).get('/v1/admin/overview').set(auth(ownerToken)),
      request(app).get('/v1/admin/dunning').set(auth(ownerToken)),
      request(app).get(`/v1/admin/customers/${biz.id}/usage`).set(auth(ownerToken)),
    ]);
    for (const r of reads) expect([401, 403]).toContain(r.status);

    const writes = await Promise.all([
      request(app).post(`/v1/admin/dunning/${biz.id}/retry`).set(auth(ownerToken)),
      request(app).post(`/v1/admin/customers/${biz.id}/resend-welcome`).set(auth(ownerToken)),
      request(app).post(`/v1/admin/customers/${biz.id}/anonymise`).set(auth(ownerToken))
        .send({ confirm: 'ANONYMISE', reason: 'nope' }),
    ]);
    for (const r of writes) expect([401, 403]).toContain(r.status);
  });

  it('support role cannot run dunning money actions (needs revenue.write)', async () => {
    const waive = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/waive`)
      .set(auth(supportToken)).send({ reason: 'trying it on' });
    expect(waive.status).toBe(403);

    const markPaid = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/mark-paid`)
      .set(auth(supportToken)).send({});
    expect(markPaid.status).toBe(403);

    // …and cannot read the finance-grade queue either.
    const queue = await request(app).get('/v1/admin/dunning').set(auth(supportToken));
    expect(queue.status).toBe(403);
  });

  it('support role cannot run a DPDP erasure (needs settings.write)', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${eraseBiz.id}/anonymise`)
      .set(auth(supportToken))
      .send({ confirm: 'ANONYMISE', reason: 'not allowed' });
    expect(r.status).toBe(403);
  });

  it('finance role cannot change customer account fields (needs customers.write)', async () => {
    const r = await request(app)
      .patch(`/v1/admin/customers/${biz.id}/account`)
      .set(auth(financeToken))
      .send({ tags: ['nope'] });
    expect(r.status).toBe(403);
  });

  it('support role CAN read usage + notifications (customers.read)', async () => {
    const usage = await request(app)
      .get(`/v1/admin/customers/${biz.id}/usage`).set(auth(supportToken));
    expect(usage.status).toBe(200);
    const notes = await request(app)
      .get(`/v1/admin/customers/${biz.id}/notifications`).set(auth(supportToken));
    expect(notes.status).toBe(200);
  });
});

// ── 2. Overview + health ────────────────────────────────────────────────

describe('GET /v1/admin/overview', () => {
  it('returns the full vitals shape', async () => {
    const r = await request(app).get('/v1/admin/overview').set(auth(superToken));
    expect(r.status).toBe(200);

    expect(typeof r.body.mrrInr).toBe('number');
    expect(r.body.arrInr).toBeCloseTo(r.body.mrrInr * 12, 4);

    const c = r.body.counts;
    for (const k of ['customers', 'active', 'trialing', 'pastDue', 'signups7d',
      'signups30d', 'churned30d', 'openTickets', 'p1Tickets',
      'failedPayments24h', 'pendingRefunds']) {
      expect(typeof c[k]).toBe('number');
    }
    // Three businesses seeded, one of them past_due.
    expect(c.customers).toBeGreaterThanOrEqual(3);
    expect(c.pastDue).toBeGreaterThanOrEqual(1);
    // One payment_failed row was written in the last 24h.
    expect(c.failedPayments24h).toBeGreaterThanOrEqual(1);

    expect(r.body.revenue).toHaveProperty('thisMonthInr');
    expect(r.body.addons).toHaveProperty('attachRatePct');
    expect(Array.isArray(r.body.plans)).toBe(true);
    expect(Array.isArray(r.body.mrrTrend)).toBe(true);
    // 30-day signup trend is zero-filled → exactly one point per day.
    expect(r.body.signupTrend).toHaveLength(30);
    expect(r.body.signupTrend[0]).toHaveProperty('date');
    expect(r.body.signupTrend[0]).toHaveProperty('count');
  });

  it('surfaces the past-due tenant in needsAttention, worst first', async () => {
    const r = await request(app).get('/v1/admin/overview').set(auth(superToken));
    expect(r.status).toBe(200);
    const items = r.body.needsAttention;
    expect(Array.isArray(items)).toBe(true);

    const pastDue = items.find((x) => x.kind === 'past_due');
    expect(pastDue).toBeTruthy();
    expect(pastDue.businessId).toBe(dunningBiz.id);
    expect(pastDue.businessName).toBe('Ops Dunning');

    // Sorted critical → high → medium.
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    const seq = items.map((x) => rank[x.severity]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  it('MRR agrees with the legacy /metrics endpoint', async () => {
    const [ov, met] = await Promise.all([
      request(app).get('/v1/admin/overview').set(auth(superToken)),
      request(app).get('/v1/admin/metrics').set(auth(superToken)),
    ]);
    expect(ov.body.mrrInr).toBeCloseTo(met.body.mrrInr, 4);
  });
});

describe('GET /v1/admin/health/platform', () => {
  it('reports API, DB latency, redis, webhooks and cron without throwing', async () => {
    const r = await request(app).get('/v1/admin/health/platform').set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.api.ok).toBe(true);
    expect(r.body.db.ok).toBe(true);
    expect(typeof r.body.db.latencyMs).toBe('number');
    expect(r.body.redis).toHaveProperty('configured');
    expect(r.body.webhooks).toHaveProperty('received24h');
    expect(r.body.cron).toHaveProperty('jobs');
    // The test harness applies migrations directly (no _migrations
    // bookkeeping table), so this degrades to null rather than 500-ing.
    expect(r.body.migrations).toHaveProperty('applied');
  });
});

// ── 3. Usage vs limits ──────────────────────────────────────────────────

describe('usage vs plan limits', () => {
  it('per-customer usage reports every enforced metric', async () => {
    const r = await request(app)
      .get(`/v1/admin/customers/${biz.id}/usage`).set(auth(superToken));
    expect(r.status).toBe(200);
    const u = r.body.usage;
    expect(u.businessId).toBe(biz.id);
    expect(u.planTier).toBe('basic');
    const names = u.metrics.map((m) => m.metric).sort();
    expect(names).toEqual(['floors', 'menu_items', 'monthly_orders', 'staff', 'tables']);
    for (const m of u.metrics) {
      expect(typeof m.used).toBe('number');
      expect(typeof m.over).toBe('boolean');
    }
    // Fresh tenant, basic plan caps → nothing over.
    expect(u.overLimitCount).toBe(0);
  });

  it('flags a tenant that has blown past its staff cap', async () => {
    // basic seeds staff: 3. Add 4 non-owner staff to push it over.
    for (let i = 0; i < 4; i += 1) {
      const u = await query(
        `INSERT INTO users (email, display_name, google_sub)
         VALUES ($1, 'Staffer', $2) RETURNING id`,
        [`ops-staff-${i}@example.com`, `ops-staff-sub-${i}`],
      );
      await query(
        `INSERT INTO business_users (business_id, user_id, role, is_active)
         VALUES ($1, $2, 'staff_cashier', TRUE)`,
        [biz.id, u.rows[0].id],
      );
    }
    const r = await request(app)
      .get(`/v1/admin/customers/${biz.id}/usage`).set(auth(superToken));
    expect(r.status).toBe(200);
    const staff = r.body.usage.metrics.find((m) => m.metric === 'staff');
    expect(staff.used).toBe(4);
    expect(staff.limit).toBe(3);
    expect(staff.over).toBe(true);
    expect(r.body.usage.overLimitCount).toBeGreaterThanOrEqual(1);
  });

  it('platform usage table paginates and can filter to over-limit only', async () => {
    const all = await request(app).get('/v1/admin/reports/usage').set(auth(superToken));
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.rows)).toBe(true);
    expect(all.body.rows.length).toBeGreaterThanOrEqual(3);
    // Worst-first ordering.
    expect(all.body.rows[0].overLimitCount)
      .toBeGreaterThanOrEqual(all.body.rows[all.body.rows.length - 1].overLimitCount);

    const over = await request(app)
      .get('/v1/admin/reports/usage?overLimitOnly=true').set(auth(superToken));
    expect(over.status).toBe(200);
    expect(over.body.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of over.body.rows) expect(row.overLimitCount).toBeGreaterThan(0);
  });
});

// ── 4. Dunning ops ──────────────────────────────────────────────────────

describe('dunning / billing ops', () => {
  it('queue lists the past-due tenant with money at risk', async () => {
    const r = await request(app).get('/v1/admin/dunning').set(auth(financeToken));
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x) => x.businessId === dunningBiz.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('past_due');
    expect(row.dunningAttempts).toBe(2);
    expect(row.amountAtRiskInr).toBeGreaterThan(0);
    expect(row.lifetimeFailures).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.count).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.amountAtRiskInr).toBeGreaterThan(0);
  });

  it('timeline returns the seeded failure', async () => {
    const r = await request(app)
      .get(`/v1/admin/dunning/${dunningBiz.id}/timeline`).set(auth(financeToken));
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0]).toHaveProperty('event');
  });

  it('retry bumps the attempt counter and writes a manual_retry event', async () => {
    const r = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/retry`).set(auth(financeToken));
    expect(r.status).toBe(200);
    expect(r.body.attemptNo).toBe(3);

    const ev = await query(
      `SELECT * FROM dunning_events
        WHERE business_id = $1 AND event = 'manual_retry'`,
      [dunningBiz.id],
    );
    expect(ev.rowCount).toBe(1);

    const sub = await query(
      'SELECT dunning_attempts, status FROM subscriptions WHERE business_id = $1',
      [dunningBiz.id],
    );
    expect(sub.rows[0].dunning_attempts).toBe(3);
    // A nudge must NOT quietly restore service.
    expect(sub.rows[0].status).toBe('past_due');
  });

  it('waive requires a reason', async () => {
    const r = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/waive`)
      .set(auth(financeToken)).send({});
    expect(r.status).toBe(400);
  });

  it('waive reactivates, clears dunning, and creates NO invoice', async () => {
    const before = await query('SELECT COUNT(*)::int AS c FROM invoices WHERE business_id = $1', [dunningBiz.id]);
    const r = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/waive`)
      .set(auth(financeToken)).send({ reason: 'goodwill after outage' });
    expect(r.status).toBe(200);
    expect(r.body.subscription.status).toBe('active');
    expect(r.body.subscription.dunning_attempts).toBe(0);
    expect(r.body.subscription.last_dunning_at).toBeNull();

    const after = await query('SELECT COUNT(*)::int AS c FROM invoices WHERE business_id = $1', [dunningBiz.id]);
    // Nothing was collected → nothing may appear in revenue.
    expect(after.rows[0].c).toBe(before.rows[0].c);

    const ev = await query(
      'SELECT reason FROM dunning_events WHERE business_id = $1 AND event = \'waived\'',
      [dunningBiz.id],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].reason).toContain('goodwill after outage');
  });

  it('mark-paid writes a PAID invoice, reactivates, and logs recovery', async () => {
    // Put it back into the past-due state first.
    await query(
      'UPDATE subscriptions SET status = \'past_due\', dunning_attempts = 1 WHERE business_id = $1',
      [dunningBiz.id],
    );
    const r = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/mark-paid`)
      .set(auth(financeToken)).send({ amountPaise: 12345, reference: 'UTR-TEST-1' });
    expect(r.status).toBe(201);
    expect(r.body.invoice.status).toBe('paid');
    expect(Number(r.body.invoice.amount_paise)).toBe(12345);
    expect(r.body.invoice.paid_at).toBeTruthy();

    const sub = await query(
      'SELECT status, dunning_attempts FROM subscriptions WHERE business_id = $1',
      [dunningBiz.id],
    );
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].dunning_attempts).toBe(0);

    const ev = await query(
      `SELECT reason FROM dunning_events
        WHERE business_id = $1 AND event = 'recovered'`,
      [dunningBiz.id],
    );
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);
    expect(ev.rows.some((x) => (x.reason || '').includes('UTR-TEST-1'))).toBe(true);
  });

  it('mark-paid rejects a non-positive amount', async () => {
    const r = await request(app)
      .post(`/v1/admin/dunning/${dunningBiz.id}/mark-paid`)
      .set(auth(financeToken)).send({ amountPaise: 0 });
    expect(r.status).toBe(400);
  });

  it('every dunning mutation landed on the audit log', async () => {
    const r = await query(
      'SELECT action FROM audit_log WHERE module = \'dunning\' ORDER BY created_at',
    );
    const actions = r.rows.map((x) => x.action);
    expect(actions).toContain('retry');
    expect(actions).toContain('waive');
    expect(actions).toContain('mark-paid');
  });
});

// ── 5. Customer lifecycle actions ───────────────────────────────────────

describe('customer lifecycle actions', () => {
  it('PATCH /account sets the account owner + tags, and is a partial patch', async () => {
    const r = await request(app)
      .patch(`/v1/admin/customers/${biz.id}/account`)
      .set(auth(superToken))
      .send({ accountOwnerEmail: 'AE@NamastePOS.in', tags: ['Chain', 'chain', ' pilot '] });
    expect(r.status).toBe(200);
    expect(r.body.business.account_owner_email).toBe('ae@namastepos.in');
    // Normalised: lowercased, trimmed, de-duplicated.
    expect(r.body.business.tags.sort()).toEqual(['chain', 'pilot']);

    // Patching only the tags must NOT blank the account owner.
    const r2 = await request(app)
      .patch(`/v1/admin/customers/${biz.id}/account`)
      .set(auth(superToken)).send({ tags: ['high-touch'] });
    expect(r2.status).toBe(200);
    expect(r2.body.business.tags).toEqual(['high-touch']);
    expect(r2.body.business.account_owner_email).toBe('ae@namastepos.in');
  });

  it('PATCH /account rejects an empty body', async () => {
    const r = await request(app)
      .patch(`/v1/admin/customers/${biz.id}/account`)
      .set(auth(superToken)).send({});
    expect(r.status).toBe(400);
  });

  it('owner-email change updates business + user and revokes sessions', async () => {
    await query(
      `INSERT INTO refresh_tokens (business_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [biz.id, `hash-ops-${Date.now()}`],
    );
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/owner-email`)
      .set(auth(superToken)).send({ email: 'new-owner@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.business.email).toBe('new-owner@example.com');

    const u = await query(
      `SELECT u.email FROM business_users bu JOIN users u ON u.id = bu.user_id
        WHERE bu.business_id = $1 AND bu.role = 'business_owner'`,
      [biz.id],
    );
    expect(u.rows[0].email).toBe('new-owner@example.com');

    const live = await query(
      `SELECT COUNT(*)::int AS c FROM refresh_tokens
        WHERE business_id = $1 AND revoked_at IS NULL`,
      [biz.id],
    );
    expect(live.rows[0].c).toBe(0);
  });

  it('owner-email change 409s on a collision', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/owner-email`)
      .set(auth(superToken)).send({ email: 'ops-dunning@example.com' });
    expect(r.status).toBe(409);
  });

  it('reset-owner-credentials clears the MPIN + lockout', async () => {
    await query(
      `UPDATE business_users
          SET pin_hash = 'bcrypt-ish', pin_fail_count = 5,
              pin_locked_until = NOW() + INTERVAL '1 hour'
        WHERE business_id = $1 AND role = 'business_owner'`,
      [biz.id],
    );
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/reset-owner-credentials`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.mpinCleared).toBe(true);

    const bu = await query(
      `SELECT pin_hash, pin_fail_count, pin_locked_until FROM business_users
        WHERE business_id = $1 AND role = 'business_owner'`,
      [biz.id],
    );
    expect(bu.rows[0].pin_hash).toBeNull();
    expect(bu.rows[0].pin_fail_count).toBe(0);
    expect(bu.rows[0].pin_locked_until).toBeNull();
  });

  it('resend-welcome records a dispatch that the notification log then shows', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/resend-welcome`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.recipient).toBe('new-owner@example.com');

    const log = await request(app)
      .get(`/v1/admin/customers/${biz.id}/notifications`).set(auth(superToken));
    expect(log.status).toBe(200);
    expect(log.body.channel).toBe('email');
    expect(log.body.total).toBeGreaterThanOrEqual(1);
    expect(log.body.rows.some((x) => x.template.startsWith('onboarding_d0_resend_'))).toBe(true);
    // No SMTP in tests → the row is suppressed, not silently "sent".
    expect(log.body.rows[0].status).toBe('suppressed');
  });

  it('cancel-subscription defaults to period end, not immediate', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/cancel-subscription`)
      .set(auth(financeToken)).send({});
    expect(r.status).toBe(200);
    expect(r.body.subscription.cancel_at_period_end).toBe(true);
    // Service continues — the tenant paid for this period.
    expect(r.body.subscription.status).not.toBe('cancelled');
  });

  it('cancel-subscription immediate flips the status', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/cancel-subscription`)
      .set(auth(financeToken)).send({ immediate: true, reason: 'closing down' });
    expect(r.status).toBe(200);
    expect(r.body.subscription.status).toBe('cancelled');
  });
});

// ── 6. DPDP erasure ─────────────────────────────────────────────────────

describe('POST /v1/admin/customers/:id/anonymise', () => {
  it('refuses without the exact confirmation token', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${eraseBiz.id}/anonymise`)
      .set(auth(superToken)).send({ confirm: 'yes', reason: 'valid reason' });
    expect(r.status).toBe(400);
  });

  it('refuses without a reason', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${eraseBiz.id}/anonymise`)
      .set(auth(superToken)).send({ confirm: 'ANONYMISE' });
    expect(r.status).toBe(400);
  });

  it('anonymises users + business, retains financial rows, and audits', async () => {
    // A paid order that must SURVIVE the erasure (GST/tax retention).
    await query(
      `INSERT INTO orders (business_id, order_no, status, total)
       VALUES ($1, 9001, 'collected', 500)`,
      [eraseBiz.id],
    );

    const r = await request(app)
      .post(`/v1/admin/customers/${eraseBiz.id}/anonymise`)
      .set(auth(superToken))
      .send({ confirm: 'ANONYMISE', reason: 'DSR-2026-014 erasure request' });
    expect(r.status).toBe(200);
    expect(r.body.usersErased).toBeGreaterThanOrEqual(1);

    const b = await query(
      'SELECT name, email, phone, gstin, deleted_at FROM businesses WHERE id = $1',
      [eraseBiz.id],
    );
    expect(b.rows[0].name).toBe('Erased Business');
    expect(b.rows[0].email).toMatch(/^erased\+[0-9a-f]{16}@erased\.namastepos\.invalid$/);
    expect(b.rows[0].phone).toBeNull();
    expect(b.rows[0].deleted_at).not.toBeNull();

    const u = await query(
      `SELECT u.email, u.display_name, u.is_active
         FROM business_users bu JOIN users u ON u.id = bu.user_id
        WHERE bu.business_id = $1`,
      [eraseBiz.id],
    );
    expect(u.rows[0].display_name).toBe('Erased User');
    expect(u.rows[0].email).toMatch(/@erased\.namastepos\.invalid$/);

    // A completed DSR was filed for traceability.
    const dsr = await query(
      `SELECT COUNT(*)::int AS c FROM data_subject_requests
        WHERE request_type = 'erasure' AND status = 'completed'`,
    );
    expect(dsr.rows[0].c).toBeGreaterThanOrEqual(1);

    // Financial history retained.
    const orders = await query('SELECT COUNT(*)::int AS c FROM orders WHERE business_id = $1', [eraseBiz.id]);
    expect(orders.rows[0].c).toBeGreaterThanOrEqual(1);

    // Subscription cancelled + sessions revoked.
    const sub = await query('SELECT status FROM subscriptions WHERE business_id = $1', [eraseBiz.id]);
    expect(sub.rows[0].status).toBe('cancelled');

    const audit = await query(
      `SELECT COUNT(*)::int AS c FROM audit_log
        WHERE module = 'customers' AND action = 'anonymise' AND entity_id = $1`,
      [eraseBiz.id],
    );
    expect(audit.rows[0].c).toBe(1);
  });
});
