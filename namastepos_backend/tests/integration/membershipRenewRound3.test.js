// Round 3 (2026-09-06) — founder Bug 2: "membership plan already used up →
// show a card to renew it, or other memberships the customer can buy".
//
// Pins the customer lookup/profile contract the POS reads:
//   activeMembership     { id, membershipId, name, remaining[], exhausted,
//                          expired, expiresAt, renewPricePaise } | null
//   availableMemberships [{ id, name, pricePaise, validityDays, includes[] }]
//                        — [] when the plan lacks the `memberships` feature
// and the renew call: POST /customer-memberships/:id/renew → new subscription.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const buildApp = require('../../src/app');

let app;
let biz;
let token;
let coffeeId;
let pizzaId;
let clubId; // membership plan with a bundle
let goldId; // second plan on sale

const url = (p) => `/v1/businesses/${biz.id}${p}`;
const auth = () => ({ Authorization: `Bearer ${token}` });

async function grant(key) {
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET enabled = TRUE`,
    [biz.id, key],
  );
  require('../../src/services/featureService').clearCache(biz.id);
}
async function revoke(key) {
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, $2, FALSE)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET enabled = FALSE`,
    [biz.id, key],
  );
  require('../../src/services/featureService').clearCache(biz.id);
}

let seq = 9800200000;
async function customer(walletPaise = 0) {
  seq += 1;
  const c = (await query(
    'INSERT INTO customers (business_id, phone, name) VALUES ($1,$2,\'Member\') RETURNING id',
    [biz.id, String(seq)],
  )).rows[0];
  if (walletPaise > 0) {
    await query(
      'INSERT INTO customer_wallets (business_id, customer_id, balance_paise) VALUES ($1,$2,$3)',
      [biz.id, c.id, walletPaise],
    );
  }
  return { id: c.id, phone: String(seq) };
}
async function subRow(customerId, membershipId, { remaining, daysLeft = 30 }) {
  return (await query(
    `INSERT INTO membership_subscriptions
       (business_id, customer_id, membership_id, expires_at, amount_paid_paise, status, remaining)
     VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval, 50000, 'active', $5::jsonb) RETURNING id`,
    [biz.id, customerId, membershipId, String(daysLeft), JSON.stringify(remaining)],
  )).rows[0].id;
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `r3-mem-${Date.now()}`, name: 'Round3 Memberships' });
  token = tokenFor(biz);
  await grant('loyalty'); // /customers router
  await grant('memberships');
  const coffee = await request(app).post(url('/menu')).set(auth())
    .send({ name: 'Cold Coffee', price: 150, stock: 1000, gstPct: 0 });
  coffeeId = coffee.body.item.id;
  const pizza = await request(app).post(url('/menu')).set(auth())
    .send({ name: 'Pizza', price: 300, stock: 1000, gstPct: 0 });
  pizzaId = pizza.body.item.id;
  const club = await request(app).post(url('/memberships')).set(auth()).send({
    name: 'Coffee Club',
    priceInr: 500,
    validityDays: 30,
    benefits: { items: [{ menuItemId: coffeeId, qty: 5 }, { menuItemId: pizzaId, qty: 1 }] },
  });
  if (club.status !== 201) throw new Error(`membership create failed: ${club.status}`);
  clubId = club.body.membership.id;
  const gold = await request(app).post(url('/memberships')).set(auth()).send({
    name: 'Gold', priceInr: 1500, validityDays: 90, benefits: { items: [{ menuItemId: pizzaId, qty: 10 }] },
  });
  goldId = gold.body.membership.id;
});
afterAll(async () => { await closePool(); });

