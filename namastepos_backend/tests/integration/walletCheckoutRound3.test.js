// Round 3 (2026-09-06) — founder-reported Bug 1 / 1b, reproduced end to end
// over HTTP exactly as the POS clients drive it.
//
// Founder's flow (mobile dine-in POS, v1.0.21):
//   1. Pav Bhaji ₹120, customer attached → sees points + wallet ₹135.37
//   2. redeems 36 points → ₹84 due
//   3. "use wallet" toggle ON → taps Pay & place
//   4. opens the table's Settle screen → it STILL shows ₹84 to pay and the
//      Settle button is enabled.
//
// What this suite pins down:
//   - the wallet IS debited ₹84 at Pay & place (autoWallet + walletCapInr) and a
//     `wallet` payment leg exists, the order is paid (payment_method != unpaid);
//   - the running-bill endpoint both clients read (GET /ops/sessions/:id)
//     reports totalPaise / paidPaise / duePaise / isSettled so the Settle
//     screen can show "Paid" and disable the button;
//   - settling a fully-paid session charges NOTHING (no second wallet debit,
//     no new payment leg) and a second close is a clean 409 ALREADY_SETTLED;
//   - settle-time wallet: an UNPAID KOT in a session, settled with
//     autoWallet / a wallet+cash paymentBreakdown, debits once and records legs;
//   - shortfall split (wallet + cash) works at create AND at settle;
//   - the wallet balance rides back on the create response so the client can
//     refresh without a second call.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const buildApp = require('../../src/app');

let app;
let biz;
let token;
let floorId;
let pavBhajiId;

const url = (p) => `/v1/businesses/${biz.id}${p}`;
const auth = () => ({ Authorization: `Bearer ${token}` });

let phoneSeq = 9700100000;
async function seedCustomer({ points = 100, walletPaise = 13537 } = {}) {
  phoneSeq += 1;
  const phone = String(phoneSeq);
  const c = (await query(
    `INSERT INTO customers (business_id, phone, name, points_balance)
     VALUES ($1, $2, 'Founder Test', $3) RETURNING id`,
    [biz.id, phone, points],
  )).rows[0];
  if (walletPaise > 0) {
    await query(
      'INSERT INTO customer_wallets (business_id, customer_id, balance_paise) VALUES ($1,$2,$3)',
      [biz.id, c.id, walletPaise],
    );
  }
  return { id: c.id, phone };
}

let tableSeq = 0;
async function seatTable(customerPhone) {
  tableSeq += 1;
  const t = await request(app).post(url('/ops/tables')).set(auth())
    .send({ floorId, label: `T${tableSeq}`, seats: 4 });
  expect(t.status).toBe(201);
  const s = await request(app).post(url(`/ops/tables/${t.body.table.id}/sessions`)).set(auth())
    .send({ guestCount: 2, customerPhone });
  expect(s.status).toBe(201);
  return { tableId: t.body.table.id, sessionId: s.body.session.id };
}

async function walletBal(customerId) {
  const r = await query('SELECT balance_paise FROM customer_wallets WHERE customer_id = $1', [customerId]);
  return parseInt(r.rows[0]?.balance_paise || 0, 10);
}
async function legs(orderId) {
  const r = await query('SELECT method, amount_paise FROM payments WHERE order_id = $1 ORDER BY method', [orderId]);
  return r.rows.map((x) => `${x.method}:${x.amount_paise}`);
}
async function ledgerDebits(customerId) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM wallet_ledger
      WHERE customer_id = $1 AND kind = 'order_payment'`,
    [customerId],
  );
  return r.rows[0].n;
}

const pavBhaji = (qty = 1) => [{ menuItemId: pavBhajiId, name: 'Amul Pav Bhaji', price: 120, qty }];

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `r3-wallet-${Date.now()}`, name: 'Round3 Wallet' });
  token = tokenFor(biz);
  // Loyalty (points + wallet) is a plan feature — grant it by override, the
  // same way the other suites do.
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, 'loyalty', TRUE) ON CONFLICT DO NOTHING`,
    [biz.id],
  );
  require('../../src/services/featureService').clearCache(biz.id);
  // Loyalty defaults: 1 pt = ₹1, max 30% of bill → ₹120 bill caps at 36 pts,
  // exactly the founder's 120 − 36 = 84.
  await request(app).get(url('/customers/_settings/loyalty')).set(auth());
  const fl = await request(app).post(url('/ops/floors')).set(auth()).send({ name: 'Ground' });
  floorId = fl.body.floor.id;
  // 0% GST so the numbers match the founder's (pre-GST build) screenshot.
  const m = await request(app).post(url('/menu')).set(auth())
    .send({ name: 'Amul Pav Bhaji', price: 120, stock: 1000, gstPct: 0 });
  pavBhajiId = m.body.item.id;
});
afterAll(async () => { await closePool(); });

