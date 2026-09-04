// Integration tests for /expenses and /reports

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');

let app; let business; let token; let
  itemId;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: 'fin@example.com' });
  token = tokenFor(business);
  const m = await request(app)
    .post(`/v1/businesses/${business.id}/menu`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Idli', price: 50, stock: 100 });
  itemId = m.body.item.id;
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
// Reports bucket by IST (Asia/Kolkata, UTC+5:30). Compute the test's "today"
// in IST too, otherwise between 18:30–24:00 UTC the UTC date lags the IST date
// and the daily P&L (correctly IST-bucketed) shows 0 for the wrong day.
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const month = today.slice(0, 7);

describe('Expenses', () => {
  it('creates an expense', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${business.id}/expenses`)
      .set(auth())
      .send({ category: 'ingredients', amount: 500, date: today, description: 'Rice 5kg' });
    expect(r.status).toBe(201);
    expect(r.body.expense.amount).toBe(500);
  });

  it('lists expenses', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/expenses?startDate=${today}&endDate=${today}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.expenses.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Reports', () => {
  beforeAll(async () => {
    // Create an order so revenue > 0
    await request(app)
      .post(`/v1/businesses/${business.id}/orders`)
      .set(auth())
      .send({
        items: [{ menuItemId: itemId, name: 'Idli', price: 50, qty: 4 }],
        paymentMethod: 'cash',
      });
  });

  it('computes daily P&L', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/reports/daily?date=${today}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.report.revenue.total).toBe(200);
    expect(r.body.report.expenses.total).toBe(500);
    expect(r.body.report.profit).toBe(-300);
    expect(r.body.report.orderCount).toBe(1);
    expect(r.body.report.topItems[0].name).toBe('Idli');
  });

  it('computes monthly P&L with daily series', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/reports/monthly?month=${month}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.report.totalRevenue).toBe(200);
    expect(Array.isArray(r.body.report.series)).toBe(true);
  });
});
