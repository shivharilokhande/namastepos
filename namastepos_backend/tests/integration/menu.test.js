// Integration tests for /businesses/:id/menu

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app; let business; let
  token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: 'menu@example.com' });
  token = tokenFor(business);
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Menu CRUD', () => {
  let itemId;

  it('lists empty menu', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/menu`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  it('creates an item', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/menu`)
      .set(auth())
      .send({ name: 'Masala Dosa', price: 80, stock: 25, costPrice: 30, isVeg: true });
    expect(r.status).toBe(201);
    expect(r.body.item.id).toBeTruthy();
    expect(r.body.item.name).toBe('Masala Dosa');
    expect(r.body.item.price).toBe(80);
    itemId = r.body.item.id;
  });

  it('rejects negative price', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/menu`)
      .set(auth())
      .send({ name: 'Bad', price: -5 });
    expect(r.status).toBe(400);
  });

  it('updates an item', async () => {
    const r = await request(app)
      .put(`/v1/businesses/${business.id}/menu/${itemId}`)
      .set(auth())
      .send({ price: 90 });
    expect(r.status).toBe(200);
    expect(r.body.item.price).toBe(90);
  });

  it('adjusts stock and logs a transaction', async () => {
    const r = await request(app)
      .put(`/v1/businesses/${business.id}/menu/${itemId}/stock`)
      .set(auth())
      .send({ delta: 10, reason: 'purchase' });
    expect(r.status).toBe(200);
    expect(r.body.item.stock).toBe(35);

    const h = await request(app)
      .get(`/v1/businesses/${business.id}/menu/${itemId}/history`)
      .set(auth());
    expect(h.status).toBe(200);
    expect(h.body.history.length).toBeGreaterThanOrEqual(1);
    expect(h.body.history[0].qtyChange).toBe(10);
  });

  it('soft-deletes an item', async () => {
    const r = await request(app)
      .delete(`/v1/businesses/${business.id}/menu/${itemId}`)
      .set(auth());
    expect(r.status).toBe(200);

    const list = await request(app)
      .get(`/v1/businesses/${business.id}/menu?isActive=true`)
      .set(auth());
    expect(list.body.items.find((i) => i.id === itemId)).toBeUndefined();
  });

  it('forbids accessing another business', async () => {
    const other = await makeBusiness({ email: 'other@example.com' });
    const r = await request(app)
      .get(`/v1/businesses/${other.id}/menu`)
      .set(auth());
    expect(r.status).toBe(403);
  });
});
