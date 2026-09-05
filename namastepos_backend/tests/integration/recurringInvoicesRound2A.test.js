// Round 2 (2026-09-06) — recurring invoices are a REAL feature (CONTRACTS §2).
//
// CRUD under /v1/businesses/:id/recurring-invoices, run-now mints a GST tax
// invoice through taxInvoiceService.issueFromRecurring with per-line GST in
// paise, the cron generator is idempotent per (schedule, period), and the
// featureGate rule '/recurring-invoices' → 'recurring_invoices' 402s a tenant
// without the key.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const features = require('../../src/services/featureService');
const recurring = require('../../src/services/recurringInvoiceService');
const buildApp = require('../../src/app');

let app;
let ent; // has recurring_invoices
let growth; // does not
let entToken;
let growthToken;
let kitchenToken;
let customerId;
let growthCustomerId;

const ITEMS = [
  // 20 × ₹150 @5%  → taxable 3,00,000p, GST 15,000p
  { name: 'Executive Thali', hsn: '996331', qty: 20, unitPricePaise: 15000, gstPct: 5 },
  // 10 × ₹20 @18%  → taxable 20,000p, GST 3,600p
  { name: 'Mineral Water 1L', hsn: '22011010', qty: 10, unitPricePaise: 2000, gstPct: 18 },
];
const EXPECTED_TAXABLE = 320000;
const EXPECTED_GST = 18600;
const EXPECTED_TOTAL = 338600;

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

async function makeCustomer(bizId, phone, name) {
  const r = await query(
    'INSERT INTO customers (business_id, phone, name) VALUES ($1, $2, $3) RETURNING id',
    [bizId, phone, name],
  );
  return r.rows[0].id;
}

const as = (t) => ({ Authorization: `Bearer ${t}` });
const url = (b, p = '') => `/v1/businesses/${b.id}/recurring-invoices${p}`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function baseBody(extra = {}) {
  return {
    name: 'Office canteen — monthly',
    customerId,
    frequency: 'monthly',
    startDate: today(),
    items: ITEMS,
    notes: 'PO 4411',
    recipientGstin: '27BBBBB1111B1Z6',
    recipientAddress: 'Plot 9, MIDC, Pune',
    ...extra,
  };
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  ent = await makeBusiness({ email: `r2a-rec-ent-${Date.now()}`, name: 'Sharma Caterers' });
  growth = await makeBusiness({ email: `r2a-rec-growth-${Date.now()}`, name: 'Growth Stall' });
  entToken = tokenFor(ent);
  growthToken = tokenFor(growth);
  // Supplier identity: Maharashtra (27) so a 27-GSTIN recipient is INTRA-state.
  await query(
    'UPDATE businesses SET gstin = \'27AAAAA0000A1Z5\', state_code = \'27\', address = \'Baner, Pune\' WHERE id = $1',
    [ent.id],
  );
  await query(
    'INSERT INTO business_feature_overrides (business_id, feature_key, enabled) VALUES ($1, \'recurring_invoices\', TRUE)',
    [ent.id],
  );
  await query(
    'INSERT INTO business_feature_overrides (business_id, feature_key, enabled) VALUES ($1, \'recurring_invoices\', FALSE)',
    [growth.id],
  );
  features.clearAllCaches();
  kitchenToken = await makeStaff(ent.id, 'staff_kitchen', 'cook');
  customerId = await makeCustomer(ent.id, '9822000001', 'Infotech Park Canteen');
  growthCustomerId = await makeCustomer(growth.id, '9822000002', 'Someone Else');
});
afterAll(async () => { await closePool(); });

describe('plan gate — Growth (no key) → 402', () => {
  it('402s GET and POST with FEATURE_LOCKED / recurring_invoices', async () => {
    const g = await request(app).get(url(growth)).set(as(growthToken));
    expect(g.status).toBe(402);
    expect(g.body.error).toBe('FEATURE_LOCKED');
    expect(g.body.feature).toBe('recurring_invoices');
    const p = await request(app).post(url(growth)).set(as(growthToken))
      .send(baseBody({ customerId: growthCustomerId }));
    expect(p.status).toBe(402);
  });
});

