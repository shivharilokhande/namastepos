// Round 2 (2026-09-06) — staff permissions on the POS surfaces (CONTRACTS §7).
//
// Until this batch every ACTIVE member of a business could create, list and
// cancel orders, seat tables and rewrite diners straight from the API; only
// the mobile drawer hid the screens. These tests pin the gate for each role's
// DEFAULT grants (staffService.DEFAULT_PERMS_BY_ROLE):
//
//   kitchen  → home, kds                       : no orders, no tables, no customers
//   waiter   → home, pos, tables, captain      : create + read orders, seat tables
//   cashier  → …, pos, orders, customers       : everything on the till
//   manager  → everything
//
// plus the till-skim rule: cancelling a COLLECTED (paid) order is owner or
// manager only, and the api_key principal is read-only via the wrapper.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const buildApp = require('../../src/app');

let app;
let biz;
let ownerToken;
let kitchenToken;
let waiterToken;
let cashierToken;
let managerToken;
let chaiId;

async function makeStaff(role, tag = role) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await query(
    `INSERT INTO users (email, display_name, google_sub)
     VALUES ($1, $2, $3) RETURNING *`,
    [`${tag}-${uniq}@example.com`, tag, `sub-${tag}-${uniq}`],
  );
  await query(
    `INSERT INTO business_users (business_id, user_id, role, is_active)
     VALUES ($1, $2, $3, TRUE)`,
    [biz.id, u.rows[0].id, role],
  );
  return issueAccessToken({ sub: u.rows[0].id, bid: biz.id, email: u.rows[0].email, role });
}

const url = (p) => `/v1/businesses/${biz.id}${p}`;
const as = (t) => ({ Authorization: `Bearer ${t}` });

async function createOrder(token, extra = {}) {
  return request(app).post(url('/orders')).set(as(token)).send({
    items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 1 }],
    tax: 0,
    paymentMethod: 'cash',
    ...extra,
  });
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `r2a-perms-${Date.now()}`, name: 'Perm Orders' });
  ownerToken = tokenFor(biz);
  kitchenToken = await makeStaff('staff_kitchen', 'cook');
  waiterToken = await makeStaff('staff_waiter', 'waiter');
  cashierToken = await makeStaff('staff_cashier', 'till');
  managerToken = await makeStaff('staff_manager', 'mgr');
  const chai = await request(app).post(url('/menu')).set(as(ownerToken))
    .send({ name: 'Chai', price: 15, stock: 1000, gstPct: 0 });
  chaiId = chai.body.item.id;
  await query(
    `INSERT INTO cancel_reasons (business_id, code, label) VALUES ($1, 'other', 'Other')
     ON CONFLICT DO NOTHING`,
    [biz.id],
  );
});
afterAll(async () => { await closePool(); });

describe('POST /orders needs `pos`', () => {
  it('403s a kitchen token', async () => {
    const r = await createOrder(kitchenToken);
    expect(r.status).toBe(403);
  });
  it('lets a waiter (pos, no orders) ring a bill', async () => {
    const r = await createOrder(waiterToken);
    expect(r.status).toBe(201);
  });
  it('lets the owner ring a bill', async () => {
    const r = await createOrder(ownerToken);
    expect(r.status).toBe(201);
  });
});

describe('GET /orders needs `orders` or `pos`', () => {
  it('403s a kitchen token on the list and on a detail', async () => {
    const list = await request(app).get(url('/orders')).set(as(kitchenToken));
    expect(list.status).toBe(403);
    const created = await createOrder(ownerToken);
    const det = await request(app).get(url(`/orders/${created.body.order.id}`)).set(as(kitchenToken));
    expect(det.status).toBe(403);
  });
  it('lets a waiter read back the bills they can ring', async () => {
    const r = await request(app).get(url('/orders')).set(as(waiterToken));
    expect(r.status).toBe(200);
  });
  it('lets a cashier read the list', async () => {
    const r = await request(app).get(url('/orders')).set(as(cashierToken));
    expect(r.status).toBe(200);
  });
});

