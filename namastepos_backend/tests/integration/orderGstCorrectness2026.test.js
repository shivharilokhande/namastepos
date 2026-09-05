// Backend correctness review fixes (2026-09-05) — order/GST/invoice half.
//
//   #1  (P0) GST tax invoices carried ₹0 GST: orderService.create never wrote
//            order_items.gst_pct / gst_amount, and the invoice total ignored
//            tax + loyalty. Now: lines carry the slab and a paise-exact share of
//            orders.tax; the invoice reconciles to orders.total; legacy orders
//            (NULL line GST) fall back to orders.tax.
//   NP-112  an OMITTED `tax` (undefined/null) adopts the server figure in every
//            mode; an explicit 0 keeps the log/enforce behaviour.
//   D1  (P1) ingredient deduction gated on the `recipe_costing` FEATURE KEY,
//            not the addon slug — plan tenants deduct, addon buyers still do.
//   #2  (P1) GSTR-1 / GSTR-3B CSVs 500'd (non-existent columns) — 200 + totals.
//   #5  (P1) client tableSessionId must be this tenant's OPEN session.
//   #9  (P2) a failed dine-in order leaves no orphan open session / occupied table.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');
const taxInvoiceService = require('../../src/services/taxInvoiceService');
const featureService = require('../../src/services/featureService');

