// Backend correctness review fixes (2026-09-05) — guest QR / staff / misc half.
//
//   #3  (P1) guest "pay whole bill" left the table logically occupied
//            (session never status='closed', tables.current_session_id kept) —
//            staff could not reopen the table and the next diner's QR order
//            joined the paid bill. Now settles via tableService.closeSession.
//   #6  (P1) guest QR was a "trusted channel": 86'd items orderable, no in-txn
//            stock lock, tax forced to 0, and a fresh (track_stock=false,
//            stock=0) menu invisible. All four fixed.
//   #4  (P1) updateStaffWithPin wrote users.phone with no membership check.
//   #8  (P2) manager discount PIN had no lockout.
//   #12 (P3) public menus hid a TIMED 86 forever.
//   #13 (P3) pg 22P02 (bad uuid) surfaced as 500.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const qrService = require('../../src/services/qrService');
const tableService = require('../../src/services/tableService');
const staffService = require('../../src/services/staffService');
const discountApproval = require('../../src/services/discountApprovalService');
const razorpay = require('../../src/services/razorpayService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });
afterEach(() => { jest.restoreAllMocks(); });

const auth = (t) => ({ Authorization: `Bearer ${t}` });

/** Business + floor + QR-enabled table + guest token. */
async function qrSetup(tag) {
  const biz = await makeBusiness({ email: `qr-${tag}-${Date.now()}@example.com`, name: `QR ${tag}` });
  await query("UPDATE businesses SET state_code = '27' WHERE id = $1", [biz.id]);
  const floor = (await query(
    "INSERT INTO floors (business_id, name) VALUES ($1, 'Ground') RETURNING id", [biz.id],
  )).rows[0];
  const table = await tableService.createTable(biz.id, { floorId: floor.id, label: `T-${tag}`, seats: 4 });
  const token = await qrService.issueTokenForTable(biz.id, table.id);
  await query('UPDATE tables SET qr_enabled = TRUE WHERE id = $1', [table.id]);
  return { biz, table, token };
}

const guestLine = (item, qty = 1) => ({
  menuItemId: item.id, name: item.name, price: item.price, qty,
});

// ── #6: guest path protections ───────────────────────────────────────────
describe('#6 guest QR orders get the untrusted-channel protections', () => {
  it('an 86\'d item is rejected (and hidden from the guest menu)', async () => {
    const { biz, token } = await qrSetup('86');
    const item = await menuService.create(biz.id, { name: 'Fish Curry', price: 250 });
    await query(
      "UPDATE menu_items SET sold_out_until = NOW() + INTERVAL '2 hours' WHERE id = $1", [item.id],
    );
    const menu = await request(app).get(`/v1/guest/menu/${token}`);
    expect(menu.status).toBe(200);
    expect(menu.body.items.find((i) => i.id === item.id)).toBeUndefined();

    const r = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item)] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/sold out/i);
  });

  it('a tracked item with too little stock is rejected under the in-txn lock', async () => {
    const { biz, token } = await qrSetup('stock');
    const item = await menuService.create(biz.id, {
      name: 'Last Slice', price: 90, stock: 1, trackStock: true,
    });
    // Defeat the unlocked pre-flight to prove the TRANSACTIONAL check fires:
    // the pre-flight reads stock=1 for qty=1 and passes; we then drop the
    // stock to 0 before orderService's FOR UPDATE re-read.
    const realQuery = require('../../src/config/db').query;
    const spy = jest.spyOn(require('../../src/config/db'), 'query');
    spy.mockImplementation(async (...args) => {
      const res = await realQuery(...args);
      if (typeof args[0] === 'string' && args[0].includes('SELECT id, name, price, is_active, stock, track_stock FROM menu_items')) {
        await realQuery('UPDATE menu_items SET stock = 0 WHERE id = $1', [item.id]);
      }
      return res;
    });
    const r = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item, 1)] });
    spy.mockRestore();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('OUT_OF_STOCK');
    const orders = await query('SELECT 1 FROM orders WHERE business_id = $1', [biz.id]);
    expect(orders.rowCount).toBe(0);
  });

  it('server GST is computed on a guest order (tax no longer forced to 0)', async () => {
    const { biz, token } = await qrSetup('tax');
    const item = await menuService.create(biz.id, { name: 'Thali', price: 200, gstPct: 5 });
    const r = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item, 2)] });
    expect(r.status).toBe(201);
    const row = (await query(
      'SELECT tax::float AS tax, cgst::float AS cgst, sgst::float AS sgst, total::float AS total FROM orders WHERE id = $1',
      [r.body.order.id],
    )).rows[0];
    expect(row.tax).toBe(20);
    expect(row.cgst).toBe(10);
    expect(row.sgst).toBe(10);
    expect(row.total).toBe(420); // 400 + 20, what the online checkout will charge
    expect(r.body.order.total).toBe(420);
    const lines = await query(
      'SELECT gst_pct::float AS p, gst_amount::float AS a FROM order_items WHERE order_id = $1',
      [r.body.order.id],
    );
    expect(lines.rows[0]).toEqual({ p: 5, a: 20 });
  });

  it('an untracked item with stock=0 (a fresh menu) is visible AND orderable', async () => {
    const { biz, token } = await qrSetup('fresh');
    // menuService.create defaults: stock 0, track_stock false (migration 084).
    const item = await menuService.create(biz.id, { name: 'Filter Coffee', price: 40 });
    const row = (await query('SELECT stock, track_stock FROM menu_items WHERE id = $1', [item.id])).rows[0];
    expect(parseFloat(row.stock)).toBe(0);
    expect(row.track_stock).toBe(false);

    const menu = await request(app).get(`/v1/guest/menu/${token}`);
    expect(menu.body.items.map((i) => i.id)).toContain(item.id);
    const r = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item, 3)] });
    expect(r.status).toBe(201);
  });

  it('a TRACKED item at stock=0 is hidden from the guest menu', async () => {
    const { biz, token } = await qrSetup('tracked0');
    const item = await menuService.create(biz.id, {
      name: 'Gone', price: 40, stock: 0, trackStock: true,
    });
    const menu = await request(app).get(`/v1/guest/menu/${token}`);
    expect(menu.body.items.find((i) => i.id === item.id)).toBeUndefined();
  });

  it('an item with a REQUIRED modifier group is still orderable from the QR menu (waiver kept)', async () => {
    const { biz, token } = await qrSetup('mods');
    const item = await menuService.create(biz.id, { name: 'Pizza', price: 300 });
    const g = await query(
      `INSERT INTO modifier_groups (business_id, name, kind, min_select, max_select, is_active)
       VALUES ($1, 'Crust', 'single_select', 1, 1, TRUE) RETURNING id`,
      [biz.id],
    );
    await query(
      'INSERT INTO modifiers (business_id, group_id, name, price_delta_inr, is_active) VALUES ($1, $2, $3, 0, TRUE)',
      [biz.id, g.rows[0].id, 'Thin'],
    );
    await query(
      'INSERT INTO item_modifier_groups (menu_item_id, group_id) VALUES ($1, $2)',
      [item.id, g.rows[0].id],
    );
    const r = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item)] });
    expect(r.status).toBe(201);
  });
});

