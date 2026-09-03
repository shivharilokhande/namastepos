// Sprint 3 correctness fixes (2026-09-03):
//   NP-122 — settle discount cascades across the session's KOTs instead of
//            silently evaporating anything above the head order's total.
//   NP-123 — tax invoice honours the order's persisted round-off mode.
//   NP-124 — gift-card redeem accepts lowercase / padded codes.
//   NP-125 — multi-outlet owner gate re-checks the live DB role, not the JWT.
//   NP-126 — one-time impersonation handoff code (mint + atomic exchange).

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query, withTransaction } = require('../../src/config/db');
const { verifyAccessToken } = require('../../src/utils/jwt');

const tableService = require('../../src/services/tableService');
const taxInvoiceService = require('../../src/services/taxInvoiceService');
const giftCardService = require('../../src/services/giftCardService');
const adminTeam = require('../../src/services/adminTeamService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

// ── Fixtures ────────────────────────────────────────────────────────────

/** Floor + table + open session + N orders (totals in INR), oldest→newest. */
async function makeSessionWithOrders(biz, totalsInr, { orderNoStart = 1 } = {}) {
  const f = await query(
    `INSERT INTO floors (business_id, name) VALUES ($1, $2) RETURNING id`,
    [biz.id, `F-${orderNoStart}-${Math.random().toString(36).slice(2, 7)}`],
  );
  const t = await query(
    `INSERT INTO tables (business_id, floor_id, label) VALUES ($1, $2, $3) RETURNING id`,
    [biz.id, f.rows[0].id, `T${orderNoStart}`],
  );
  const s = await query(
    `INSERT INTO table_sessions (business_id, table_id, status)
     VALUES ($1, $2, 'open') RETURNING id`,
    [biz.id, t.rows[0].id],
  );
  const sessionId = s.rows[0].id;
  await query(
    `UPDATE tables SET status = 'occupied', current_session_id = $1 WHERE id = $2`,
    [sessionId, t.rows[0].id],
  );
  const orderIds = [];
  for (let i = 0; i < totalsInr.length; i += 1) {
    const o = await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, discount, total, table_session_id)
       VALUES ($1, $2, 'dineIn', $3, 0, 0, $3, $4) RETURNING id`,
      [biz.id, orderNoStart + i, totalsInr[i], sessionId],
    );
    orderIds.push(o.rows[0].id);
  }
  return { sessionId, orderIds };
}

async function sessionOrders(sessionId) {
  const r = await query(
    `SELECT id, order_no, total::float AS total, discount::float AS discount
       FROM orders WHERE table_session_id = $1 ORDER BY order_no ASC`,
    [sessionId],
  );
  return r.rows;
}

// ── NP-122: settle discount cascades across KOTs ────────────────────────

describe('NP-122 settle discount larger than the head order', () => {
  it('cascades oldest→newest; per-order discounts sum to exactly the applied discount', async () => {
    const biz = await makeBusiness({ email: 'np122a@example.com', name: 'NP122 A' });
    // 3 KOTs: ₹100 + ₹50 + ₹30 = ₹180. Discount ₹120 > head's ₹100.
    const { sessionId } = await makeSessionWithOrders(biz, [100, 50, 30]);

    const closed = await tableService.closeSession(biz.id, sessionId, null, 'cash', 120);

    const rows = await sessionOrders(sessionId);
    // Head fully absorbed (100), second takes the remaining 20, third untouched.
    expect(rows.map((r) => r.total)).toEqual([0, 30, 30]);
    expect(rows.map((r) => r.discount)).toEqual([100, 20, 0]);
    // Per-order discounts sum to EXACTLY the applied discount — nothing evaporates.
    expect(rows.reduce((s, r) => s + r.discount, 0)).toBeCloseTo(120, 2);
    // Payable = 180 − 120 = 60, and the closed session records it.
    expect(rows.reduce((s, r) => s + r.total, 0)).toBeCloseTo(60, 2);
    expect(closed.total_paise).toBe(6000);
    // No order ever went negative.
    rows.forEach((r) => expect(r.total).toBeGreaterThanOrEqual(0));
  });

  it('still caps the discount at the session total (bill never negative)', async () => {
    const biz = await makeBusiness({ email: 'np122b@example.com', name: 'NP122 B' });
    const { sessionId } = await makeSessionWithOrders(biz, [40, 25], { orderNoStart: 10 });

    const closed = await tableService.closeSession(biz.id, sessionId, null, 'cash', 500);

    const rows = await sessionOrders(sessionId);
    expect(rows.map((r) => r.total)).toEqual([0, 0]);
    // Recorded discount = what was actually given (₹65), not the asked ₹500.
    expect(rows.reduce((s, r) => s + r.discount, 0)).toBeCloseTo(65, 2);
    expect(closed.total_paise).toBe(0);
  });
});

// ── NP-123: invoice honours the order's persisted round-off ─────────────

describe('NP-123 tax invoice round-off', () => {
  async function makeOrderWithItem(biz, {
    orderNo, subtotal, tax, total, roundOffPaise,
  }) {
    const o = await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, discount, total,
          round_off_paise, status, collected_at)
       VALUES ($1, $2, 'takeaway', $3, $4, 0, $5, $6, 'collected', NOW())
       RETURNING id`,
      [biz.id, orderNo, subtotal, tax, total, roundOffPaise],
    );
    await query(
      `INSERT INTO order_items (order_id, menu_item_id, name, price, qty, gst_pct, gst_amount)
       VALUES ($1, NULL, 'Paneer Tikka', $2, 1, 5, $3)`,
      [o.rows[0].id, subtotal, tax],
    );
    return o.rows[0].id;
  }

  it('round-off none: invoice total preserves paise and matches the collected total', async () => {
    const biz = await makeBusiness({ email: 'np123a@example.com', name: 'NP123 A' });
    // Collected ₹99.75 with round-off disabled (round_off_paise = 0).
    const orderId = await makeOrderWithItem(biz, {
      orderNo: 1, subtotal: 95, tax: 4.75, total: 99.75, roundOffPaise: 0,
    });

    const inv = await taxInvoiceService.issueFromOrder(biz.id, orderId);
    // Before the fix this force-rounded to ₹100.00 despite ₹99.75 collected.
    expect(inv.totalInr).toBeCloseTo(99.75, 2);
    expect(inv.roundOffInr).toBeCloseTo(0, 2);
  });

  it('round-off nearest: invoice reuses the persisted round-off amount', async () => {
    const biz = await makeBusiness({ email: 'np123b@example.com', name: 'NP123 B' });
    // Pre-round ₹99.75 → collected ₹100.00, round_off_paise = +25.
    const orderId = await makeOrderWithItem(biz, {
      orderNo: 2, subtotal: 95, tax: 4.75, total: 100, roundOffPaise: 25,
    });

    const inv = await taxInvoiceService.issueFromOrder(biz.id, orderId);
    expect(inv.totalInr).toBeCloseTo(100, 2);
    expect(inv.roundOffInr).toBeCloseTo(0.25, 2);
  });
});