describe('Bug 1 — wallet at Pay & place inside a dine-in session', () => {
  let cust; let sess; let order;

  beforeAll(async () => {
    cust = await seedCustomer();
    sess = await seatTable(cust.phone);
    const r = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      tableId: sess.tableId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      pointsToRedeem: 36,
      autoWallet: true,
    });
    if (r.status !== 201) throw new Error(`order create failed: ${r.status} ${JSON.stringify(r.body)}`);
    order = r.body.order;
  });

  it('bills ₹84 after 36 points and debits the wallet by ₹84 with a wallet leg', async () => {
    expect(order.total).toBe(84);
    expect(order.pointsRedeemed).toBe(36);
    expect(await walletBal(cust.id)).toBe(13537 - 8400);
    expect(await legs(order.id)).toEqual(['wallet:8400']);
    expect(order.paymentMethod).toBe('wallet');
    expect(order.paymentBreakdown).toEqual([{ method: 'wallet', amountInr: 84 }]);
  });

  it('returns the post-debit wallet balance on the create response (client refresh)', async () => {
    expect(order.wallet).toEqual({
      balancePaise: 5137,
      balanceInr: 51.37,
      debitedPaise: 8400,
    });
  });

  it('running bill reports the session as PAID (duePaise 0, isSettled true)', async () => {
    const r = await request(app).get(url(`/ops/sessions/${sess.sessionId}`)).set(auth());
    expect(r.status).toBe(200);
    const s = r.body.session;
    expect(s.totalPaise).toBe(8400);
    expect(s.paidPaise).toBe(8400);
    expect(s.duePaise).toBe(0);
    expect(s.isSettled).toBe(true);
    // legacy fields untouched
    expect(s.totalInr).toBe(84);
    expect(s.status).toBe('open');
    expect(s.orders[0].paymentMethod).toBe('wallet');
  });

  it('settling the paid session charges nothing (no 2nd wallet debit, no new leg) and frees the table', async () => {
    const before = await walletBal(cust.id);
    const debitsBefore = await ledgerDebits(cust.id);
    // The settle screen posts what it always posts — the server must not
    // draw the wallet again for a bill that is already paid.
    const r = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({ paymentMethod: 'cash', autoWallet: true });
    expect(r.status).toBe(200);
    expect(r.body.session.status).toBe('closed');
    expect(r.body.session.totalPaise).toBe(8400);
    expect(r.body.session.paidPaise).toBe(8400);
    expect(r.body.session.duePaise).toBe(0);
    expect(r.body.session.isSettled).toBe(true);
    expect(await walletBal(cust.id)).toBe(before);
    expect(await ledgerDebits(cust.id)).toBe(debitsBefore);
    expect(await legs(order.id)).toEqual(['wallet:8400']);
    const t = (await query('SELECT status, current_session_id FROM tables WHERE id = $1', [sess.tableId])).rows[0];
    expect(t.status).toBe('available');
    expect(t.current_session_id).toBeNull();
    const o = (await query('SELECT status, payment_method FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(o.status).toBe('collected');
    expect(o.payment_method).toBe('wallet');
  });

  it('a second settle of the closed session is 409 ALREADY_SETTLED', async () => {
    const r = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({ paymentMethod: 'cash' });
    expect(r.status).toBe(409);
    expect(r.body.code || r.body.error).toBe('ALREADY_SETTLED');
  });

  it('explicit walletCapInr also debits (cap ₹84 on an ₹84 due)', async () => {
    const c2 = await seedCustomer();
    const s2 = await seatTable(c2.phone);
    const r = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: s2.sessionId,
      customerPhone: c2.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      pointsToRedeem: 36,
      autoWallet: true,
      walletCapInr: 84,
    });
    expect(r.status).toBe(201);
    expect(await walletBal(c2.id)).toBe(5137);
    expect(await legs(r.body.order.id)).toEqual(['wallet:8400']);
    // A cap BELOW the due splits: wallet ₹50 + cash ₹34.
    const c3 = await seedCustomer();
    const s3 = await seatTable(c3.phone);
    const r3 = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: s3.sessionId,
      customerPhone: c3.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      pointsToRedeem: 36,
      autoWallet: true,
      walletCapInr: 50,
    });
    expect(r3.status).toBe(201);
    expect(await walletBal(c3.id)).toBe(13537 - 5000);
    expect(await legs(r3.body.order.id)).toEqual(['cash:3400', 'wallet:5000']);
    expect(r3.body.order.wallet.debitedPaise).toBe(5000);
  });
});

