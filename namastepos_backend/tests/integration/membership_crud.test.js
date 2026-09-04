// Regression test for membership plan CRUD (2026-08-24).
// Before this, only Create + Read existed; Update + Delete were added so the
// owner can fix a plan's price/validity/bundle or retire it.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');

let app; let business; let
  token;
beforeAll(async () => {
  await resetDb();
  app = require('../../src/app')();
  business = await makeBusiness({ email: `mem-${Date.now()}` });
  token = tokenFor(business);
  // /memberships is plan-gated on the `memberships` feature. The test business
  // resolves to the free/starter tier, so grant that tier the feature here so
  // the gate lets the CRUD calls through (we're testing CRUD, not gating).
  await query(
    `INSERT INTO plan_features (tier_kind, feature_key) VALUES ('starter','memberships'), ('free','memberships')
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const base = () => `/v1/businesses/${business.id}/memberships`;

describe('Membership plan CRUD', () => {
  let id;

  it('creates a plan', async () => {
    const r = await request(app).post(base()).set(auth())
      .send({ name: 'Coffee Club', priceInr: 1500, validityDays: 30 });
    expect(r.status).toBe(201);
    id = r.body.membership.id;
    expect(id).toBeTruthy();
  });

  it('updates the plan (partial — price only, others untouched)', async () => {
    const r = await request(app).put(`${base()}/${id}`).set(auth())
      .send({ priceInr: 1200 });
    expect(r.status).toBe(200);
    expect(r.body.membership.price_paise).toBe(120000);
    expect(r.body.membership.validity_days).toBe(30); // unchanged
    expect(r.body.membership.name).toBe('Coffee Club'); // unchanged
  });

  it('rejects update of a foreign / unknown plan id', async () => {
    const r = await request(app)
      .put(`${base()}/00000000-0000-0000-0000-000000000000`).set(auth())
      .send({ priceInr: 1 });
    expect(r.status).toBe(404);
  });

  it('deletes the plan and it disappears from the list', async () => {
    const del = await request(app).delete(`${base()}/${id}`).set(auth());
    expect(del.status).toBe(200);
    const list = await request(app).get(base()).set(auth());
    expect(list.status).toBe(200);
    expect((list.body.memberships || []).some((m) => m.id === id)).toBe(false);
  });
});
