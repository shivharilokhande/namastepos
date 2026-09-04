// Starter menu templates + "paste your menu" (2026-09-05).
//
// WHAT THIS LOCKS DOWN
//
//   The activation audit (2026-09-04) named manual menu entry — 45 to 90
//   minutes on a phone, sitting between signup and the first bill — as the
//   single thing most likely to end a 7-day trial on day one. Templates and
//   the paste path are the two routes out of it for an owner who has nothing
//   to import. Four properties have to hold or the cure is worse than the
//   disease:
//
//   1. A template belongs to the business that asked for it and to NO other.
//   2. Applying to a menu that already has items MERGES and never destroys.
//      Re-applying the same template a second time inserts nothing.
//   3. A template that would breach the plan cap is refused WHOLE, with the
//      documented 403 PLAN_LIMIT shape, having written zero rows.
//   4. The text parser reads the shapes people actually paste, and returns
//      garbage as "we could not read this" rather than throwing.
//
// Conventions follow menuBulkCap2026.test.js: resetDb / makeBusiness / tokenFor.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const featureService = require('../../src/services/featureService');
const templates = require('../../src/services/menuTemplateService');
const { parseMenuText } = require('../../src/utils/menuTextParser');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

/** A private plan for one tenant + an active subscription onto it. */
async function subscribeToPrivatePlan(businessId, { tier, tierKind = 'pro', limits }) {
  await query(
    `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, is_active,
                        is_public, business_id, limits)
     VALUES ($1, $2, $3, 29900, TRUE, FALSE, $4, $5::jsonb)`,
    [tier, tierKind, `Plan ${tier}`, businessId, JSON.stringify(limits)],
  );
  const p = await query('SELECT id FROM plans WHERE tier = $1', [tier]);
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days')`,
    [businessId, p.rows[0].id],
  );
  featureService.clearCache(businessId);
}

async function activeCount(businessId) {
  const r = await query(
    'SELECT COUNT(*)::int AS c FROM menu_items WHERE business_id = $1 AND is_active = TRUE',
    [businessId],
  );
  return r.rows[0].c;
}

