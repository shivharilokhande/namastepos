// 2026-09-03 — delivery fulfilment lifecycle.
//
// Founder ask: the exact flow a Zomato/Swiggy (or own-fleet) order goes
// through — accept with a prep time, preparing, food ready, rider assigned,
// OTP handover, delivered — in dashboard AND app.
//
// What these tests pin:
//   • the transition matrix (no skipping rungs, terminals are terminal)
//   • prep time mandatory on accept, reason mandatory on reject
//   • the OTP handover gate (right code passes, wrong code refused, and the
//     expected code is NEVER returned to the client)
//   • the deliberate mirror into orders.status (food_ready→ready,
//     delivered→collected) so revenue/loyalty stay correct
//   • one queued outbound event per transition, deduped per (order, event)
//   • inbound webhook EVENT ROUTING: a cancel/rider/delivered callback is no
//     longer mis-parsed as a brand-new order

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const fulfilment = require('../../src/services/fulfilmentService');

let app; let biz; let token; let itemId;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `ful-${Date.now()}@example.com`, name: 'Fulfilment Test' });
  token = tokenFor(biz);
  const m = await query(
    `INSERT INTO menu_items (business_id, name, price, category, is_active)
     VALUES ($1, 'Biryani', 250, 'main', TRUE) RETURNING id`,
    [biz.id]
  );
  itemId = m.rows[0].id;
});
afterAll(async () => { await closePool(); });

const url = (p) => `/v1/businesses/${biz.id}${p}`;
const auth = () => ({ Authorization: `Bearer ${token}` });

/** A delivery order sitting at `placed`, as the webhook would leave it. */
async function makeDeliveryOrder(orderNo) {
  const r = await query(
    `INSERT INTO orders
       (business_id, order_no, source, channel, customer_name, customer_phone,
        subtotal, tax, discount, total, status, fulfilment_state,
        aggregator_order_id)
     VALUES ($1, $2, 'other', 'zomato', 'Ramesh', '9876500000',
             250, 12.5, 0, 262.5, 'pending', 'placed', $3)
     RETURNING id`,
    [biz.id, orderNo, `ZO-${orderNo}-${Date.now()}`]
  );
  return r.rows[0].id;
}

const move = (orderId, body) => request(app)
  .post(url(`/fulfilment/${orderId}/transition`)).set(auth()).send(body);

describe('fulfilment board', () => {
  it('lists live delivery orders and never leaks the expected OTP', async () => {
    const id = await makeDeliveryOrder(9001);
    await query(`UPDATE orders SET rider_otp_expected = '4321' WHERE id = $1`, [id]);
    const r = await request(app).get(url('/fulfilment/board')).set(auth());
    expect(r.status).toBe(200);
    const row = r.body.orders.find((o) => o.id === id);
    expect(row).toBeDefined();
    expect(row.state).toBe('placed');
    expect(row.otpRequired).toBe(true);
    // The whole point of a handover code: staff must TYPE it, so the client
    // must never be able to read it off our own payload.
    expect(JSON.stringify(r.body)).not.toContain('4321');
    expect(row.rider_otp_expected).toBeUndefined();
  });

  it('excludes finished orders from the live board', async () => {
    const id = await makeDeliveryOrder(9002);
    await query(`UPDATE orders SET fulfilment_state = 'delivered' WHERE id = $1`, [id]);
    const r = await request(app).get(url('/fulfilment/board')).set(auth());
    expect(r.body.orders.some((o) => o.id === id)).toBe(false);
  });
});

