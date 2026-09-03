// Tenant financial-data privacy + outlet visibility in the admin console
// (2026-09-03, founder-driven).
//
// Covers:
//   1. GET /admin/customers/:id/drilldown returns NO tenant order rows and no
//      diner name/phone anywhere in the payload; `orderStats` aggregates are
//      present and correct.
//   2. The drilldown / getCustomer no longer leak the tenant's payout bank
//      account, IFSC or e-invoice credentials.
//   3. GET /admin/customers/:id/order/:orderId is super-admin only
//      (settings.write), masks diner PII, and writes an audit_log row.
//   4. Platform staff cannot list a tenant's diners through the tenant API.
//   5. Outlet visibility: the customers list + drilldown describe HQ / outlet /
//      standalone tenants.

jest.setTimeout(120000);

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { issueAccessToken } = require('../../src/utils/jwt');
const { query } = require('../../src/config/db');

let app;
let hq; let outlet; let solo;
let superToken; let supportToken;
let orderId;

const DINER_NAME = 'Rajesh Kumar Verma';
const DINER_PHONE = '9812345678';
const BANK_ACCOUNT = '112233445566';

async function makeAdmin(email, role) {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ($1, 'x-not-a-real-hash', $2, TRUE) RETURNING id, email, role`,
    [email, role]
  );
  return issueAccessToken({
    sid: r.rows[0].id,
    isSuperAdmin: true,
    email: r.rows[0].email,
    role: r.rows[0].role,
  });
}

async function giveFreeSubscription(businessId) {
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, (SELECT id FROM plans WHERE tier = 'free'), 'active',
             NOW() + INTERVAL '30 days')
     ON CONFLICT (business_id) DO NOTHING`,
    [businessId]
  );
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await resetDb();
  app = buildApp();

  hq     = await makeBusiness({ email: 'privacy-hq@example.com',     name: 'Sharma Dhaba HQ' });
  outlet = await makeBusiness({ email: 'privacy-outlet@example.com', name: 'Sharma Dhaba Andheri' });
  solo   = await makeBusiness({ email: 'privacy-solo@example.com',   name: 'Solo Tea Stall' });
  await Promise.all([
    giveFreeSubscription(hq.id), giveFreeSubscription(outlet.id), giveFreeSubscription(solo.id),
  ]);

  // Outlet group: hq is the parent, outlet is a branch.
  const g = await query(
    `INSERT INTO outlet_groups (name, parent_business_id) VALUES ($1, $2) RETURNING id`,
    ['Sharma Dhaba Group', hq.id]
  );
  await query(
    `UPDATE businesses SET outlet_group_id = $1 WHERE id = ANY($2::uuid[])`,
    [g.rows[0].id, [hq.id, outlet.id]]
  );
  await query(
    `UPDATE businesses SET outlet_label = 'Andheri West' WHERE id = $1`, [outlet.id]
  );

  // Tenant money detail that must never reach the admin API.
  await query(
    `UPDATE businesses SET bank_account = $1, bank_ifsc = 'HDFC0001234' WHERE id = $2`,
    [BANK_ACCOUNT, hq.id]
  );

  // A tenant order carrying diner PII. Inserted directly so the test does not
  // depend on the ordering pipeline.
  const o = await query(
    `INSERT INTO orders (business_id, order_no, source, customer_name, customer_phone,
                         subtotal, tax, discount, total, status)
     VALUES ($1, 1001, 'dineIn', $2, $3, 500, 25, 0, 525, 'collected')
     RETURNING id`,
    [hq.id, DINER_NAME, DINER_PHONE]
  );
  orderId = o.rows[0].id;
  await query(
    `INSERT INTO orders (business_id, order_no, source, customer_name, customer_phone,
                         subtotal, tax, discount, total, status)
     VALUES ($1, 1002, 'dineIn', $2, $3, 200, 10, 0, 210, 'cancelled')`,
    [hq.id, DINER_NAME, DINER_PHONE]
  );
  await query(
    `INSERT INTO order_items (order_id, menu_item_id, name, price, qty, note)
     VALUES ($1, NULL, 'Paneer Tikka', 250, 2, 'less spicy')`,
    [orderId]
  );

  superToken   = await makeAdmin('privacy-super@namastepos.in',   'super_admin');
  supportToken = await makeAdmin('privacy-support@namastepos.in', 'support');
});