// ── #3: guest pay whole bill frees the table ────────────────────────────
describe('#3 guest session payment closes the session like a counter settle', () => {
  it('guest pays → session closed, table free, staff can reopen, next scan starts a NEW bill', async () => {
    const { biz, table, token } = await qrSetup('pay');
    const item = await menuService.create(biz.id, { name: 'Momos', price: 150, gstPct: 5 });
    const placed = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item, 2)] });
    expect(placed.status).toBe(201);

    const running = await request(app).get(`/v1/guest/session/${token}/current`);
    expect(running.status).toBe(200);
    const sessionId = running.body.session.id;
    const duePaise = Math.round(running.body.session.totals.total * 100);
    expect(duePaise).toBe(31500); // 300 + 5% GST

    // Razorpay is mocked: signature ok, order notes bound to this session.
    jest.spyOn(razorpay, 'verifyCheckoutSignature').mockReturnValue(true);
    jest.spyOn(razorpay, 'getOrder').mockResolvedValue({
      id: 'order_test', amount: duePaise, notes: { sessionId, businessId: biz.id },
    });
    const paid = await request(app)
      .post(`/v1/guest/session/${token}/confirm-pay`)
      .send({
        sessionId, razorpayOrderId: 'order_test', razorpayPaymentId: 'pay_test', razorpaySignature: 'sig',
      });
    expect(paid.status).toBe(200);

    // Session fully closed (not just closed_at), total recorded.
    const sess = (await query(
      'SELECT status, closed_at, total_paise FROM table_sessions WHERE id = $1', [sessionId],
    )).rows[0];
    expect(sess.status).toBe('closed');
    expect(sess.closed_at).not.toBeNull();
    expect(sess.total_paise).toBe(31500);
    // Orders paid + collected; payment row recorded atomically with it.
    const ords = (await query(
      'SELECT status, payment_method FROM orders WHERE table_session_id = $1', [sessionId],
    )).rows;
    expect(ords.every((o) => o.status === 'collected' && o.payment_method === 'upi')).toBe(true);
    const pay = await query(
      "SELECT amount_paise FROM payments WHERE business_id = $1 AND razorpay_payment_id = 'pay_test'",
      [biz.id],
    );
    expect(pay.rowCount).toBe(1);
    expect(pay.rows[0].amount_paise).toBe(31500);
    // Table freed.
    const t = (await query('SELECT status, current_session_id FROM tables WHERE id = $1', [table.id])).rows[0];
    expect(t.status).toBe('available');
    expect(t.current_session_id).toBeNull();
    // Combined GST invoice issued post-commit with the right GST.
    const inv = await query(
      'SELECT cgst_paise, sgst_paise, total_paise FROM tax_invoices WHERE business_id = $1', [biz.id],
    );
    expect(inv.rowCount).toBe(1);
    expect(inv.rows[0].cgst_paise + inv.rows[0].sgst_paise).toBe(1500);
    expect(inv.rows[0].total_paise).toBe(31500);

    // The guest bill tab now shows no open session…
    const after = await request(app).get(`/v1/guest/session/${token}/current`);
    expect(after.body.session).toBeNull();
    // …a repeat confirm is refused (idempotent)…
    const again = await request(app)
      .post(`/v1/guest/session/${token}/confirm-pay`)
      .send({
        sessionId, razorpayOrderId: 'order_test', razorpayPaymentId: 'pay_test', razorpaySignature: 'sig',
      });
    expect(again.status).toBe(400);
    // …staff can open a NEW session on the table (used to 409 on uq_open_session)…
    const opened = await tableService.openSession(biz.id, table.id, { guestCount: 2 }, biz._owner.id);
    expect(opened.id).not.toBe(sessionId);
    await tableService.abandonSession(biz.id, opened.id, biz._owner.id);
    // …and the next diner's scan does NOT attach to the paid session.
    const next = await request(app)
      .post(`/v1/guest/orders/${token}`)
      .send({ items: [guestLine(item, 1)] });
    expect(next.status).toBe(201);
    const nextOrder = (await query(
      'SELECT table_session_id FROM orders WHERE id = $1', [next.body.order.id],
    )).rows[0];
    expect(nextOrder.table_session_id).not.toBe(sessionId);
    const fresh = await request(app).get(`/v1/guest/session/${token}/current`);
    expect(fresh.body.session.id).not.toBe(sessionId);
    expect(fresh.body.session.orders).toHaveLength(1);
  });
});