// ── NP-124: gift-card redeem normalizes the code ────────────────────────

describe('NP-124 gift-card redeem code normalization', () => {
  // NOTE: fixture rows are inserted directly (with both the migration-020 and
  // migration-046 column names) because gift_cards still carries NOT NULL
  // initial_paise/remaining_paise from 020 that issueGiftCard() doesn't fill —
  // a pre-existing latent issue, out of scope for this ticket.
  async function makeCard(biz, code, paise) {
    const r = await query(
      `INSERT INTO gift_cards
         (business_id, code, initial_paise, remaining_paise, face_value_paise, balance_paise)
       VALUES ($1, $2, $3, $3, $4, $4) RETURNING *`,
      [biz.id, code, paise, paise],
    );
    return r.rows[0];
  }

  it('redeem() accepts a lowercase-entered code', async () => {
    const biz = await makeBusiness({ email: 'np124a@example.com', name: 'NP124 A' });
    const card = await makeCard(biz, 'AAAA-BBBB-CCCC-2345', 5000);

    const r = await giftCardService.redeem(biz.id, {
      giftCardCode: card.code.toLowerCase(), amountInr: 10,
    });
    expect(r.source).toBe('gift_card');
    expect(r.remaining).toBeCloseTo(40, 2);
  });

  it('redeemTx() accepts a lowercase code with padding', async () => {
    const biz = await makeBusiness({ email: 'np124b@example.com', name: 'NP124 B' });
    const card = await makeCard(biz, 'DDDD-EEEE-FFFF-6789', 5000);

    const r = await withTransaction((client) => giftCardService.redeemTx(client, biz.id, {
      giftCardCode: `  ${card.code.toLowerCase()}  `, amountInr: 5,
    }));
    expect(r.source).toBe('gift_card');
    expect(r.remaining).toBeCloseTo(45, 2);
  });
});