let app;
const ORIG_MODE = process.env.ORDER_TAX_ENFORCE;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });
afterEach(() => {
  if (ORIG_MODE === undefined) delete process.env.ORDER_TAX_ENFORCE;
  else process.env.ORDER_TAX_ENFORCE = ORIG_MODE;
  jest.restoreAllMocks();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function gstBusiness(tag) {
  const biz = await makeBusiness({ email: `gst-${tag}-${Date.now()}@example.com`, name: `GST ${tag}` });
  await query(
    "UPDATE businesses SET gstin = '27AAAAA0000A1Z5', state_code = '27', address = 'Pune' WHERE id = $1",
    [biz.id],
  );
  return biz;
}

async function lineRows(orderId) {
  const r = await query(
    `SELECT name, price::float AS price, qty::float AS qty,
            gst_pct::float AS gst_pct, gst_amount::float AS gst_amount
       FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId],
  );
  return r.rows;
}

// ── #1: end-to-end via the API ───────────────────────────────────────────
describe('#1 GST flows from the menu slab to the tax invoice', () => {
  it('POST /orders → collected → invoice: cgst+sgst == order.tax and total == order.total', async () => {
    const biz = await gstBusiness('e2e');
    const token = tokenFor(biz);
    const tikka = await menuService.create(biz.id, { name: 'Paneer Tikka', price: 100, gstPct: 5 });
    const chai = await menuService.create(biz.id, { name: 'Chai', price: 30, gstPct: 5 });

    // Client computes the correct GST (2×100 + 1×30 = 230 × 5% = 11.50).
    const created = await request(app)
      .post(`/v1/businesses/${biz.id}/orders`)
      .set(auth(token))
      .send({
        source: 'takeaway',
        items: [
          { menuItemId: tikka.id, name: 'Paneer Tikka', price: 100, qty: 2 },
          { menuItemId: chai.id, name: 'Chai', price: 30, qty: 1 },
        ],
        tax: 11.5,
        paymentMethod: 'cash',
        roundOffEnabled: false,
      });
    expect(created.status).toBe(201);
    const order = created.body.order || created.body;
    expect(order.tax).toBeCloseTo(11.5, 2);
    expect(order.total).toBeCloseTo(241.5, 2);

    // Lines carry the slab and shares that re-sum EXACTLY to orders.tax.
    const lines = await lineRows(order.id);
    expect(lines.map((l) => l.gst_pct)).toEqual([5, 5]);
    const lineSumPaise = lines.reduce((s, l) => s + Math.round(l.gst_amount * 100), 0);
    expect(lineSumPaise).toBe(1150);
    const byName = Object.fromEntries(lines.map((l) => [l.name, l.gst_amount]));
    expect(byName['Paneer Tikka']).toBeCloseTo(10, 2); // 200 of 230 → 10.00
    expect(byName.Chai).toBeCloseTo(1.5, 2); // 30 of 230 → 1.50

    // Collect → auto-issued invoice.
    const st = await request(app)
      .put(`/v1/businesses/${biz.id}/orders/${order.id}/status`)
      .set(auth(token))
      .send({ status: 'collected' });
    expect(st.status).toBe(200);

    const list = await request(app)
      .get(`/v1/businesses/${biz.id}/tax-invoices`)
      .set(auth(token));
    expect(list.status).toBe(200);
    const inv = list.body.invoices.find((i) => i.orderId === order.id);
    expect(inv).toBeTruthy();
    // Before the fix: cgst = sgst = 0 and total = 230.
    expect(Math.round((inv.cgstInr + inv.sgstInr) * 100)).toBe(Math.round(order.tax * 100));
    expect(inv.igstInr).toBe(0);
    expect(Math.round(inv.totalInr * 100)).toBe(Math.round(order.total * 100));
    expect(inv.subtotalInr).toBeCloseTo(230, 2);
    expect(inv.roundOffInr).toBeCloseTo(0, 2);
    // Frozen lines carry the GST too (what the PDF and GSTR read).
    expect(inv.items.reduce((s, i) => s + i.gstAmountPaise, 0)).toBe(1150);
    expect(inv.items.every((i) => i.gstPct === 5)).toBe(true);
  });

  it('a LEGACY order (NULL line GST, orders.tax set) still invoices its GST and total', async () => {
    const biz = await gstBusiness('legacy');
    const o = await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, cgst, sgst, discount, total,
          round_off_paise, status, collected_at)
       VALUES ($1, 1, 'takeaway', 200, 10, 5, 5, 0, 210, 0, 'collected', NOW())
       RETURNING id`,
      [biz.id],
    );
    // Written by a pre-2026-09-05 build: no gst_pct / gst_amount.
    await query(
      `INSERT INTO order_items (order_id, menu_item_id, name, price, qty)
       VALUES ($1, NULL, 'Thali', 100, 2)`,
      [o.rows[0].id],
    );
    const inv = await taxInvoiceService.issueFromOrder(biz.id, o.rows[0].id);
    expect(inv.cgstInr + inv.sgstInr).toBeCloseTo(10, 2);
    expect(inv.totalInr).toBeCloseTo(210, 2);
    expect(inv.items[0].gstAmountPaise).toBe(1000);
  });

  it('loyalty redemption reduces the invoice total to what was actually paid', async () => {
    const biz = await gstBusiness('loyalty');
    // ₹200 + ₹10 GST − ₹25 loyalty redemption = ₹185 collected.
    const o = await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, discount, total,
          loyalty_discount_paise, round_off_paise, status, collected_at)
       VALUES ($1, 2, 'takeaway', 200, 10, 0, 185, 2500, 0, 'collected', NOW())
       RETURNING id`,
      [biz.id],
    );
    await query(
      `INSERT INTO order_items (order_id, menu_item_id, name, price, qty, gst_pct, gst_amount)
       VALUES ($1, NULL, 'Thali', 100, 2, 5, 10)`,
      [o.rows[0].id],
    );
    const inv = await taxInvoiceService.issueFromOrder(biz.id, o.rows[0].id);
    expect(inv.totalInr).toBeCloseTo(185, 2); // was 200 (no tax, no loyalty) before
    expect(inv.discountInr).toBeCloseTo(25, 2);
    expect(inv.cgstInr + inv.sgstInr).toBeCloseTo(10, 2);
  });

  it('allocateLineGst: remainder lands on the heaviest line, lines always re-sum', () => {
    // ₹10.00 tax over three equal ₹33.33 lines → 333/333/334 paise.
    const lines = [1, 2, 3].map((i) => ({
      menuItemId: `m${i}`, price: 33.33, qty: 1, gstPct: 5,
    }));
    const out = orderService.allocateLineGst(lines, [{}, {}, {}], 10);
    expect(out.reduce((s, l) => s + Math.round(l.gstAmountInr * 100), 0)).toBe(1000);
    expect(out.every((l) => l.gstPct === 5)).toBe(true);
    // Mixed slabs: 18% line carries proportionally more of the tax.
    const mixed = orderService.allocateLineGst([
      { menuItemId: 'a', price: 100, qty: 1, gstPct: 5 },
      { menuItemId: 'b', price: 100, qty: 1, gstPct: 18 },
    ], [{}, {}], 23);
    expect(mixed.map((l) => l.gstAmountInr)).toEqual([5, 18]);
    // Composition scheme → every line 0%.
    const comp = orderService.allocateLineGst(lines, [{}, {}, {}], 0, { billsWithoutGst: true });
    expect(comp.every((l) => l.gstPct === 0 && l.gstAmountInr === 0)).toBe(true);
  });
});

// ── NP-112: omitted tax vs explicit 0 ───────────────────────────────────
describe('NP-112 follow-up — omitted tax adopts the server figure', () => {
  let biz; let itemId;
  beforeAll(async () => {
    biz = await gstBusiness('omit');
    itemId = (await menuService.create(biz.id, { name: 'Dosa', price: 100, gstPct: 5 })).id;
  });

  const body = (extra) => ({
    items: [{ menuItemId: itemId, name: 'Dosa', price: 100, qty: 2 }],
    paymentMethod: 'cash',
    roundOffEnabled: false,
    ...extra,
  });

  it.each(['dineIn', 'takeaway', 'other'])('source=%s, tax omitted, mode=log → server GST + split persisted', async (source) => {
    delete process.env.ORDER_TAX_ENFORCE;
    const o = await orderService.create(biz.id, body({ source }));
    expect(o.tax).toBe(10);
    expect(o.cgst).toBe(5);
    expect(o.sgst).toBe(5);
    expect(o.total).toBe(210);
    const lines = await lineRows(o.id);
    expect(lines[0].gst_pct).toBe(5);
    expect(lines[0].gst_amount).toBe(10);
  });

  it('tax: null is treated as omitted', async () => {
    delete process.env.ORDER_TAX_ENFORCE;
    const o = await orderService.create(biz.id, body({ source: 'takeaway', tax: null }));
    expect(o.tax).toBe(10);
    expect(o.total).toBe(210);
  });

  it('an EXPLICIT 0 keeps the legacy log-mode behaviour (client value stored, warning logged)', async () => {
    delete process.env.ORDER_TAX_ENFORCE;
    const logger = require('../../src/config/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const o = await orderService.create(biz.id, body({ source: 'takeaway', tax: 0 }));
    expect(o.tax).toBe(0);
    expect(o.total).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tax mismatch/i));
    // The lines still record the slab; the amount follows the bill (₹0).
    const lines = await lineRows(o.id);
    expect(lines[0].gst_pct).toBe(5);
    expect(lines[0].gst_amount).toBe(0);
  });

  it('a composition-scheme business bills ₹0 GST even with tax omitted', async () => {
    delete process.env.ORDER_TAX_ENFORCE;
    const comp = await gstBusiness('comp');
    await query("UPDATE businesses SET gst_scheme = 'composition' WHERE id = $1", [comp.id]);
    const it2 = (await menuService.create(comp.id, { name: 'Idli', price: 50 })).id;
    // Older row still carrying a 5% slab from before the scheme was set.
    await query('UPDATE menu_items SET gst_pct = 5 WHERE id = $1', [it2]);
    const o = await orderService.create(comp.id, {
      source: 'takeaway',
      items: [{ menuItemId: it2, name: 'Idli', price: 50, qty: 2 }],
      paymentMethod: 'cash',
      roundOffEnabled: false,
    });
    expect(o.tax).toBe(0);
    expect(o.total).toBe(100);
    const lines = await lineRows(o.id);
    expect(lines[0].gst_pct).toBe(0);
    expect(lines[0].gst_amount).toBe(0);
  });
});

// ── D1: recipe deduction gated on the feature key ───────────────────────
describe('D1 — ingredient deduction runs for a plan that grants recipe_costing (no addon)', () => {
  it('deducts ingredient stock on create and restores it on cancel', async () => {
    const biz = await makeBusiness({ email: `d1-${Date.now()}@example.com`, name: 'D1 Plan' });
    // Enterprise plan (tier 'pro' — see planTiers.js) grants recipe_costing via
    // plan_features; NO business_addons row.
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, (SELECT id FROM plans WHERE tier = 'pro' LIMIT 1), 'active', NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO NOTHING`,
      [biz.id],
    );
    await query(
      "INSERT INTO plan_features (tier_kind, feature_key) VALUES ('pro', 'recipe_costing') ON CONFLICT DO NOTHING",
    );
    featureService.clearAllCaches();
    expect(await featureService.hasFeature(biz.id, 'recipe_costing')).toBe(true);
    const addons = await query(
      'SELECT 1 FROM business_addons WHERE business_id = $1', [biz.id],
    );
    expect(addons.rowCount).toBe(0);

    const dosa = await menuService.create(biz.id, { name: 'Masala Dosa', price: 80 });
    const ing = await query(
      `INSERT INTO ingredients (business_id, name, unit, stock, cost_per_unit_paise)
       VALUES ($1, 'Rice Batter', 'g', 10000, 2) RETURNING id`,
      [biz.id],
    );
    await query(
      `INSERT INTO recipes (business_id, menu_item_id, ingredient_id, qty)
       VALUES ($1, $2, $3, 100)`,
      [biz.id, dosa.id, ing.rows[0].id],
    );

    const o = await orderService.create(biz.id, {
      source: 'takeaway',
      items: [{ menuItemId: dosa.id, name: 'Masala Dosa', price: 80, qty: 2 }],
      tax: 0,
      paymentMethod: 'cash',
    });
    const after = parseFloat((await query('SELECT stock FROM ingredients WHERE id = $1', [ing.rows[0].id])).rows[0].stock);
    expect(after).toBeCloseTo(9800, 3); // deducted — was 10000 with the addon-only gate
    const sale = await query(
      "SELECT 1 FROM ingredient_transactions WHERE order_id = $1 AND kind = 'sale'", [o.id],
    );
    expect(sale.rowCount).toBe(1);

    await query(
      "INSERT INTO cancel_reasons (business_id, code, label, is_active) VALUES ($1, 'CUST_REQ', 'Customer request', TRUE)",
      [biz.id],
    );
    await orderService.updateStatus(biz.id, o.id, 'cancelled', 'test', 'CUST_REQ');
    const restored = parseFloat((await query('SELECT stock FROM ingredients WHERE id = $1', [ing.rows[0].id])).rows[0].stock);
    expect(restored).toBeCloseTo(10000, 3);
  });

  it('a Starter business with neither plan feature nor addon does NOT deduct', async () => {
    const biz = await makeBusiness({ email: `d1free-${Date.now()}@example.com`, name: 'D1 Free' });
    await query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, (SELECT id FROM plans WHERE tier = 'free' LIMIT 1), 'active', NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO NOTHING`,
      [biz.id],
    );
    await query("DELETE FROM plan_features WHERE tier_kind = 'free' AND feature_key = 'recipe_costing'");
    featureService.clearAllCaches();
    const dosa = await menuService.create(biz.id, { name: 'Dosa', price: 80 });
    const ing = await query(
      `INSERT INTO ingredients (business_id, name, unit, stock, cost_per_unit_paise)
       VALUES ($1, 'Batter', 'g', 500, 2) RETURNING id`,
      [biz.id],
    );
    await query(
      'INSERT INTO recipes (business_id, menu_item_id, ingredient_id, qty) VALUES ($1, $2, $3, 100)',
      [biz.id, dosa.id, ing.rows[0].id],
    );
    await orderService.create(biz.id, {
      source: 'takeaway',
      items: [{ menuItemId: dosa.id, name: 'Dosa', price: 80, qty: 1 }],
      tax: 0,
      paymentMethod: 'cash',
    });
    const stock = parseFloat((await query('SELECT stock FROM ingredients WHERE id = $1', [ing.rows[0].id])).rows[0].stock);
    expect(stock).toBeCloseTo(500, 3);
  });
});

// ── #2: GSTR-1 / GSTR-3B 200 path ────────────────────────────────────────
describe('#2 GSTR exports read the real tax_invoices schema', () => {
  it('issues an invoice then downloads GSTR-1 and GSTR-3B with matching totals', async () => {
    const biz = await gstBusiness('gstr');
    const token = tokenFor(biz);
    const item = await menuService.create(biz.id, { name: 'Biryani', price: 200, gstPct: 5 });
    const o = await orderService.create(biz.id, {
      source: 'takeaway',
      items: [{ menuItemId: item.id, name: 'Biryani', price: 200, qty: 2 }],
      paymentMethod: 'cash',
      roundOffEnabled: false,
      customerName: 'Ravi',
    });
    expect(o.tax).toBe(20);
    const inv = await taxInvoiceService.issueFromOrder(biz.id, o.id, { recipientGstin: '27BBBBB1111B1Z6' });
    expect(inv.totalInr).toBe(420);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const g1 = await request(app)
      .get(`/v1/businesses/${biz.id}/reports/gstr1.csv?from=${today}&to=${today}`)
      .set(auth(token));
    expect(g1.status).toBe(200);
    expect(g1.headers['content-type']).toMatch(/text\/csv/);
    const g1Lines = g1.text.split('\n');
    expect(g1Lines[0]).toBe(
      'GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,'
      + 'Place of Supply,Reverse Charge,Invoice Type,Rate,Taxable Value,Cess Amount',
    );
    expect(g1Lines).toHaveLength(2); // header + one invoice×rate row
    const cols = g1Lines[1].split(',');
    expect(cols[0]).toBe('27BBBBB1111B1Z6');
    expect(cols[1]).toBe('Ravi');
    expect(cols[2]).toBe(inv.invoiceNo);
    expect(cols[3]).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(cols[4]).toBe('420.00');
    expect(cols[5]).toBe('27');
    expect(cols[6]).toBe('N');
    expect(cols[8]).toBe('5');
    expect(cols[9]).toBe('400.00');

    const g3 = await request(app)
      .get(`/v1/businesses/${biz.id}/reports/gstr3b.csv?from=${today}&to=${today}`)
      .set(auth(token));
    expect(g3.status).toBe(200);
    const g3Lines = g3.text.split('\n');
    expect(g3Lines[0]).toBe('Description,Invoices,Taxable Value,IGST,CGST,SGST');
    expect(g3Lines[1]).toBe('Outward taxable @ 5%,1,400.00,0.00,10.00,10.00');
    expect(g3Lines[2]).toBe('TOTAL,1,400.00,0.00,10.00,10.00');
  });

  it('400s on a missing/invalid period instead of 500', async () => {
    const biz = await gstBusiness('gstrbad');
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/reports/gstr1.csv?from=yesterday`)
      .set(auth(tokenFor(biz)));
    expect(r.status).toBe(400);
  });

  it('an empty period returns just the headers (and a zero TOTAL row)', async () => {
    const biz = await gstBusiness('gstrempty');
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/reports/gstr3b.csv?from=2020-01-01&to=2020-01-31`)
      .set(auth(tokenFor(biz)));
    expect(r.status).toBe(200);
    expect(r.text.split('\n')).toEqual([
      'Description,Invoices,Taxable Value,IGST,CGST,SGST',
      'TOTAL,0,0.00,0.00,0.00,0.00',
    ]);
  });
});

// ── #5 + #9: table sessions ──────────────────────────────────────────────
describe('#5 / #9 table-session integrity on order create', () => {
  async function tableFor(biz, label) {
    const f = await query(
      'INSERT INTO floors (business_id, name) VALUES ($1, $2) RETURNING id',
      [biz.id, `F-${label}`],
    );
    const t = await query(
      'INSERT INTO tables (business_id, floor_id, label) VALUES ($1, $2, $3) RETURNING id',
      [biz.id, f.rows[0].id, label],
    );
    return t.rows[0].id;
  }

  it('#5 a foreign tableSessionId is refused with 400 INVALID_SESSION and nothing is written', async () => {
    const a = await makeBusiness({ email: `s5a-${Date.now()}@example.com`, name: 'S5 A' });
    const b = await makeBusiness({ email: `s5b-${Date.now()}@example.com`, name: 'S5 B' });
    const tB = await tableFor(b, 'B1');
    const sessB = await query(
      "INSERT INTO table_sessions (business_id, table_id, status) VALUES ($1, $2, 'open') RETURNING id",
      [b.id, tB],
    );
    const item = await menuService.create(a.id, { name: 'Vada', price: 20 });
    const r = await request(app)
      .post(`/v1/businesses/${a.id}/orders`)
      .set(auth(tokenFor(a)))
      .send({
        source: 'dineIn',
        tableSessionId: sessB.rows[0].id,
        items: [{ menuItemId: item.id, name: 'Vada', price: 20, qty: 1 }],
        tax: 1,
        paymentMethod: 'unpaid',
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_SESSION');
    const attached = await query(
      'SELECT 1 FROM orders WHERE table_session_id = $1', [sessB.rows[0].id],
    );
    expect(attached.rowCount).toBe(0);
  });

  it('#5 a CLOSED session of the same tenant is refused too', async () => {
    const a = await makeBusiness({ email: `s5c-${Date.now()}@example.com`, name: 'S5 C' });
    const t = await tableFor(a, 'C1');
    const sess = await query(
      "INSERT INTO table_sessions (business_id, table_id, status, closed_at) VALUES ($1, $2, 'closed', NOW()) RETURNING id",
      [a.id, t],
    );
    const item = await menuService.create(a.id, { name: 'Vada', price: 20 });
    await expect(orderService.create(a.id, {
      source: 'dineIn',
      tableSessionId: sess.rows[0].id,
      items: [{ menuItemId: item.id, name: 'Vada', price: 20, qty: 1 }],
      paymentMethod: 'unpaid',
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SESSION' });
  });

  it('#5 an OPEN session of the same tenant is accepted', async () => {
    const a = await makeBusiness({ email: `s5d-${Date.now()}@example.com`, name: 'S5 D' });
    const t = await tableFor(a, 'D1');
    const sess = await query(
      "INSERT INTO table_sessions (business_id, table_id, status) VALUES ($1, $2, 'open') RETURNING id",
      [a.id, t],
    );
    const item = await menuService.create(a.id, { name: 'Vada', price: 20 });
    const o = await orderService.create(a.id, {
      source: 'dineIn',
      tableSessionId: sess.rows[0].id,
      items: [{ menuItemId: item.id, name: 'Vada', price: 20, qty: 1 }],
      paymentMethod: 'unpaid',
    });
    expect(o.tableSessionId).toBe(sess.rows[0].id);
  });

  it('#9 an order that fails validation leaves no orphan open session and the table stays free', async () => {
    const a = await makeBusiness({ email: `s9-${Date.now()}@example.com`, name: 'S9' });
    const t = await tableFor(a, 'T9');
    const item = await menuService.create(a.id, {
      name: 'Last Kebab', price: 120, stock: 1, trackStock: true,
    });
    await expect(orderService.create(a.id, {
      source: 'dineIn',
      tableId: t,
      tableNo: 'T9',
      items: [{ menuItemId: item.id, name: 'Last Kebab', price: 120, qty: 5 }],
      paymentMethod: 'unpaid',
    })).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });

    const sessions = await query(
      "SELECT 1 FROM table_sessions WHERE table_id = $1 AND status = 'open'", [t],
    );
    expect(sessions.rowCount).toBe(0); // was 1 — an empty orphan session
    const table = await query('SELECT status, current_session_id FROM tables WHERE id = $1', [t]);
    expect(table.rows[0].status).toBe('available');
    expect(table.rows[0].current_session_id).toBeNull();

    // …and a valid order on the same table opens the session normally.
    const ok = await orderService.create(a.id, {
      source: 'dineIn',
      tableId: t,
      tableNo: 'T9',
      items: [{ menuItemId: item.id, name: 'Last Kebab', price: 120, qty: 1 }],
      paymentMethod: 'unpaid',
    });
    expect(ok.tableSessionId).toBeTruthy();
    const after = await query('SELECT status FROM tables WHERE id = $1', [t]);
    expect(after.rows[0].status).toBe('occupied');
  });
});
