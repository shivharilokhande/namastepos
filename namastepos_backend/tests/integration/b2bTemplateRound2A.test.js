// Round 2 (2026-09-06) — B2B invoice template store (CONTRACTS §1).
//
// GET/PUT /v1/businesses/:id/b2b-invoice-template, gated on `b2b_invoice`
// (Pro+) for BOTH view and save; PUT additionally needs the owner or the
// `bill_template` staff permission.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const features = require('../../src/services/featureService');
const buildApp = require('../../src/app');

let app;
let starter; // no b2b_invoice
let pro; // b2b_invoice via override
let proToken;
let starterToken;
let kitchenToken; // pro business, staff without bill_template
let cashierToken; // pro business, cashier holds bill_template by default

async function makeStaff(bizId, role, tag) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await query(
    'INSERT INTO users (email, display_name, google_sub) VALUES ($1, $2, $3) RETURNING *',
    [`${tag}-${uniq}@example.com`, tag, `sub-${tag}-${uniq}`],
  );
  await query(
    'INSERT INTO business_users (business_id, user_id, role, is_active) VALUES ($1, $2, $3, TRUE)',
    [bizId, u.rows[0].id, role],
  );
  return issueAccessToken({ sub: u.rows[0].id, bid: bizId, email: u.rows[0].email, role });
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  starter = await makeBusiness({ email: `r2a-b2b-starter-${Date.now()}`, name: 'Starter' });
  pro = await makeBusiness({ email: `r2a-b2b-pro-${Date.now()}`, name: 'Pro' });
  starterToken = tokenFor(starter);
  proToken = tokenFor(pro);
  // Entitlement by feature KEY, never by tier code (tier-code trap).
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, 'b2b_invoice', TRUE)`,
    [pro.id],
  );
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, 'b2b_invoice', FALSE)`,
    [starter.id],
  );
  features.clearAllCaches();
  kitchenToken = await makeStaff(pro.id, 'staff_kitchen', 'cook');
  cashierToken = await makeStaff(pro.id, 'staff_cashier', 'till');
});
afterAll(async () => { await closePool(); });

const as = (t) => ({ Authorization: `Bearer ${t}` });
const url = (b, p = '/b2b-invoice-template') => `/v1/businesses/${b.id}${p}`;

describe('plan gate', () => {
  it('402 FEATURE_LOCKED for a tenant without b2b_invoice — on GET and PUT', async () => {
    const g = await request(app).get(url(starter)).set(as(starterToken));
    expect(g.status).toBe(402);
    expect(g.body.error).toBe('FEATURE_LOCKED');
    expect(g.body.feature).toBe('b2b_invoice');
    const p = await request(app).put(url(starter)).set(as(starterToken)).send({ terms: 'x' });
    expect(p.status).toBe(402);
  });
  it('401 without a token', async () => {
    const r = await request(app).get(url(pro));
    expect(r.status).toBe(401);
  });
});

describe('Pro tenant', () => {
  it('GET returns the full default shape when no row exists', async () => {
    const r = await request(app).get(url(pro)).set(as(proToken));
    expect(r.status).toBe(200);
    expect(r.body.template).toEqual({
      letterhead: '',
      terms: '',
      signatureUrl: '',
      bankDetails: '',
      showHsn: true,
      showEway: false,
    });
  });
  it('PUT upserts and a partial PUT keeps the other fields', async () => {
    const put = await request(app).put(url(pro)).set(as(proToken)).send({
      letterhead: 'Sharma Caterers Pvt Ltd\nGSTIN 27AAAAA0000A1Z5',
      terms: 'Net 15 days',
      bankDetails: 'HDFC 1234 IFSC HDFC0000001',
      showEway: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.template.letterhead).toMatch(/Sharma/);
    expect(put.body.template.showEway).toBe(true);
    expect(put.body.template.showHsn).toBe(true);

    const partial = await request(app).put(url(pro)).set(as(proToken)).send({ showHsn: false });
    expect(partial.status).toBe(200);
    expect(partial.body.template.showHsn).toBe(false);
    expect(partial.body.template.terms).toBe('Net 15 days'); // untouched
    expect(partial.body.template.letterhead).toMatch(/Sharma/);

    const get = await request(app).get(url(pro)).set(as(proToken));
    expect(get.body.template).toEqual(partial.body.template);
  });
  it('400s an unknown field and an over-long url', async () => {
    const bad = await request(app).put(url(pro)).set(as(proToken)).send({ footer: 'nope' });
    expect(bad.status).toBe(400);
    const long = await request(app).put(url(pro)).set(as(proToken))
      .send({ signatureUrl: `https://x/${'a'.repeat(600)}` });
    expect(long.status).toBe(400);
  });
  it('is tenant-scoped: the Pro owner cannot write the Starter template', async () => {
    const r = await request(app).put(url(starter)).set(as(proToken)).send({ terms: 'x' });
    expect([401, 403, 404]).toContain(r.status);
  });
});

describe('staff permission on PUT', () => {
  it('403s a kitchen token (no bill_template) on PUT but lets it GET', async () => {
    const g = await request(app).get(url(pro)).set(as(kitchenToken));
    expect(g.status).toBe(200);
    const p = await request(app).put(url(pro)).set(as(kitchenToken)).send({ terms: 'hijack' });
    expect(p.status).toBe(403);
  });
  it('lets a cashier (bill_template by default) PUT', async () => {
    const p = await request(app).put(url(pro)).set(as(cashierToken)).send({ terms: 'Net 30 days' });
    expect(p.status).toBe(200);
    expect(p.body.template.terms).toBe('Net 30 days');
  });
});
