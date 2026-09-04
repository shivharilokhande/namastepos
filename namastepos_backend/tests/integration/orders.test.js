// Integration tests for /businesses/:id/orders

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app; let business; let token; let dosaId; let
  chaiId;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: 'pos@example.com' });
  token = tokenFor(business);

  const dosa = await request(app)
    .post(`/v1/businesses/${business.id}/menu`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Masala Dosa', price: 80, stock: 50, costPrice: 30 });
  dosaId = dosa.body.item.id;
  const chai = await request(app)
    .post(`/v1/businesses/${business.id}/menu`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Chai', price: 15, stock: 100, costPrice: 5 });
  chaiId = chai.body.item.id;
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Orders', () => {
  it('creates an order and deducts stock', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/orders`)
      .set(auth())
      .send({
        source: 'dineIn',
        tableNo: '3',
        items: [
          { menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 2 },
          { menuItemId: chaiId, name: 'Chai', price: 15, qty: 3 },
        ],
        paymentMethod: 'upi',
      });
    expect(r.status).toBe(201);
    expect(r.body.order.orderNo).toBe(1);
    expect(r.body.order.subtotal).toBeCloseTo(80 * 2 + 15 * 3, 2);
    expect(r.body.order.total).toBeCloseTo(80 * 2 + 15 * 3, 2);
    expect(r.body.order.items.length).toBe(2);

    // stock has been deducted
    const dosa = await request(app)
      .get(`/v1/businesses/${business.id}/menu/${dosaId}`)
      .set(auth());
    expect(dosa.body.item.stock).toBe(48);
  });

  it('honours client_id for idempotency', async () => {
    const clientId = '11111111-1111-1111-1111-111111111111';
    const first = await request(app)
      .post(`/v1/businesses/${business.id}/orders`)
      .set(auth())
      .send({
        clientId,
        items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 1 }],
      });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/v1/businesses/${business.id}/orders`)
      .set(auth())
      .send({
        clientId,
        items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 1 }],
      });
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
  });

  it('lists today\'s orders', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeGreaterThanOrEqual(2);
  });

  it('marks order ready then collected', async () => {
    const orders = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .set(auth());
    const oid = orders.body.orders[0].id;

    const ready = await request(app)
      .put(`/v1/businesses/${business.id}/orders/${oid}/status`)
      .set(auth())
      .send({ status: 'ready' });
    expect(ready.status).toBe(200);
    expect(ready.body.order.status).toBe('ready');
    expect(ready.body.order.readyAt).toBeTruthy();

    const done = await request(app)
      .put(`/v1/businesses/${business.id}/orders/${oid}/status`)
      .set(auth())
      .send({ status: 'collected' });
    expect(done.body.order.status).toBe('collected');
  });

  it('returns a printable receipt', async () => {
    const orders = await request(app)
      .get(`/v1/businesses/${business.id}/orders`)
      .set(auth());
    const oid = orders.body.orders[0].id;
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/orders/${oid}/print`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.receipt).toMatch(/TOKEN #/);
    expect(r.body.receipt).toMatch(/Powered by NamastePOS/);
  });
});