describe('the happy path, rung by rung', () => {
  it('accept → preparing → food_ready → rider_assigned → picked_up → delivered', async () => {
    const id = await makeDeliveryOrder(9010);

    const acc = await move(id, { state: 'accepted', prepMinutes: 20 });
    expect(acc.status).toBe(200);
    expect(acc.body.order.state).toBe('accepted');
    expect(acc.body.order.prepMinutes).toBe(20);

    expect((await move(id, { state: 'preparing' })).body.order.state).toBe('preparing');

    const ready = await move(id, { state: 'food_ready' });
    expect(ready.body.order.state).toBe('food_ready');
    // Deliberate mirror: kitchen done ⇒ POS 'ready' so KDS/reports agree.
    const afterReady = await query(`SELECT status FROM orders WHERE id = $1`, [id]);
    expect(afterReady.rows[0].status).toBe('ready');

    const assigned = await move(id, {
      state: 'rider_assigned',
      rider: { name: 'Suresh', phone: '9812300000', otp: '7788' },
    });
    expect(assigned.body.order.state).toBe('rider_assigned');
    expect(assigned.body.order.rider.name).toBe('Suresh');
    expect(assigned.body.order.otpRequired).toBe(true);

    const handover = await move(id, { state: 'picked_up', otp: '7788' });
    expect(handover.status).toBe(200);
    expect(handover.body.order.otpVerified).toBe(true);

    const done = await move(id, { state: 'delivered' });
    expect(done.body.order.state).toBe('delivered');
    // delivered ⇒ POS 'collected' exactly once, so revenue is recognised.
    const fin = await query(`SELECT status, collected_at FROM orders WHERE id = $1`, [id]);
    expect(fin.rows[0].status).toBe('collected');
    expect(fin.rows[0].collected_at).toBeTruthy();
  });
});