describe('customer lookup exposes membership exhaustion', () => {
  it('no membership → activeMembership null, plans on sale listed with named bundles', async () => {
    const c = await customer();
    const r = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.activeMembership).toBeNull();
    const plans = r.body.availableMemberships;
    expect(plans.map((p) => p.name).sort()).toEqual(['Coffee Club', 'Gold']);
    const club = plans.find((p) => p.id === clubId);
    expect(club).toEqual(expect.objectContaining({
      pricePaise: 50000, validityDays: 30,
    }));
    expect(club.includes).toEqual(expect.arrayContaining([
      { menuItemId: coffeeId, name: 'Cold Coffee', qty: 5 },
      { menuItemId: pizzaId, name: 'Pizza', qty: 1 },
    ]));
  });

  it('healthy bundle → exhausted false, expired false, remaining named', async () => {
    const c = await customer();
    const sid = await subRow(c.id, clubId, {
      remaining: [{ menuItemId: coffeeId, qty: 2 }, { menuItemId: pizzaId, qty: 0 }],
    });
    const r = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    const m = r.body.activeMembership;
    expect(m.id).toBe(sid);
    expect(m.membershipId).toBe(clubId);
    expect(m.name).toBe('Coffee Club');
    expect(m.exhausted).toBe(false);
    expect(m.expired).toBe(false);
    expect(m.renewPricePaise).toBe(50000);
    expect(typeof m.expiresAt).toBe('string');
    expect(m.remaining).toEqual(expect.arrayContaining([
      { menuItemId: coffeeId, name: 'Cold Coffee', qty: 2 },
      { menuItemId: pizzaId, name: 'Pizza', qty: 0 },
    ]));
    // legacy key still there for older clients
    expect(r.body.membership).not.toBeNull();
  });

  it('bundle used up (all qty 0, still in validity) → exhausted true', async () => {
    const c = await customer();
    await subRow(c.id, clubId, {
      remaining: [{ menuItemId: coffeeId, qty: 0 }, { menuItemId: pizzaId, qty: 0 }],
    });
    const r = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    expect(r.body.activeMembership.exhausted).toBe(true);
    expect(r.body.activeMembership.expired).toBe(false);
    expect(r.body.activeMembership.renewPricePaise).toBe(50000);
  });

  it('past expiry → expired true and still surfaced (so the POS can offer renewal)', async () => {
    const c = await customer();
    await subRow(c.id, clubId, {
      remaining: [{ menuItemId: coffeeId, qty: 3 }], daysLeft: -2,
    });
    const r = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    expect(r.body.activeMembership.expired).toBe(true);
    expect(r.body.activeMembership.exhausted).toBe(false);
    // legacy `membership` is null once expired; `expiredMembership` carries it
    expect(r.body.membership).toBeNull();
    expect(r.body.expiredMembership).not.toBeNull();
  });

  it('GET /customers/:id carries the same two keys', async () => {
    const c = await customer();
    await subRow(c.id, clubId, { remaining: [{ menuItemId: coffeeId, qty: 0 }] });
    const r = await request(app).get(url(`/customers/${c.id}`)).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.activeMembership.exhausted).toBe(true);
    expect(Array.isArray(r.body.availableMemberships)).toBe(true);
    expect(r.body.availableMemberships.length).toBe(2);
  });

  it('availableMemberships is [] when the plan lacks the memberships feature', async () => {
    await revoke('memberships');
    try {
      const c = await customer();
      await subRow(c.id, clubId, { remaining: [{ menuItemId: coffeeId, qty: 0 }] });
      const r = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
      expect(r.status).toBe(200);
      expect(r.body.activeMembership.exhausted).toBe(true); // still reported
      expect(r.body.availableMemberships).toEqual([]);
    } finally {
      await grant('memberships');
    }
  });
});