describe('Bug 1 — wallet at SETTLE time (unpaid KOT in a session)', () => {
  it('autoWallet on settle debits the wallet once and records the legs', async () => {
    const cust = await seedCustomer({ walletPaise: 5000 }); // ₹50
    const sess = await seatTable(cust.phone);
    const kot = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'unpaid',
    });
    expect(kot.status).toBe(201);
    expect(kot.body.order.paymentMethod).toBe('unpaid');

    const bill = await request(app).get(url(`/ops/sessions/${sess.sessionId}`)).set(auth());
    expect(bill.body.session.totalPaise).toBe(12000);
    expect(bill.body.session.paidPaise).toBe(0);
    expect(bill.body.session.duePaise).toBe(12000);
    expect(bill.body.session.isSettled).toBe(false);

    const r = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({ paymentMethod: 'upi', autoWallet: true });
    expect(r.status).toBe(200);
    expect(r.body.session.duePaise).toBe(0);
    expect(r.body.session.isSettled).toBe(true);
    // wallet ₹50 + upi ₹70
    expect(await walletBal(cust.id)).toBe(0);
    expect(await legs(kot.body.order.id)).toEqual(['upi:7000', 'wallet:5000']);
    expect(await ledgerDebits(cust.id)).toBe(1);
  });

  it('settle with an explicit wallet+cash paymentBreakdown (shortfall split) works', async () => {
    const cust = await seedCustomer({ walletPaise: 3000 });
    const sess = await seatTable(cust.phone);
    const kot = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'unpaid',
    });
    expect(kot.status).toBe(201);
    const r = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({
        paymentMethod: 'cash',
        paymentBreakdown: [{ method: 'wallet', amountInr: 30 }, { method: 'cash', amountInr: 90 }],
      });
    expect(r.status).toBe(200);
    expect(await walletBal(cust.id)).toBe(0);
    expect(await legs(kot.body.order.id)).toEqual(['cash:9000', 'wallet:3000']);
  });

  it('settle legs are validated against the DUE (not the total) when one KOT is already paid', async () => {
    const cust = await seedCustomer({ walletPaise: 20000 });
    const sess = await seatTable(cust.phone);
    // KOT 1 paid at Pay & place via wallet (₹120)
    const paid = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      autoWallet: true,
    });
    expect(paid.status).toBe(201);
    expect(await walletBal(cust.id)).toBe(8000);
    // KOT 2 unpaid (₹120)
    const kot2 = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'unpaid',
    });
    expect(kot2.status).toBe(201);
    const bill = await request(app).get(url(`/ops/sessions/${sess.sessionId}`)).set(auth());
    expect(bill.body.session.totalPaise).toBe(24000);
    expect(bill.body.session.paidPaise).toBe(12000);
    expect(bill.body.session.duePaise).toBe(12000);
    expect(bill.body.session.isSettled).toBe(false);

    // Legs for the whole TOTAL must be refused — that would double-collect KOT 1.
    const bad = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({ paymentMethod: 'cash', paymentBreakdown: [{ method: 'cash', amountInr: 240 }] });
    expect(bad.status).toBe(400);

    // Legs for the DUE settle it; wallet drawn only for the unpaid KOT.
    const ok = await request(app).post(url(`/ops/sessions/${sess.sessionId}/close`)).set(auth())
      .send({ paymentMethod: 'cash', autoWallet: true });
    expect(ok.status).toBe(200);
    expect(await walletBal(cust.id)).toBe(8000 - 8000); // ₹80 left → covers ₹80 of ₹120, cash ₹40
    expect(await legs(kot2.body.order.id)).toEqual(['cash:4000', 'wallet:8000']);
    expect(await legs(paid.body.order.id)).toEqual(['wallet:12000']); // untouched
    expect(ok.body.session.paidPaise).toBe(24000);
    expect(ok.body.session.duePaise).toBe(0);
  });
});

