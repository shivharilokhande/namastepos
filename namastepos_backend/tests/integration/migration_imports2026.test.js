// "Switch to NamastePOS" migration wizard imports (2026-09-03).
//
//   POST /imports/customers      — upsert by (business_id, phone); opening
//     loyalty points + wallet balances book ONCE through the existing
//     ledgers (kind 'import_opening'); re-runs update the profile but skip
//     the balances with per-row warnings.
//   POST /imports/sales-history  — one aggregate collected order per past
//     day (channel 'import', noon IST); shows up in the daily report
//     revenue SUM; re-runs skip already-imported dates.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');

let app; let business; let
  token;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  business = await makeBusiness({ email: `mig-${Date.now()}` });
  token = tokenFor(business);
});
afterAll(async () => { await closePool(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (path, rows) => request(app)
  .post(`/v1/businesses/${business.id}${path}`)
  .set(auth())
  .send({ rows });

const PHONE = '9876543210';

async function customerRow() {
  const r = await query(
    'SELECT * FROM customers WHERE business_id = $1 AND phone = $2',
    [business.id, PHONE],
  );
  return r.rows[0];
}

describe('POST /imports/customers', () => {
  it('imports a customer and books opening loyalty + wallet via the ledgers', async () => {
    const r = await post('/imports/customers', [{
      phone: PHONE,
      name: 'Asha',
      email: 'asha@example.com',
      tags: 'vip, regular',
      whatsappOptIn: 'yes',
      loyaltyPoints: 120,
      walletBalanceInr: 250.5,
      notes: 'Khata cleared',
    }]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.failed).toHaveLength(0);
    expect(r.body.warnings).toHaveLength(0);

    const c = await customerRow();
    expect(c.name).toBe('Asha');
    expect(c.tags).toEqual(['vip', 'regular']);
    expect(c.marketing_optin).toBe(true);
    expect(c.points_balance).toBe(120);
    expect(c.lifetime_points).toBe(120);

    // Points went through the loyalty ledger, not a raw column poke.
    const lt = await query(
      `SELECT * FROM loyalty_transactions
        WHERE business_id = $1 AND customer_id = $2`,
      [business.id, c.id],
    );
    expect(lt.rowCount).toBe(1);
    expect(lt.rows[0].kind).toBe('import_opening');
    expect(lt.rows[0].points).toBe(120);
    expect(lt.rows[0].balance_after).toBe(120);

    // Wallet entry shape matches ledger conventions: positive paise credit,
    // customer-scoped, distinct 'import_opening' kind (vs 'credit_top_up').
    const wl = await query(
      'SELECT * FROM wallet_ledger WHERE business_id = $1 AND customer_id = $2',
      [business.id, c.id],
    );
    expect(wl.rowCount).toBe(1);
    expect(wl.rows[0].kind).toBe('import_opening');
    expect(Number(wl.rows[0].amount_paise)).toBe(25050);
    expect(wl.rows[0].gift_card_id).toBeNull();
    expect(wl.rows[0].order_id).toBeNull();

    const w = await query(
      `SELECT balance_paise FROM customer_wallets
        WHERE business_id = $1 AND customer_id = $2`,
      [business.id, c.id],
    );
    expect(Number(w.rows[0].balance_paise)).toBe(25050);
  });

  it('re-run updates profile fields but does NOT double-book balances', async () => {
    const r = await post('/imports/customers', [{
      phone: PHONE,
      name: 'Asha Sharma',
      loyaltyPoints: 120,
      walletBalanceInr: 250.5,
    }]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    // Two warnings: loyalty + wallet openings already imported.
    expect(r.body.warnings).toHaveLength(2);
    expect(r.body.warnings[0].row).toBe(2);
    expect(r.body.warnings.map((w) => w.warning).join(' ')).toMatch(/already imported/i);

    const c = await customerRow();
    expect(c.name).toBe('Asha Sharma'); // profile DID update
    expect(c.points_balance).toBe(120); // balances did NOT double
    const wl = await query(
      `SELECT COUNT(*)::int AS n FROM wallet_ledger
        WHERE business_id = $1 AND customer_id = $2 AND kind = 'import_opening'`,
      [business.id, c.id],
    );
    expect(wl.rows[0].n).toBe(1);
    const w = await query(
      `SELECT balance_paise FROM customer_wallets
        WHERE business_id = $1 AND customer_id = $2`,
      [business.id, c.id],
    );
    expect(Number(w.rows[0].balance_paise)).toBe(25050);
  });

  it('blank cells never wipe existing profile values', async () => {
    const r = await post('/imports/customers', [{ phone: PHONE }]);
    expect(r.body.imported).toBe(1);
    const c = await customerRow();
    expect(c.name).toBe('Asha Sharma');
    expect(c.email).toBe('asha@example.com');
  });

  it('reports validation errors per CSV line (data starts at line 2)', async () => {
    const r = await post('/imports/customers', [
      { phone: '9000000001', name: 'Ok Row' },
      { phone: '12345', name: 'Bad Phone' },
      { phone: '9000000002', loyaltyPoints: -5 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.failed).toHaveLength(2);
    expect(r.body.failed[0].row).toBe(3);
    expect(r.body.failed[0].error).toMatch(/10-digit/);
    expect(r.body.failed[1].row).toBe(4);
  });
});

describe('POST /imports/sales-history', () => {
  const DAY = '2026-01-15';

  it('creates one aggregate collected order that lands in the daily report', async () => {
    const r = await post('/imports/sales-history', [{
      date: DAY, orders: 42, grossInr: 10500.25, discountInr: 500, taxInr: 500.25,
    }]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.failed).toHaveLength(0);

    const o = await query(
      'SELECT * FROM orders WHERE business_id = $1 AND channel = \'import\'',
      [business.id],
    );
    expect(o.rowCount).toBe(1);
    const ord = o.rows[0];
    expect(ord.status).toBe('collected');
    expect(ord.source).toBe('other');
    expect(parseFloat(ord.subtotal)).toBe(10000); // gross − tax
    expect(parseFloat(ord.tax)).toBe(500.25);
    expect(parseFloat(ord.discount)).toBe(500);
    expect(parseFloat(ord.total)).toBe(10000.25); // gross − discount
    expect(ord.collected_at).not.toBeNull();
    expect(ord.order_no).toBeGreaterThan(0);

    const oi = await query('SELECT * FROM order_items WHERE order_id = $1', [ord.id]);
    expect(oi.rowCount).toBe(1);
    expect(oi.rows[0].name).toBe('Imported sales (42 orders)');
    expect(parseFloat(oi.rows[0].qty)).toBe(1);
    expect(parseFloat(oi.rows[0].price)).toBe(10000.25);
    expect(oi.rows[0].menu_item_id).toBeNull();

    // Revenue SUM for that historical date includes the imported day.
    const rep = await request(app)
      .get(`/v1/businesses/${business.id}/reports/daily?date=${DAY}`)
      .set(auth());
    expect(rep.status).toBe(200);
    expect(rep.body.report.revenue.total).toBe(10000.25);
    expect(rep.body.report.orderCount).toBe(1);
  });

  it('re-running the same date skips it with a warning (idempotent)', async () => {
    const r = await post('/imports/sales-history', [{
      date: DAY, orders: 42, grossInr: 10500.25, discountInr: 500, taxInr: 500.25,
    }]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(0);
    expect(r.body.failed).toHaveLength(0);
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings[0].warning).toMatch(/already imported/i);

    const o = await query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE business_id = $1 AND channel = 'import'`,
      [business.id],
    );
    expect(o.rows[0].n).toBe(1); // still exactly one aggregate order
  });

  it('rejects future/today dates, bad formats and zero orders per-row', async () => {
    const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await post('/imports/sales-history', [
      { date: '2030-01-01', orders: 5, grossInr: 100 }, // future
      { date: todayIst, orders: 5, grossInr: 100 }, // today — not past
      { date: '15-01-2026', orders: 5, grossInr: 100 }, // bad format
      { date: '2026-01-16', orders: 0, grossInr: 100 }, // orders < 1
      { date: '2026-01-17', orders: 3, grossInr: 100, discountInr: 200 }, // discount > gross
      { date: '2026-01-18', orders: 3, grossInr: 250 }, // the one good row
    ]);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.failed).toHaveLength(5);
    expect(r.body.failed.map((f) => f.row)).toEqual([2, 3, 4, 5, 6]);
    expect(r.body.failed[0].error).toMatch(/past/i);
    expect(r.body.failed[2].error).toMatch(/YYYY-MM-DD/);
    expect(r.body.failed[4].error).toMatch(/discount/i);
  });

  it('caps the batch at 1100 rows', async () => {
    const rows = Array.from({ length: 1101 }, () => ({
      date: '2020-01-01', orders: 1, grossInr: 1,
    }));
    const r = await post('/imports/sales-history', rows);
    expect(r.status).toBe(400);
  });
});