// ── NP-125: multi-outlet owner gate uses the live DB role ───────────────

describe('NP-125 requireOwner re-checks the DB role', () => {
  it('a stale business_owner JWT whose DB role was demoted gets 403', async () => {
    const biz = await makeBusiness({ email: 'np125a@example.com', name: 'NP125 A' });
    const staleOwnerToken = tokenFor(biz); // claims role: business_owner
    // Demote BEFORE the first request so the 30s role cache never holds 'owner'.
    await query(
      `UPDATE business_users SET role = 'staff_cashier'
        WHERE business_id = $1 AND user_id = $2`,
      [biz.id, biz._owner.id],
    );

    const r = await request(app)
      .get('/v1/outlet-groups')
      .set('Authorization', `Bearer ${staleOwnerToken}`);
    expect(r.status).toBe(403);
  });

  it('a genuine owner still passes', async () => {
    const biz = await makeBusiness({ email: 'np125b@example.com', name: 'NP125 B' });
    const r = await request(app)
      .get('/v1/outlet-groups')
      .set('Authorization', `Bearer ${tokenFor(biz)}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.groups)).toBe(true);
  });
});

// ── NP-126: one-time impersonation handoff code ─────────────────────────

describe('NP-126 impersonation handoff code', () => {
  let adminToken;
  let biz;

  beforeAll(async () => {
    biz = await makeBusiness({ email: 'np126-target@example.com', name: 'NP126 Target' });
    await adminTeam.create({
      email: 'np126-admin@namastepos.in',
      password: 'a-long-admin-password-123',
      displayName: 'NP126 Admin',
      role: 'super_admin',
    });
    const login = await adminTeam.login('np126-admin@namastepos.in', 'a-long-admin-password-123');
    adminToken = login.token;
  });

  async function mintCode() {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/impersonation-code`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(201);
    expect(typeof r.body.code).toBe('string');
    expect(r.body.code.length).toBeGreaterThanOrEqual(32);
    return r.body.code;
  }

  it('exchanges once for a tenant token bound to the right business, then 401s on reuse', async () => {
    const code = await mintCode();

    const first = await request(app)
      .post('/v1/auth/impersonation-exchange')
      .send({ code });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.business.id).toBe(biz.id);
    const payload = verifyAccessToken(first.body.accessToken);
    expect(payload.bid).toBe(biz.id);
    expect(payload.imp).toBe(true); // read-only impersonation token, same as legacy flow

    // Second exchange of the SAME code — atomically claimed already.
    const second = await request(app)
      .post('/v1/auth/impersonation-exchange')
      .send({ code });
    expect(second.status).toBe(401);
  });

  it('401s on an expired code', async () => {
    const code = await mintCode();
    await query(
      `UPDATE impersonation_codes SET expires_at = NOW() - INTERVAL '1 second'
        WHERE used_at IS NULL`,
    );
    const r = await request(app)
      .post('/v1/auth/impersonation-exchange')
      .send({ code });
    expect(r.status).toBe(401);
  });

  it('401s on a code that never existed', async () => {
    const r = await request(app)
      .post('/v1/auth/impersonation-exchange')
      .send({ code: 'this-code-was-never-minted-000000000000' });
    expect(r.status).toBe(401);
  });

  it('the legacy /impersonate endpoint still works (back-compat)', async () => {
    const r = await request(app)
      .post(`/v1/admin/customers/${biz.id}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
  });
});