afterAll(async () => { await closePool(); });

describe('drilldown redacts the tenant sales ledger', () => {
  let body;
  beforeAll(async () => {
    const r = await request(app)
      .get(`/v1/admin/customers/${hq.id}/drilldown`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    body = r.body;
  });

  it('returns no per-order rows at all', () => {
    expect(body.orders).toBeUndefined();
    // Nothing else may smuggle order rows back in under a different key.
    for (const [key, value] of Object.entries(body)) {
      if (!Array.isArray(value)) continue;
      for (const row of value) {
        if (row && typeof row === 'object') {
          expect(row).not.toHaveProperty('order_no');
          expect(row).not.toHaveProperty('orderNo');
        }
      }
    }
  });

  it('leaks no diner name or phone anywhere in the payload', () => {
    const json = JSON.stringify(body);
    expect(json).not.toContain(DINER_NAME);
    expect(json).not.toContain(DINER_PHONE);
    expect(json).not.toContain('customer_name');
    expect(json).not.toContain('customer_phone');
  });

  it('leaks no tenant payout bank details or e-invoice credentials', () => {
    const json = JSON.stringify(body);
    expect(json).not.toContain(BANK_ACCOUNT);
    expect(json).not.toContain('HDFC0001234');
    expect(body.business).not.toHaveProperty('bank_account');
    expect(body.business).not.toHaveProperty('bank_ifsc');
    expect(body.business).not.toHaveProperty('einvoice_password_enc');
    // A last-4 hint is intentional: support can confirm the account on file.
    expect(body.business.bankAccountLast4).toBe(BANK_ACCOUNT.slice(-4));
    expect(body.business.bankDetailsOnFile).toBe(true);
  });

  it('returns aggregates instead', () => {
    const s = body.orderStats;
    expect(s).toBeDefined();
    expect(s.orderCount).toBe(1);          // the cancelled one is excluded
    expect(s.cancelledCount).toBe(1);
    expect(s.grossVolumeInr).toBeCloseTo(525, 2);
    expect(s.avgTicketInr).toBeCloseTo(525, 2);
    expect(s.lastOrderAt).toBeTruthy();
    expect(Array.isArray(s.revenueByMonth)).toBe(true);
    expect(s.revenueByMonth.length).toBeGreaterThan(0);
    expect(s.revenueByMonth[s.revenueByMonth.length - 1].orders).toBe(1);
  });

  it('keeps what the tenant owes US visible', () => {
    expect(body.subscription).toBeTruthy();
    expect(Array.isArray(body.invoices)).toBe(true);
    expect(Array.isArray(body.payments)).toBe(true);
    expect(Array.isArray(body.notes)).toBe(true);
    expect(Array.isArray(body.staff)).toBe(true);
  });
});

describe('GET /admin/customers/:id — money detail redaction', () => {
  it('does not return bank details on the plain customer endpoint', async () => {
    const r = await request(app)
      .get(`/v1/admin/customers/${hq.id}`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.customer).not.toHaveProperty('bank_account');
    expect(r.body.customer).not.toHaveProperty('bank_ifsc');
    expect(JSON.stringify(r.body)).not.toContain(BANK_ACCOUNT);
  });
});

describe('single-order support lookup', () => {
  const url = (bid, oid) => `/v1/admin/customers/${bid}/order/${oid}`;

  it('rejects an unauthenticated caller', async () => {
    const r = await request(app).get(url(hq.id, orderId));
    expect(r.status).toBe(401);
  });

  it('rejects the tenant owner', async () => {
    const r = await request(app).get(url(hq.id, orderId))
      .set(auth(tokenFor(hq)));
    expect([401, 403]).toContain(r.status);
  });

  it('rejects a support admin (settings.write is super_admin only)', async () => {
    const r = await request(app).get(url(hq.id, orderId))
      .set(auth(supportToken));
    expect(r.status).toBe(403);
  });

  it('allows super_admin, masks diner PII, and writes an audit row', async () => {
    const before = await query(
      `SELECT COUNT(*)::int AS c FROM audit_log
        WHERE action = 'tenant-order-lookup' AND entity_id = $1`, [orderId]
    );

    const r = await request(app).get(`${url(hq.id, orderId)}?reason=TKT-42`)
      .set(auth(superToken));
    expect(r.status).toBe(200);

    const o = r.body.order;
    expect(o.orderNo).toBe(1001);
    expect(o.total).toBeCloseTo(525, 2);
    expect(o.items).toHaveLength(1);
    expect(o.items[0].name).toBe('Paneer Tikka');

    // Masked, never raw.
    expect(o.diner.initials).toBe('R.K.V.');
    expect(o.diner.phoneLast4).toBe('••••5678');
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(DINER_NAME);
    expect(json).not.toContain(DINER_PHONE);
    expect(o).not.toHaveProperty('customerName');
    expect(o).not.toHaveProperty('customerPhone');

    // Audited — the row exists by the time the response is sent.
    const after = await query(
      `SELECT business_id, module, payload FROM audit_log
        WHERE action = 'tenant-order-lookup' AND entity_id = $1
        ORDER BY created_at DESC`, [orderId]
    );
    expect(after.rowCount).toBe(before.rows[0].c + 1);
    expect(after.rows[0].business_id).toBe(hq.id);
    expect(after.rows[0].module).toBe('customers');
    expect(after.rows[0].payload?.reason).toBe('TKT-42');
  });

  it('is tenant-scoped — another customer id 404s on the same order', async () => {
    const r = await request(app).get(url(solo.id, orderId))
      .set(auth(superToken));
    expect(r.status).toBe(404);
  });
});

describe('platform staff cannot browse a tenant diner CRM', () => {
  // Entitle the tenant to `loyalty` first, otherwise the addon gate 402s and
  // we would not actually be exercising the noPlatformStaff guard.
  beforeAll(async () => {
    const r = await request(app)
      .put(`/v1/admin/customers/${hq.id}/feature-overrides`)
      .set(auth(superToken))
      .send({ overrides: [{ featureKey: 'loyalty', mode: 'enable' }] });
    expect(r.status).toBe(200);
  });

  it('the tenant owner CAN read their own diner CRM (control)', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${hq.id}/customers`)
      .set(auth(tokenFor(hq)));
    expect(r.status).toBe(200);
  });

  it('403s a plain super-admin token on the tenant customers API', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${hq.id}/customers`)
      .set(auth(superToken));
    expect(r.status).toBe(403);
    // The systemic gate in requireBusinessOwnership now answers first (platform
    // staff are denied the tenant API by default); the per-route noPlatformStaff
    // patch remains as defence in depth. Either message is a valid denial.
    expect(JSON.stringify(r.body)).toMatch(/end-customer|Platform staff cannot read tenant/i);
  });

  it('403s a support admin too', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${hq.id}/customers`)
      .set(auth(supportToken));
    expect(r.status).toBe(403);
  });
});

describe('outlet visibility', () => {
  it('the customers list labels HQ, outlet and standalone tenants', async () => {
    const r = await request(app)
      .get('/v1/admin/customers?limit=200')
      .set(auth(superToken));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.customers.map((c) => [c.id, c]));

    expect(byId[hq.id].outlet).toBeTruthy();
    expect(byId[hq.id].outlet.isParent).toBe(true);
    expect(byId[hq.id].outlet.siblingCount).toBe(1);
    expect(byId[hq.id].outlet.groupName).toBe('Sharma Dhaba Group');

    expect(byId[outlet.id].outlet.isParent).toBe(false);
    expect(byId[outlet.id].outlet.parentBusinessId).toBe(hq.id);
    expect(byId[outlet.id].outlet.parentName).toBe('Sharma Dhaba HQ');
    expect(byId[outlet.id].outlet.label).toBe('Andheri West');

    expect(byId[solo.id].outlet).toBeNull();
  });

  it('the drilldown header data names the group and lists siblings', async () => {
    const r = await request(app)
      .get(`/v1/admin/customers/${outlet.id}/drilldown`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.business.outlet.parentBusinessId).toBe(hq.id);
    expect(r.body.business.outletSiblings).toHaveLength(1);
    expect(r.body.business.outletSiblings[0].id).toBe(hq.id);
    expect(r.body.business.outletSiblings[0].isParent).toBe(true);
  });

  it('a standalone tenant has a null outlet block and no siblings', async () => {
    const r = await request(app)
      .get(`/v1/admin/customers/${solo.id}/drilldown`)
      .set(auth(superToken));
    expect(r.status).toBe(200);
    expect(r.body.business.outlet).toBeNull();
    expect(r.body.business.outletSiblings).toEqual([]);
  });
});