describe('PUT /orders/:id/status needs `orders` or `kds`', () => {
  it('lets the kitchen mark an order ready', async () => {
    const created = await createOrder(ownerToken);
    const r = await request(app).put(url(`/orders/${created.body.order.id}/status`))
      .set(as(kitchenToken)).send({ status: 'ready' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('ready');
  });
  it('403s a waiter (pos only) on a status flip', async () => {
    const created = await createOrder(ownerToken);
    const r = await request(app).put(url(`/orders/${created.body.order.id}/status`))
      .set(as(waiterToken)).send({ status: 'ready' });
    expect(r.status).toBe(403);
  });
  it('lets a cashier cancel a PENDING order', async () => {
    const created = await createOrder(ownerToken);
    const r = await request(app).put(url(`/orders/${created.body.order.id}/status`))
      .set(as(cashierToken)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('cancelled');
  });
});

describe('cancelling a COLLECTED order is owner or manager only', () => {
  async function collectedOrder() {
    const created = await createOrder(ownerToken);
    const id = created.body.order.id;
    const c = await request(app).put(url(`/orders/${id}/status`))
      .set(as(ownerToken)).send({ status: 'collected' });
    expect(c.status).toBe(200);
    return id;
  }
  it('403s a cashier with OWNER_OR_MANAGER_REQUIRED (till-skim vector)', async () => {
    const id = await collectedOrder();
    const r = await request(app).put(url(`/orders/${id}/status`))
      .set(as(cashierToken)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('OWNER_OR_MANAGER_REQUIRED');
    const still = await query('SELECT status FROM orders WHERE id = $1', [id]);
    expect(still.rows[0].status).toBe('collected');
  });
  it('403s the kitchen even though it holds `kds`', async () => {
    const id = await collectedOrder();
    const r = await request(app).put(url(`/orders/${id}/status`))
      .set(as(kitchenToken)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('OWNER_OR_MANAGER_REQUIRED');
  });
  it('lets a manager do it', async () => {
    const id = await collectedOrder();
    const r = await request(app).put(url(`/orders/${id}/status`))
      .set(as(managerToken)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('cancelled');
  });
  it('lets the owner do it', async () => {
    const id = await collectedOrder();
    const r = await request(app).put(url(`/orders/${id}/status`))
      .set(as(ownerToken)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(200);
  });
  it('does not consult the JWT role — a forged owner claim on a cashier row is refused', async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const u = await query(
      'INSERT INTO users (email, display_name, google_sub) VALUES ($1, \'Liar\', $2) RETURNING *',
      [`liar-${uniq}@example.com`, `sub-liar-${uniq}`],
    );
    await query(
      `INSERT INTO business_users (business_id, user_id, role, is_active)
       VALUES ($1, $2, 'staff_cashier', TRUE)`,
      [biz.id, u.rows[0].id],
    );
    const forged = issueAccessToken({
      sub: u.rows[0].id, bid: biz.id, email: u.rows[0].email, role: 'business_owner',
    });
    const id = await collectedOrder();
    const r = await request(app).put(url(`/orders/${id}/status`))
      .set(as(forged)).send({ status: 'cancelled', reasonCode: 'other' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('OWNER_OR_MANAGER_REQUIRED');
  });
});

describe('table sessions need `tables`', () => {
  let tableId;
  beforeAll(async () => {
    const fl = await request(app).post(url('/ops/floors')).set(as(ownerToken)).send({ name: 'Ground' });
    const t = await request(app).post(url('/ops/tables')).set(as(ownerToken))
      .send({ floorId: fl.body.floor?.id, label: 'T1', seats: 4 });
    tableId = t.body.table?.id;
    expect(tableId).toBeTruthy();
  });
  it('403s a cashier (no `tables` by default) and the kitchen on seat', async () => {
    for (const t of [cashierToken, kitchenToken]) {
      const r = await request(app).post(url(`/ops/tables/${tableId}/sessions`)).set(as(t)).send({});
      expect(r.status).toBe(403);
    }
  });
  it('lets a waiter seat and then abandon the table', async () => {
    const seat = await request(app).post(url(`/ops/tables/${tableId}/sessions`)).set(as(waiterToken)).send({});
    expect([200, 201]).toContain(seat.status);
    const sessionId = seat.body.session?.id;
    expect(sessionId).toBeTruthy();
    const ab = await request(app).post(url(`/ops/sessions/${sessionId}/abandon`)).set(as(waiterToken)).send({});
    expect([200, 204]).toContain(ab.status);
  });
  it('403s the kitchen on abandon', async () => {
    const seat = await request(app).post(url(`/ops/tables/${tableId}/sessions`)).set(as(ownerToken)).send({});
    const sessionId = seat.body.session?.id;
    const r = await request(app).post(url(`/ops/sessions/${sessionId}/abandon`)).set(as(kitchenToken)).send({});
    expect(r.status).toBe(403);
    await request(app).post(url(`/ops/sessions/${sessionId}/abandon`)).set(as(ownerToken)).send({});
  });
});

describe('customers need `customers`', () => {
  beforeAll(async () => {
    // The CRM router also needs the loyalty feature; grant it by override.
    await query(
      `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
       VALUES ($1, 'loyalty', TRUE) ON CONFLICT DO NOTHING`,
      [biz.id],
    );
    require('../../src/services/featureService').clearCache(biz.id);
  });
  it('403s the kitchen and a waiter on list, upsert and patch', async () => {
    for (const t of [kitchenToken, waiterToken]) {
      const list = await request(app).get(url('/customers')).set(as(t));
      expect(list.status).toBe(403);
      const up = await request(app).post(url('/customers')).set(as(t))
        .send({ phone: '9876500001', name: 'Nope' });
      expect(up.status).toBe(403);
    }
  });
  it('lets a cashier upsert, list and patch', async () => {
    const up = await request(app).post(url('/customers')).set(as(cashierToken))
      .send({ phone: '9876500002', name: 'Regular' });
    expect([200, 201]).toContain(up.status);
    const id = up.body.customer?.id;
    expect(id).toBeTruthy();
    const list = await request(app).get(url('/customers')).set(as(cashierToken));
    expect(list.status).toBe(200);
    const patch = await request(app).patch(url(`/customers/${id}`)).set(as(cashierToken))
      .send({ name: 'Regular Renamed' });
    expect(patch.status).toBe(200);
    // Waiter cannot rewrite the diner the cashier just created.
    const bad = await request(app).patch(url(`/customers/${id}`)).set(as(waiterToken))
      .send({ name: 'Hijacked' });
    expect(bad.status).toBe(403);
  });
  it('DELETE stays owner-only (a manager is refused)', async () => {
    const up = await request(app).post(url('/customers')).set(as(ownerToken))
      .send({ phone: '9876500003', name: 'Temp' });
    const r = await request(app).delete(url(`/customers/${up.body.customer.id}`)).set(as(managerToken));
    expect(r.status).toBe(403);
  });
});

describe('api_key principal through the wrapper (unit)', () => {
  const requireStaffPerm = require('../../src/middleware/requireStaffPerm');
  const run = (mw, req) => new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err || null));
  });
  const key = { role: 'api_key', businessId: 'b', apiKeyId: 'k', readOnly: true };
  it('passes a GET that needs orders / customers / reports / menu_editor', async () => {
    for (const perm of [['orders', 'pos'], 'customers', 'reports', 'menu_editor']) {
      const err = await run(requireStaffPerm(perm), { method: 'GET', user: { ...key }, params: { businessId: 'b' } });
      expect(err).toBeNull();
    }
  });
  it('403s a GET on anything else (pos-only, staff, expenses, tax_invoices)', async () => {
    for (const perm of ['pos', 'expenses', 'tax_invoices', ['tables']]) {
      const err = await run(requireStaffPerm(perm), { method: 'GET', user: { ...key }, params: { businessId: 'b' } });
      expect(err?.statusCode).toBe(403);
    }
  });
  it('403s every write, even on a permission it may read', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const err = await run(requireStaffPerm('orders'), { method, user: { ...key }, params: { businessId: 'b' } });
      expect(err?.statusCode).toBe(403);
    }
  });
});