// ── #4: cross-tenant users.phone write ──────────────────────────────────
describe('#4 updateStaffWithPin cannot touch a user outside the business', () => {
  it('owner A patching phone of B\'s owner → 404, phone unchanged', async () => {
    const a = await makeBusiness({ email: `x4a-${Date.now()}@example.com`, name: 'X4 A' });
    const b = await makeBusiness({ email: `x4b-${Date.now()}@example.com`, name: 'X4 B' });
    await query("UPDATE users SET phone = '9811111111' WHERE id = $1", [b._owner.id]);

    const r = await request(app)
      .put(`/v1/businesses/${a.id}/staff/pin/${b._owner.id}`)
      .set(auth(tokenFor(a)))
      .send({ phone: '9800000000' });
    expect(r.status).toBe(404);
    const phone = (await query('SELECT phone FROM users WHERE id = $1', [b._owner.id])).rows[0].phone;
    expect(phone).toBe('9811111111');
  });

  it('owner A patching phone of B\'s STAFF → 404, phone unchanged; own staff works', async () => {
    const a = await makeBusiness({ email: `x4c-${Date.now()}@example.com`, name: 'X4 C' });
    const b = await makeBusiness({ email: `x4d-${Date.now()}@example.com`, name: 'X4 D' });
    const staffB = await staffService.createStaffWithPin(b.id, {
      displayName: 'Cook B', role: 'staff_kitchen', pin: '1234', phone: '9822222222',
    });
    await expect(staffService.updateStaffWithPin(a.id, staffB.userId, { phone: '9800000001' }))
      .rejects.toMatchObject({ statusCode: 404 });
    const phone = (await query('SELECT phone FROM users WHERE id = $1', [staffB.userId])).rows[0].phone;
    expect(phone).toBe('9822222222');

    const staffA = await staffService.createStaffWithPin(a.id, {
      displayName: 'Cook A', role: 'staff_kitchen', pin: '4321', phone: '9833333333',
    });
    const upd = await staffService.updateStaffWithPin(a.id, staffA.userId, { phone: '9844444444' });
    expect(upd.phone).toBe('9844444444');
  });

  it('the owner\'s own row cannot be edited through the staff endpoint', async () => {
    const a = await makeBusiness({ email: `x4e-${Date.now()}@example.com`, name: 'X4 E' });
    await expect(staffService.updateStaffWithPin(a.id, a._owner.id, { phone: '9800000002' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── #8: manager discount PIN lockout ────────────────────────────────────
describe('#8 manager discount PIN locks after 5 wrong attempts', () => {
  it('5 failures → locked; the correct PIN is refused while locked; unlock resets', async () => {
    const biz = await makeBusiness({ email: `pin8-${Date.now()}@example.com`, name: 'PIN 8' });
    await discountApproval.setMyPin(biz.id, biz._owner.id, '2468');

    for (let i = 0; i < 4; i += 1) {
      await expect(discountApproval.verifyManagerPin(biz.id, biz._owner.id, '0000'))
        .rejects.toMatchObject({ statusCode: 401, message: 'Invalid PIN' });
    }
    // 5th wrong attempt trips the lock.
    await expect(discountApproval.verifyManagerPin(biz.id, biz._owner.id, '0000'))
      .rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/Locked/i) });
    // Even the RIGHT pin is refused while locked (and bcrypt is not consulted).
    await expect(discountApproval.verifyManagerPin(biz.id, biz._owner.id, '2468'))
      .rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/Too many wrong PINs/i) });
    const st = (await query(
      'SELECT pin_fail_count, pin_locked_until FROM business_users WHERE business_id = $1 AND user_id = $2',
      [biz.id, biz._owner.id],
    )).rows[0];
    expect(st.pin_fail_count).toBe(5);
    expect(st.pin_locked_until).not.toBeNull();

    // Lock expiry → correct PIN works and clears the counters.
    await query(
      "UPDATE business_users SET pin_locked_until = NOW() - INTERVAL '1 second' WHERE business_id = $1 AND user_id = $2",
      [biz.id, biz._owner.id],
    );
    await expect(discountApproval.verifyManagerPin(biz.id, biz._owner.id, '2468')).resolves.toBe(true);
    const cleared = (await query(
      'SELECT pin_fail_count, pin_locked_until FROM business_users WHERE business_id = $1 AND user_id = $2',
      [biz.id, biz._owner.id],
    )).rows[0];
    expect(cleared.pin_fail_count).toBe(0);
    expect(cleared.pin_locked_until).toBeNull();
  });

  it('the route surfaces the lockout as 401 and mints no approval', async () => {
    const biz = await makeBusiness({ email: `pin8r-${Date.now()}@example.com`, name: 'PIN 8R' });
    await discountApproval.setMyPin(biz.id, biz._owner.id, '1357');
    await query(
      "UPDATE business_users SET pin_fail_count = 5, pin_first_fail_at = NOW(), pin_locked_until = NOW() + INTERVAL '10 minutes' WHERE business_id = $1 AND user_id = $2",
      [biz.id, biz._owner.id],
    );
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/discount-approvals`)
      .set(auth(tokenFor(biz)))
      .send({ managerUserId: biz._owner.id, managerPin: '1357', amountInr: 500 });
    expect(r.status).toBe(401);
    const rows = await query('SELECT 1 FROM discount_approvals WHERE business_id = $1', [biz.id]);
    expect(rows.rowCount).toBe(0);
  });
});

// ── #12: public menu shows an item whose timed 86 has expired ───────────
describe('#12 public menus: an expired timed 86 comes back', () => {
  it('GET /v1/site/:slug/menu lists the item once sold_out_until is in the past', async () => {
    const biz = await makeBusiness({ email: `site12-${Date.now()}@example.com`, name: 'Site 12' });
    const slug = `site12-${Date.now()}`;
    // Published site row (site_settings, siteService.bySlug).
    await query(
      'INSERT INTO site_settings (business_id, brand_slug, is_published) VALUES ($1, $2, TRUE)',
      [biz.id, slug],
    );
    const back = await menuService.create(biz.id, { name: 'Back On', price: 99 });
    const gone = await menuService.create(biz.id, { name: 'Still 86', price: 99 });
    await query("UPDATE menu_items SET sold_out_until = NOW() - INTERVAL '1 hour' WHERE id = $1", [back.id]);
    await query("UPDATE menu_items SET sold_out_until = NOW() + INTERVAL '1 hour' WHERE id = $1", [gone.id]);

    const r = await request(app).get(`/v1/site/${slug}/menu`);
    expect(r.status).toBe(200);
    const names = JSON.stringify(r.body);
    expect(names).toContain('Back On');
    expect(names).not.toContain('Still 86');
  });
});

// ── #13: bad uuid in a path param → 400 ─────────────────────────────────
describe('#13 errorHandler maps pg 22P02 to 400', () => {
  it('GET /orders/abc returns 400 INVALID_INPUT instead of 500', async () => {
    const biz = await makeBusiness({ email: `e13-${Date.now()}@example.com`, name: 'E13' });
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/orders/not-a-uuid`)
      .set(auth(tokenFor(biz)));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_INPUT');
  });

  it('a MulterError-shaped error is a 400 UPLOAD_REJECTED', () => {
    const { errorHandler } = require('../../src/middleware/errorHandler');
    const err = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    errorHandler(err, { path: '/x' }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UPLOAD_REJECTED', code: 'LIMIT_FILE_SIZE' }));
    const filt = new Error('Only JPEG / PNG / WebP / GIF images are allowed');
    const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    errorHandler(filt, { path: '/x' }, res2, () => {});
    expect(res2.status).toHaveBeenCalledWith(400);
  });
});