describe('POST /customer-memberships/:id/renew', () => {
  it('creates a NEW subscription of the same plan with a full bundle; old row untouched', async () => {
    const c = await customer(60000); // ₹600 wallet
    const oldId = await subRow(c.id, clubId, {
      remaining: [{ menuItemId: coffeeId, qty: 0 }, { menuItemId: pizzaId, qty: 0 }],
    });
    const r = await request(app).post(url(`/customer-memberships/${oldId}/renew`)).set(auth())
      .send({ paymentMethod: 'wallet' });
    expect(r.status).toBe(201);
    expect(r.body.renewedFrom).toBe(oldId);
    const sub = r.body.subscription;
    expect(sub.id).not.toBe(oldId);
    expect(sub.membership_id).toBe(clubId);
    expect(sub.customer_id).toBe(c.id);
    expect(sub.payment_method).toBe('wallet');
    expect(Number(sub.amount_paid_paise)).toBe(50000);
    expect(sub.remaining).toEqual(expect.arrayContaining([
      { menuItemId: coffeeId, qty: 5 }, { menuItemId: pizzaId, qty: 1 },
    ]));
    const bal = (await query('SELECT balance_paise FROM customer_wallets WHERE customer_id = $1', [c.id])).rows[0];
    expect(Number(bal.balance_paise)).toBe(10000);
    // lookup now shows the fresh membership, not exhausted
    const look = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    expect(look.body.activeMembership.id).toBe(sub.id);
    expect(look.body.activeMembership.exhausted).toBe(false);
    // old row still there and still 'active' (history)
    const old = (await query('SELECT status FROM membership_subscriptions WHERE id = $1', [oldId])).rows[0];
    expect(old.status).toBe('active');
  });

  it('is idempotent on clientKey (one sale, one debit)', async () => {
    const c = await customer(100000);
    const oldId = await subRow(c.id, clubId, { remaining: [{ menuItemId: coffeeId, qty: 0 }] });
    const body = { paymentMethod: 'wallet', clientKey: `renew-${oldId}` };
    const a = await request(app).post(url(`/customer-memberships/${oldId}/renew`)).set(auth()).send(body);
    const b = await request(app).post(url(`/customer-memberships/${oldId}/renew`)).set(auth()).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.subscription.id).toBe(a.body.subscription.id);
    const bal = (await query('SELECT balance_paise FROM customer_wallets WHERE customer_id = $1', [c.id])).rows[0];
    expect(Number(bal.balance_paise)).toBe(50000);
  });

  it('404 on a foreign subscription id, 400 on junk, 402 without the memberships feature', async () => {
    const other = await makeBusiness({ email: `r3-mem-o-${Date.now()}`, name: 'Other' });
    const oc = (await query(
      "INSERT INTO customers (business_id, phone, name) VALUES ($1, '9333333333', 'O') RETURNING id",
      [other.id],
    )).rows[0];
    const om = (await query(
      "INSERT INTO memberships (business_id, name, price_paise) VALUES ($1, 'X', 100) RETURNING id",
      [other.id],
    )).rows[0];
    const osub = (await query(
      `INSERT INTO membership_subscriptions (business_id, customer_id, membership_id, expires_at, amount_paid_paise)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 days', 100) RETURNING id`,
      [other.id, oc.id, om.id],
    )).rows[0];
    const f = await request(app).post(url(`/customer-memberships/${osub.id}/renew`)).set(auth())
      .send({ paymentMethod: 'cash' });
    expect(f.status).toBe(404);
    const junk = await request(app).post(url('/customer-memberships/not-a-uuid/renew')).set(auth())
      .send({ paymentMethod: 'cash' });
    expect(junk.status).toBe(400);
    await revoke('memberships');
    try {
      const c = await customer();
      const sid = await subRow(c.id, clubId, { remaining: [] });
      const locked = await request(app).post(url(`/customer-memberships/${sid}/renew`)).set(auth())
        .send({ paymentMethod: 'cash' });
      expect(locked.status).toBe(402);
    } finally {
      await grant('memberships');
    }
  });

  it('buying a different plan still goes through the existing /memberships/subscribe', async () => {
    const c = await customer();
    const r = await request(app).post(url('/memberships/subscribe')).set(auth())
      .send({ customerId: c.id, membershipId: goldId, paymentMethod: 'cash' });
    expect(r.status).toBe(201);
    expect(r.body.subscription.membership_id).toBe(goldId);
    const look = await request(app).get(url(`/customers/lookup?phone=${c.phone}`)).set(auth());
    expect(look.body.activeMembership.name).toBe('Gold');
    expect(look.body.activeMembership.remaining).toEqual([{ menuItemId: pizzaId, name: 'Pizza', qty: 10 }]);
  });
});