describe('CRUD', () => {
  let id;
  it('POST 201 returns the Schedule shape with totalPaise incl. GST', async () => {
    const r = await request(app).post(url(ent)).set(as(entToken)).send(baseBody());
    expect(r.status).toBe(201);
    const s = r.body.schedule;
    id = s.id;
    expect(s).toMatchObject({
      name: 'Office canteen — monthly',
      customerId,
      customerName: 'Infotech Park Canteen',
      frequency: 'monthly',
      isActive: true,
      notes: 'PO 4411',
      totalPaise: EXPECTED_TOTAL,
      runCount: 0,
      lastRunAt: null,
      lastInvoiceId: null,
      endDate: null,
    });
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ name: 'Executive Thali', qty: 20, unitPricePaise: 15000, gstPct: 5 });
    expect(new Date(s.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
  it('GET list and GET one', async () => {
    const l = await request(app).get(url(ent)).set(as(entToken));
    expect(l.status).toBe(200);
    expect(l.body.schedules.map((s) => s.id)).toContain(id);
    const one = await request(app).get(url(ent, `/${id}`)).set(as(entToken));
    expect(one.status).toBe(200);
    expect(one.body.schedule.id).toBe(id);
  });
  it('PATCH name / isActive / endDate / items', async () => {
    const r = await request(app).patch(url(ent, `/${id}`)).set(as(entToken)).send({
      name: 'Renamed',
      isActive: false,
      endDate: '2027-03-31',
      items: [ITEMS[0]],
    });
    expect(r.status).toBe(200);
    expect(r.body.schedule).toMatchObject({
      name: 'Renamed', isActive: false, endDate: '2027-03-31', totalPaise: 315000,
    });
    expect(r.body.schedule.items).toHaveLength(1);
    expect(r.body.schedule.notes).toBe('PO 4411'); // untouched by a partial patch
    const clear = await request(app).patch(url(ent, `/${id}`)).set(as(entToken)).send({ endDate: null, isActive: true });
    expect(clear.status).toBe(200);
    expect(clear.body.schedule.endDate).toBeNull();
  });
  it('validation: 400 empty items / bad frequency / unknown field; 404 foreign customer', async () => {
    expect((await request(app).post(url(ent)).set(as(entToken)).send(baseBody({ items: [] }))).status).toBe(400);
    expect((await request(app).post(url(ent)).set(as(entToken)).send(baseBody({ frequency: 'daily' }))).status).toBe(400);
    expect((await request(app).post(url(ent)).set(as(entToken)).send(baseBody({ bogus: 1 }))).status).toBe(400);
    const foreign = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ customerId: growthCustomerId }));
    expect(foreign.status).toBe(404);
  });
  it('tenant scope: the Growth owner cannot read the Enterprise schedule by id', async () => {
    // (Growth is also 402'd by the gate; the service is scoped regardless.)
    await expect(recurring.getById(growth.id, id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('staff without tax_invoices is 403', async () => {
    const r = await request(app).get(url(ent)).set(as(kitchenToken));
    expect(r.status).toBe(403);
  });
  it('DELETE → 204, then 404', async () => {
    expect((await request(app).delete(url(ent, `/${id}`)).set(as(entToken))).status).toBe(204);
    expect((await request(app).get(url(ent, `/${id}`)).set(as(entToken))).status).toBe(404);
  });
});

describe('run-now mints a GST tax invoice and advances the schedule', () => {
  it('invoice figures are exact paise, intra-state CGST/SGST, B2B recipient from customer + schedule', async () => {
    const created = await request(app).post(url(ent)).set(as(entToken)).send(baseBody());
    const s = created.body.schedule;
    const before = new Date(s.nextRunAt).getTime();

    const run = await request(app).post(url(ent, `/${s.id}/run-now`)).set(as(entToken)).send({});
    expect(run.status).toBe(200);
    expect(run.body.invoice).toMatchObject({ totalPaise: EXPECTED_TOTAL });
    expect(run.body.invoice.invoiceNo).toMatch(/^INV\/\d{4}\/\d{5}$/);
    expect(run.body.schedule).toMatchObject({ runCount: 1, lastInvoiceId: run.body.invoice.id });
    expect(run.body.schedule.lastRunAt).toBeTruthy();
    // monthly → next_run_at moved forward ~1 month
    const after = new Date(run.body.schedule.nextRunAt).getTime();
    expect(after - before).toBeGreaterThan(27 * 86400000);
    expect(after - before).toBeLessThan(32 * 86400000);

    const inv = await request(app).get(`/v1/businesses/${ent.id}/tax-invoices/${run.body.invoice.id}`).set(as(entToken));
    expect(inv.status).toBe(200);
    const i = inv.body.invoice;
    expect(i.orderId).toBeNull();
    expect(i.subtotalInr).toBeCloseTo(EXPECTED_TAXABLE / 100, 2);
    expect(i.cgstInr).toBeCloseTo(EXPECTED_GST / 200, 2); // 93.00
    expect(i.sgstInr).toBeCloseTo(EXPECTED_GST / 200, 2);
    expect(i.igstInr).toBe(0);
    expect(i.isInterstate).toBe(false);
    expect(i.totalInr).toBeCloseTo(EXPECTED_TOTAL / 100, 2);
    expect(i.paymentStatus).toBe('unpaid');
    expect(i.supplier).toMatchObject({ gstin: '27AAAAA0000A1Z5', stateCode: '27' });
    expect(i.recipient).toMatchObject({
      name: 'Infotech Park Canteen',
      phone: '9822000001',
      gstin: '27BBBBB1111B1Z6',
      stateCode: '27',
      address: 'Plot 9, MIDC, Pune',
    });
    expect(i.placeOfSupply).toBe('27');
    expect(i.items).toHaveLength(2);
    expect(i.items[0]).toMatchObject({
      name: 'Executive Thali',
      hsn: '996331',
      qty: 20,
      unitPricePaise: 15000,
      lineTaxablePaise: 300000,
      gstPct: 5,
      cgstPaise: 7500,
      sgstPaise: 7500,
      igstPaise: 0,
      gstAmountPaise: 15000,
      lineTotalPaise: 315000,
    });
    expect(i.items[1]).toMatchObject({
      lineTaxablePaise: 20000, gstPct: 18, cgstPaise: 1800, sgstPaise: 1800, gstAmountPaise: 3600,
    });
    expect(i.hsnSummary.map((h) => h.hsn).sort()).toEqual(['22011010', '996331']);
    expect(i.notes).toBe('PO 4411');
    // Statutory number is FY-sequential for the business.
    const cnt = await query('SELECT COUNT(*)::int AS n FROM tax_invoices WHERE business_id = $1', [ent.id]);
    expect(cnt.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('inter-state recipient → IGST, and 0 GST under the composition scheme', async () => {
    const igst = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ recipientGstin: '29CCCCC2222C1Z7' })); // Karnataka
    const run = await request(app).post(url(ent, `/${igst.body.schedule.id}/run-now`)).set(as(entToken)).send({});
    expect(run.status).toBe(200);
    const inv = await request(app).get(`/v1/businesses/${ent.id}/tax-invoices/${run.body.invoice.id}`).set(as(entToken));
    expect(inv.body.invoice.isInterstate).toBe(true);
    expect(inv.body.invoice.igstInr).toBeCloseTo(EXPECTED_GST / 100, 2);
    expect(inv.body.invoice.cgstInr).toBe(0);
    expect(inv.body.invoice.placeOfSupply).toBe('29');

    await query("UPDATE businesses SET gst_scheme = 'composition' WHERE id = $1", [ent.id]);
    try {
      const comp = await request(app).post(url(ent)).set(as(entToken)).send(baseBody());
      const r2 = await request(app).post(url(ent, `/${comp.body.schedule.id}/run-now`)).set(as(entToken)).send({});
      expect(r2.status).toBe(200);
      expect(r2.body.invoice.totalPaise).toBe(EXPECTED_TAXABLE);
      const inv2 = await request(app).get(`/v1/businesses/${ent.id}/tax-invoices/${r2.body.invoice.id}`).set(as(entToken));
      expect(inv2.body.invoice.cgstInr + inv2.body.invoice.sgstInr + inv2.body.invoice.igstInr).toBe(0);
    } finally {
      await query("UPDATE businesses SET gst_scheme = 'regular' WHERE id = $1", [ent.id]);
    }
  });
});

describe('cron: generates exactly once per period', () => {
  it('runDue mints one invoice for a due schedule and a replayed tick mints nothing more', async () => {
    const created = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ frequency: 'weekly', startDate: daysAgo(1), name: 'Weekly due' }));
    const sid = created.body.schedule.id;

    const first = await recurring.runDue();
    expect(first.generated).toBeGreaterThanOrEqual(1);
    const runs1 = await query('SELECT invoice_id, period_key FROM recurring_invoice_runs WHERE schedule_id = $1', [sid]);
    expect(runs1.rowCount).toBe(1);
    expect(runs1.rows[0].invoice_id).toBeTruthy();

    // No longer due → nothing happens.
    const second = await recurring.runDue();
    const runs2 = await query('SELECT COUNT(*)::int AS n FROM recurring_invoice_runs WHERE schedule_id = $1', [sid]);
    expect(runs2.rows[0].n).toBe(1);
    expect(second.generated).toBe(0);

    // Simulate a lost advance / a second leader replaying the SAME period:
    // wind next_run_at back to the invoiced period. The (schedule, period)
    // claim conflicts → no second statutory document, schedule re-advanced.
    await query(
      'UPDATE recurring_invoices SET next_run_at = next_run_at - INTERVAL \'7 days\' WHERE id = $1',
      [sid],
    );
    const third = await recurring.runDue();
    expect(third.generated).toBe(0);
    const runs3 = await query('SELECT COUNT(*)::int AS n FROM recurring_invoice_runs WHERE schedule_id = $1', [sid]);
    expect(runs3.rows[0].n).toBe(1);
    const invCount = await query(
      `SELECT COUNT(*)::int AS n FROM tax_invoices ti
        WHERE ti.id IN (SELECT invoice_id FROM recurring_invoice_runs WHERE schedule_id = $1)`,
      [sid],
    );
    expect(invCount.rows[0].n).toBe(1);
    const sched = await recurring.getById(ent.id, sid);
    expect(sched.runCount).toBe(1);
    expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('a following period IS generated (weekly schedule, one week later)', async () => {
    const created = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ frequency: 'weekly', startDate: daysAgo(8), name: 'Two periods' }));
    const sid = created.body.schedule.id;
    await recurring.runDue(); // period 1 (8 days ago)
    await recurring.runDue(); // period 2 (1 day ago) — now due after the advance
    const runs = await query('SELECT COUNT(*)::int AS n FROM recurring_invoice_runs WHERE schedule_id = $1 AND invoice_id IS NOT NULL', [sid]);
    expect(runs.rows[0].n).toBe(2);
    const sched = await recurring.getById(ent.id, sid);
    expect(sched.runCount).toBe(2);
  });

  it('skips inactive / ended schedules and tenants without the plan key', async () => {
    const paused = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ startDate: daysAgo(2), name: 'Paused' }));
    await request(app).patch(url(ent, `/${paused.body.schedule.id}`)).set(as(entToken)).send({ isActive: false });
    const ended = await request(app).post(url(ent)).set(as(entToken))
      .send(baseBody({ startDate: daysAgo(40), endDate: daysAgo(30), name: 'Ended' }));
    // Growth tenant with a schedule inserted directly (the API 402s them).
    const g = await query(
      `INSERT INTO recurring_invoices (business_id, customer_id, name, template_payload, frequency, next_run_at)
       VALUES ($1, $2, 'growth sched', $3::jsonb, 'monthly', NOW() - INTERVAL '1 day') RETURNING id`,
      [growth.id, growthCustomerId, JSON.stringify({ items: ITEMS })],
    );
    const out = await recurring.runDue();
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    for (const sid of [paused.body.schedule.id, ended.body.schedule.id, g.rows[0].id]) {
      const n = await query('SELECT COUNT(*)::int AS n FROM recurring_invoice_runs WHERE schedule_id = $1', [sid]);
      expect(n.rows[0].n).toBe(0);
    }
  });
});