describe('Bug 1b — wallet top-up + shortfall split at create', () => {
  it('POST /customers/:id/wallet/topup credits the wallet, writes a ledger row and a cash payment', async () => {
    const cust = await seedCustomer({ walletPaise: 0 });
    const r = await request(app).post(url(`/customers/${cust.id}/wallet/topup`)).set(auth())
      .send({ amountInr: 100, method: 'cash', note: 'Top-up at counter' });
    expect(r.status).toBe(200);
    expect(r.body.wallet).toEqual({ balancePaise: 10000, balanceInr: 100 });
    expect(typeof r.body.transaction.id).toBe('string');
    expect(r.body.balance).toBe(100); // legacy key kept
    expect(await walletBal(cust.id)).toBe(10000);
    const led = await query(
      "SELECT kind, amount_paise FROM wallet_ledger WHERE customer_id = $1 AND kind = 'credit_top_up'",
      [cust.id],
    );
    expect(led.rowCount).toBe(1);
    expect(Number(led.rows[0].amount_paise)).toBe(10000);
    // The cash the customer handed over is booked so the day's till matches.
    const pay = await query(
      `SELECT method, amount_paise FROM payments
        WHERE business_id = $1 AND order_id IS NULL AND method = 'cash'
          AND notes->>'source' = 'wallet-topup' AND notes->>'customerId' = $2`,
      [biz.id, cust.id],
    );
    expect(pay.rowCount).toBe(1);
    expect(pay.rows[0].amount_paise).toBe(10000);
    // …and the daily report counts it as cash in the till today.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const rep = await require('../../src/services/reportService').dailyReport(biz.id, today);
    expect(rep.walletTopupTenders.cash).toBeGreaterThanOrEqual(100);
    expect(rep.walletTopupsInr).toBeGreaterThanOrEqual(100);
    expect(rep.cashCollectedToday).toBeGreaterThanOrEqual(rep.walletTopupsInr);
  });

  it('top-up rejects a bad method and a foreign customer', async () => {
    const cust = await seedCustomer({ walletPaise: 0 });
    const bad = await request(app).post(url(`/customers/${cust.id}/wallet/topup`)).set(auth())
      .send({ amountInr: 100, method: 'cheque' });
    expect(bad.status).toBe(400);
    const other = await makeBusiness({ email: `r3-other-${Date.now()}`, name: 'Other' });
    const foreign = (await query(
      "INSERT INTO customers (business_id, phone, name) VALUES ($1, '9111111111', 'F') RETURNING id",
      [other.id],
    )).rows[0];
    const f = await request(app).post(url(`/customers/${foreign.id}/wallet/topup`)).set(auth())
      .send({ amountInr: 100, method: 'cash' });
    expect(f.status).toBe(404);
  });

  it('create with a wallet + cash paymentBreakdown covers the shortfall', async () => {
    const cust = await seedCustomer({ walletPaise: 4000 }); // ₹40
    const sess = await seatTable(cust.phone);
    const r = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      paymentBreakdown: [{ method: 'wallet', amountInr: 40 }, { method: 'cash', amountInr: 80 }],
    });
    expect(r.status).toBe(201);
    expect(await walletBal(cust.id)).toBe(0);
    expect(await legs(r.body.order.id)).toEqual(['cash:8000', 'wallet:4000']);
    expect(r.body.order.wallet).toEqual({ balancePaise: 0, balanceInr: 0, debitedPaise: 4000 });
    const bill = await request(app).get(url(`/ops/sessions/${sess.sessionId}`)).set(auth());
    expect(bill.body.session.duePaise).toBe(0);
    expect(bill.body.session.isSettled).toBe(true);
  });

  it('autoWallet with an insufficient wallet draws what it has and routes the rest to cash', async () => {
    const cust = await seedCustomer({ walletPaise: 2500 }); // ₹25
    const sess = await seatTable(cust.phone);
    const r = await request(app).post(url('/orders')).set(auth()).send({
      source: 'dineIn',
      tableSessionId: sess.sessionId,
      customerPhone: cust.phone,
      items: pavBhaji(),
      tax: 0,
      paymentMethod: 'cash',
      autoWallet: true,
    });
    expect(r.status).toBe(201);
    expect(await walletBal(cust.id)).toBe(0);
    expect(await legs(r.body.order.id)).toEqual(['cash:9500', 'wallet:2500']);
  });
});