describe('guard rails', () => {
  it('refuses to accept without a prep time', async () => {
    const id = await makeDeliveryOrder(9020);
    const r = await move(id, { state: 'accepted' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/prepMinutes/i);
  });

  it('refuses to reject without a reason, accepts with one', async () => {
    const id = await makeDeliveryOrder(9021);
    expect((await move(id, { state: 'rejected' })).status).toBe(400);
    const ok = await move(id, { state: 'rejected', reason: 'Out of biryani' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.state).toBe('rejected');
    // Terminal.
    const after = await move(id, { state: 'accepted', prepMinutes: 10 });
    expect(after.status).toBe(409);
  });

  it('refuses to skip rungs (placed → delivered)', async () => {
    const id = await makeDeliveryOrder(9022);
    const r = await move(id, { state: 'delivered' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/Cannot move/i);
  });

  it('treats re-sending the same state as a harmless no-op', async () => {
    const id = await makeDeliveryOrder(9023);
    await move(id, { state: 'accepted', prepMinutes: 15 });
    const again = await move(id, { state: 'accepted', prepMinutes: 15 });
    expect(again.status).toBe(200);
    expect(again.body.order.unchanged).toBe(true);
  });

  it('blocks the handover on a wrong OTP and lets the right one through', async () => {
    const id = await makeDeliveryOrder(9024);
    await move(id, { state: 'accepted', prepMinutes: 10 });
    await move(id, { state: 'food_ready' });
    await move(id, { state: 'rider_assigned', rider: { name: 'Rider', otp: '1234' } });

    const wrong = await move(id, { state: 'picked_up', otp: '9999' });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toMatch(/Incorrect OTP/i);

    const missing = await move(id, { state: 'picked_up' });
    expect(missing.status).toBe(400);

    const right = await move(id, { state: 'picked_up', otp: '1234' });
    expect(right.status).toBe(200);
  });

  it('is tenant-scoped — another business cannot move this order', async () => {
    const id = await makeDeliveryOrder(9025);
    const other = await makeBusiness({ email: `ful-b-${Date.now()}@example.com` });
    const r = await request(app)
      .post(`/v1/businesses/${other.id}/fulfilment/${id}/transition`)
      .set({ Authorization: `Bearer ${tokenFor(other)}` })
      .send({ state: 'accepted', prepMinutes: 10 });
    expect([403, 404]).toContain(r.status);
  });
});

describe('outbound callback queue', () => {
  it('queues one event per transition, deduped per (order, event)', async () => {
    const id = await makeDeliveryOrder(9030);
    await move(id, { state: 'accepted', prepMinutes: 25 });
    await move(id, { state: 'food_ready' });

    const q = await query(
      `SELECT event, status, provider FROM aggregator_outbound_events
        WHERE order_id = $1 ORDER BY created_at`,
      [id]
    );
    const events = q.rows.map((x) => x.event);
    expect(events).toContain('accepted');
    expect(events).toContain('food_ready');
    expect(q.rows.every((x) => x.status === 'queued')).toBe(true);
    // Provider comes off the order's channel so the adapter knows where to push.
    expect(q.rows[0].provider).toBe('zomato');
  });

  it('drains to `skipped` (not a retry storm) when partner creds are absent', async () => {
    const id = await makeDeliveryOrder(9031);
    await move(id, { state: 'accepted', prepMinutes: 15 });
    const out = await fulfilment.drainOutbound({ limit: 20 });
    expect(out.considered).toBeGreaterThan(0);
    expect(out.failed).toBe(0);
    const q = await query(
      `SELECT status, last_error FROM aggregator_outbound_events WHERE order_id = $1`, [id]
    );
    expect(q.rows[0].status).toBe('skipped');
    expect(q.rows[0].last_error).toMatch(/credential|configured|agreement/i);
  });
});

describe('inbound webhook event routing', () => {
  const crypto = require('crypto');
  const SECRET = 'hook-secret-fulfilment';

  beforeAll(async () => {
    await query(
      `INSERT INTO aggregator_credentials
         (business_id, provider, outlet_id, api_key, webhook_secret, is_active)
       VALUES ($1, 'zomato', $2, 'k', $3, TRUE)
       ON CONFLICT (business_id, provider) DO UPDATE
         SET outlet_id = EXCLUDED.outlet_id, webhook_secret = EXCLUDED.webhook_secret`,
      [biz.id, `OUT-${biz.id.slice(0, 8)}`, SECRET]
    );
  });

  const post = async (payload) => {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return request(app)
      .post('/v1/aggregator-webhooks/zomato')
      .set('Content-Type', 'application/json')
      .set('x-outlet-id', `OUT-${biz.id.slice(0, 8)}`)
      .set('x-zomato-signature', sig)
      .send(raw);
  };

  it('routes a rider-assigned callback to the rider rung, not a new order', async () => {
    const id = await makeDeliveryOrder(9040);
    const ext = (await query(`SELECT aggregator_order_id FROM orders WHERE id = $1`, [id]))
      .rows[0].aggregator_order_id;
    await move(id, { state: 'accepted', prepMinutes: 10 });
    await move(id, { state: 'food_ready' });

    const r = await post({
      event: 'rider.assigned',
      order_id: ext,
      rider: { name: 'Zomato Rider', phone: '9800000000' },
      otp: '5566',
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe('rider_assigned');

    const row = await query(
      `SELECT fulfilment_state, rider_name, rider_otp_expected FROM orders WHERE id = $1`, [id]
    );
    expect(row.rows[0].fulfilment_state).toBe('rider_assigned');
    expect(row.rows[0].rider_name).toBe('Zomato Rider');
    expect(row.rows[0].rider_otp_expected).toBe('5566');
  });

  it('routes a cancel callback to cancelled', async () => {
    const id = await makeDeliveryOrder(9041);
    const ext = (await query(`SELECT aggregator_order_id FROM orders WHERE id = $1`, [id]))
      .rows[0].aggregator_order_id;
    const r = await post({ event: 'order.cancelled', order_id: ext, reason: 'Diner cancelled' });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe('cancelled');
    const row = await query(`SELECT fulfilment_state FROM orders WHERE id = $1`, [id]);
    expect(row.rows[0].fulfilment_state).toBe('cancelled');
  });

  it('acknowledges an unknown event without inventing an order', async () => {
    const before = await query(`SELECT COUNT(*)::int AS c FROM orders WHERE business_id = $1`, [biz.id]);
    const r = await post({ event: 'order.rated', order_id: 'ZO-nope', rating: 5 });
    expect(r.status).toBe(200);
    expect(r.body.ignored).toMatch(/unhandled/i);
    const after = await query(`SELECT COUNT(*)::int AS c FROM orders WHERE business_id = $1`, [biz.id]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});