// ─────────────────────────────────────────────────────────────────────────
describe('GET /menu/templates — the picker', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'tpl-list@example.com', name: 'Picker Kitchen' });
    token = tokenFor(business);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('lists every template with the fields the picker renders', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/menu/templates`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.templates)).toBe(true);
    // Nine formats from the activation brief: cafe, QSR, north indian, south
    // indian, cloud kitchen, bakery, bar, dhaba, tea stall.
    expect(r.body.templates.length).toBeGreaterThanOrEqual(9);

    for (const t of r.body.templates) {
      expect(typeof t.slug).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(t.itemCount).toBeGreaterThan(0);
      expect(Array.isArray(t.categories)).toBe(true);
      expect(t.categories.length).toBeGreaterThan(0);
      expect(t.sample.length).toBeGreaterThan(0);
    }
    const slugs = r.body.templates.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // slugs are unique
    expect(slugs).toEqual(expect.arrayContaining([
      'cafe', 'qsr-street-food', 'north-indian', 'south-indian-tiffin',
      'cloud-kitchen', 'bakery', 'bar-pub', 'dhaba', 'tea-stall',
    ]));
  });

  it('every template fits inside Starter, which is 60 menu items', async () => {
    // Verified live against GET /v1/public/plans on 2026-09-05: Starter's
    // menu_items limit is 60, Growth is -1 (unlimited). A template that
    // cannot be loaded on the free plan is not a starter menu.
    for (const t of templates.listTemplates()) {
      expect(t.itemCount).toBeLessThanOrEqual(templates.MAX_TEMPLATE_ITEMS);
      expect(t.itemCount).toBeLessThanOrEqual(60);
    }
  });

  it('every item has a positive price and a category', async () => {
    for (const t of templates.listTemplates()) {
      const full = templates.getTemplate(t.slug);
      for (const it of full.items) {
        expect(it.price).toBeGreaterThan(0);
        expect(typeof it.category).toBe('string');
        expect(it.category.length).toBeGreaterThan(0);
        expect([0, 5, 12, 18, 28]).toContain(it.gstPct);
      }
    }
  });

  it('the bar template carries alcohol at 0% GST, not 5%', async () => {
    // Liquor is outside GST (state excise / VAT). A 5% GST line on a beer
    // would be a wrong tax invoice, so this is a correctness assertion, not
    // a style one.
    const bar = templates.getTemplate('bar-pub');
    const beer = bar.items.find((i) => /beer/i.test(i.name));
    expect(beer).toBeDefined();
    expect(beer.gstPct).toBe(0);
    expect(beer.hsnCode).toBeNull();
    // and the food in the same template is still the ordinary 5%
    const food = bar.items.find((i) => /fries/i.test(i.name));
    expect(food.gstPct).toBe(5);
  });

  it('returns one template in full', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/menu/templates/tea-stall`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.template.slug).toBe('tea-stall');
    expect(r.body.template.items.length).toBe(r.body.template.itemCount);
    expect(r.body.template.notes.length).toBeGreaterThan(0);
  });

  it('404s an unknown slug instead of falling through to the item route', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${business.id}/menu/templates/does-not-exist`)
      .set(auth());
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('POST /menu/templates/:slug/apply — tenant scope', () => {
  let bizA; let tokenA; let bizB; let tokenB;

  beforeAll(async () => {
    bizA = await makeBusiness({ email: 'tpl-a@example.com', name: 'Tenant A' });
    bizB = await makeBusiness({ email: 'tpl-b@example.com', name: 'Tenant B' });
    tokenA = tokenFor(bizA);
    tokenB = tokenFor(bizB);
  });

  it('creates exactly the template item count for the right business and nothing for another', async () => {
    const tpl = templates.getTemplate('tea-stall');
    expect(await activeCount(bizA.id)).toBe(0);
    expect(await activeCount(bizB.id)).toBe(0);

    const r = await request(app)
      .post(`/v1/businesses/${bizA.id}/menu/templates/tea-stall/apply`)
      .set({ Authorization: `Bearer ${tokenA}` })
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(tpl.itemCount);
    expect(r.body.alreadyPresent).toEqual([]);
    expect(r.body.errors).toEqual([]);
    expect(r.body.template.slug).toBe('tea-stall');

    expect(await activeCount(bizA.id)).toBe(tpl.itemCount);
    // The whole point of the tenant-scope test: B is untouched.
    expect(await activeCount(bizB.id)).toBe(0);

    // Prices came off disk, not off the wire.
    const chai = await query(
      'SELECT price, gst_pct FROM menu_items WHERE business_id = $1 AND name = $2',
      [bizA.id, 'Cutting Chai'],
    );
    const seed = tpl.items.find((i) => i.name === 'Cutting Chai');
    expect(parseFloat(chai.rows[0].price)).toBe(seed.price);
    expect(parseFloat(chai.rows[0].gst_pct)).toBe(5);
  });

  it("refuses to apply into a business the caller doesn't own", async () => {
    const before = await activeCount(bizA.id);
    const r = await request(app)
      .post(`/v1/businesses/${bizA.id}/menu/templates/cafe/apply`)
      .set({ Authorization: `Bearer ${tokenB}` })
      .send({});
    expect([403, 404]).toContain(r.status);
    expect(await activeCount(bizA.id)).toBe(before);
    expect(await activeCount(bizB.id)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('POST /menu/templates/:slug/apply — merge, never wipe', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'tpl-merge@example.com', name: 'Merge Kitchen' });
    token = tokenFor(business);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const apply = (slug) => request(app)
    .post(`/v1/businesses/${business.id}/menu/templates/${slug}/apply`)
    .set(auth())
    .send({});

  it('keeps the owner\'s own items and their prices, and skips same-name rows', async () => {
    // The owner typed three dishes before finding the template button. One of
    // them shares a name with the template, at THEIR price.
    await request(app).post(`/v1/businesses/${business.id}/menu`).set(auth())
      .send({ name: 'Cutting Chai', price: 7, category: 'My chai' });
    await request(app).post(`/v1/businesses/${business.id}/menu`).set(auth())
      .send({ name: 'Special Thali', price: 199, category: 'My food' });

    const tpl = templates.getTemplate('tea-stall');
    const r = await apply('tea-stall');

    expect(r.status).toBe(200);
    // Every template row EXCEPT the one that clashes by name.
    expect(r.body.alreadyPresent).toEqual(['Cutting Chai']);
    expect(r.body.inserted).toBe(tpl.itemCount - 1);

    // Nothing of the owner's was deleted or re-priced.
    const own = await query(
      'SELECT name, price, category, is_active FROM menu_items WHERE business_id = $1 AND name = $2',
      [business.id, 'Cutting Chai'],
    );
    expect(own.rowCount).toBe(1);
    expect(parseFloat(own.rows[0].price)).toBe(7);
    expect(own.rows[0].category).toBe('My chai');
    expect(own.rows[0].is_active).toBe(true);

    const thali = await query(
      'SELECT price FROM menu_items WHERE business_id = $1 AND name = $2',
      [business.id, 'Special Thali'],
    );
    expect(parseFloat(thali.rows[0].price)).toBe(199);

    expect(await activeCount(business.id)).toBe(tpl.itemCount + 1);
  });

  it('is a no-op when applied a second time', async () => {
    const before = await activeCount(business.id);
    const tpl = templates.getTemplate('tea-stall');
    const r = await apply('tea-stall');
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(r.body.alreadyPresent).toHaveLength(tpl.itemCount);
    expect(await activeCount(business.id)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('POST /menu/templates/:slug/apply — the plan cap', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'tpl-cap@example.com', name: 'Capped Kitchen' });
    token = tokenFor(business);
    await subscribeToPrivatePlan(business.id, {
      tier: 'custom-tplcap', tierKind: 'starter', limits: { menu_items: 10 },
    });
  });

  const apply = (slug) => request(app)
    .post(`/v1/businesses/${business.id}/menu/templates/${slug}/apply`)
    .set({ Authorization: `Bearer ${token}` })
    .send({});

  it('refuses the whole template with the documented PLAN_LIMIT shape and writes zero rows', async () => {
    const tpl = templates.getTemplate('cafe'); // far more than 10 items
    expect(tpl.itemCount).toBeGreaterThan(10);
    expect(await activeCount(business.id)).toBe(0);

    const r = await apply('cafe');

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('PLAN_LIMIT');
    // The four keys every reader parses — dashboard banner, mobile
    // ApiService._maybeTrackPlanLimit, the plan_limit_hit analytics hook.
    expect(r.body.details).toEqual(expect.objectContaining({
      metric: 'menu_items',
      limit: 10,
      current: 0,
      plan: 'custom-tplcap',
    }));
    expect(r.body.details.attempted).toBe(tpl.itemCount);
    expect(r.body.message).toMatch(/Nothing was imported/);

    // HALF A MENU IS THE FAILURE THIS TEST EXISTS FOR.
    expect(await activeCount(business.id)).toBe(0);
  });

  it('lets a template through once the cap is big enough', async () => {
    await query(
      "UPDATE plans SET limits = '{\"menu_items\": 60}'::jsonb WHERE tier = 'custom-tplcap'",
    );
    featureService.clearCache(business.id);
    const tpl = templates.getTemplate('cafe');
    const r = await apply('cafe');
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(tpl.itemCount);
    expect(await activeCount(business.id)).toBe(tpl.itemCount);
  });

  it('a re-apply is not refused for rows it would not insert', async () => {
    // The cap is 60 and the cafe menu is already loaded. A naive
    // implementation would measure the WHOLE template against the remaining
    // room and 403 an owner who is asking for nothing at all.
    const before = await activeCount(business.id);
    const r = await apply('cafe');
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(await activeCount(business.id)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('POST /menu/parse-text — paste a menu', () => {
  let business; let token;

  beforeAll(async () => {
    business = await makeBusiness({ email: 'tpl-paste@example.com', name: 'Paste Kitchen' });
    token = tokenFor(business);
  });

  const parse = (text) => request(app)
    .post(`/v1/businesses/${business.id}/menu/parse-text`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ text });

  it('handles the four line formats plus a section header', async () => {
    const r = await parse([
      'STARTERS',
      'Paneer Tikka 250',
      'Masala Chai - 20',
      '2. Butter Naan .... 40',
      'Main Course:',
      'Dal Makhani Rs 260',
    ].join('\n'));

    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => [i.name, i.price, i.category])).toEqual([
      ['Paneer Tikka', 250, 'Starters'],
      ['Masala Chai', 20, 'Starters'],
      ['Butter Naan', 40, 'Starters'],
      ['Dal Makhani', 260, 'Main Course'],
    ]);
    expect(r.body.categories).toEqual(['Starters', 'Main Course']);
    expect(r.body.unparsed).toEqual([]);
    expect(r.body.stats.headers).toBe(2);
  });

  it('reports garbage as unparsed instead of throwing or inventing a price', async () => {
    const r = await parse([
      'asdkjhasd',
      'Thank you for visiting!',
      '@@@@@@',
      'Paneer Tikka 250',
    ].join('\n'));

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    // The two readable-but-priceless lines come BACK to the owner. Silently
    // swallowing lines is what makes an owner stop trusting the import.
    expect(r.body.unparsed.map((u) => u.line))
      .toEqual(['asdkjhasd', 'Thank you for visiting!']);
    for (const u of r.body.unparsed) expect(typeof u.reason).toBe('string');
  });

  it('never throws on hostile or empty input', async () => {
    expect(() => parseMenuText(null)).not.toThrow();
    expect(() => parseMenuText(undefined)).not.toThrow();
    expect(() => parseMenuText(12345)).not.toThrow();
    expect(() => parseMenuText({ nope: true })).not.toThrow();
    expect(() => parseMenuText('  ﻿')).not.toThrow();
    expect(parseMenuText(null).items).toEqual([]);

    // An empty body is a 400 from validation, not a 500 from the parser.
    const r = await parse('');
    expect(r.status).toBe(400);
  });

  it('does not write anything — the preview is read-only', async () => {
    const before = await activeCount(business.id);
    await parse('Paneer Tikka 250\nButter Naan 40');
    expect(await activeCount(business.id)).toBe(before);
  });

  it('reads the messier shapes: rupee symbols, thousands, price-first, half/full', async () => {
    const r = await parse([
      'Thali ₹1,250',
      'Rs. 120/- Nimbu Pani',
      'Half/Full Paneer 180/320',
      'COLD DRINKS',
      'Cold Coffee@80',
      '[10:31, 05/09/2026] Shiv: Chicken 65 220',
    ].join('\n'));

    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.items.map((i) => [i.name, i]));
    // NOT 1 — a comma is a thousands separator here, not a price pair
    expect(byName.Thali.price).toBe(1250);
    // price written before the name
    expect(byName['Nimbu Pani'].price).toBe(120);
    expect(byName['Half/Full Paneer'].price).toBe(180);
    // flagged, not hidden
    expect(byName['Half/Full Paneer'].confidence).toBe('low');
    expect(byName['Half/Full Paneer'].note).toMatch(/Two prices/);
    expect(byName['Cold Coffee'].price).toBe(80);
    // WhatsApp export chrome stripped
    expect(byName['Chicken 65'].price).toBe(220);
    expect(byName['Chicken 65'].category).toBe('Cold Drinks');
  });

  it('never turns the shop phone number into a menu item', async () => {
    // Almost every pasted menu ends with "Order on 98765 43210". Parsed
    // naively that becomes a dish called "Order on 98765" at 43,210 rupees —
    // the single most likely piece of nonsense a real paste produces.
    const r = await parse([
      'Masala Chai 15',
      'Order on 98765 43210',
      'Call 9876543210 to order',
      '+91 98765 43210',
    ].join('\n'));

    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.name)).toEqual(['Masala Chai']);
    expect(r.body.unparsed).toHaveLength(3);
    for (const u of r.body.unparsed) expect(u.reason).toMatch(/phone number/i);
  });

  it('flags a two-column paste instead of silently losing the left column', async () => {
    // We cannot split two columns reliably, so the row that survives is
    // marked low-confidence with a note. Losing a dish quietly is the
    // failure that makes an owner stop trusting the import.
    const r = await parse('Paneer Tikka 250       Chicken Tikka 320');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].confidence).toBe('low');
    expect(r.body.items[0].note).toMatch(/two items/i);
  });

  it('does not flag dishes whose real names end in a number', async () => {
    // "Chicken 65" is a dish, not a two-column accident. A warning that fires
    // on ordinary rows is a warning the owner learns to ignore.
    const r = await parse('Chicken 65 220\nIdli 2pc 50\nThali 250 gm 180');
    for (const it of r.body.items) expect(it.confidence).toBe('high');
    expect(r.body.items.map((i) => [i.name, i.price])).toEqual([
      ['Chicken 65', 220], ['Idli 2pc', 50], ['Thali 250 gm', 180],
    ]);
  });

  it('feeds the existing bulk import, so the parsed rows land through the capped path', async () => {
    const parsed = await parse('MY MENU\nIdli 50\nVada 60');
    const items = parsed.body.items.map((i) => ({
      name: i.name, price: i.price, category: i.category,
    }));
    const before = await activeCount(business.id);

    const r = await request(app)
      .post(`/v1/businesses/${business.id}/menu/bulk`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ items });

    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(2);
    expect(await activeCount(business.id)).toBe(before + 2);
  });
});
