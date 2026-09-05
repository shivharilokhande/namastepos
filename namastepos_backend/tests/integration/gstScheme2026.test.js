// The declared GST scheme (2026-09-05, migration 092).
//
// WHAT THIS LOCKS DOWN
//
// Until today the GST slab on a new menu item defaulted to a hardcoded 5 in
// three separate places, and nothing anywhere asked the owner whether 5 was
// right for them. For most restaurants it is. For a composition dealer it is
// wrong on every bill they hand a customer, and — the part that makes this
// urgent — the moment ORDER_TAX_ENFORCE flips from its 'log' default to
// 'enforce', the server would start ADDING 5% to their bills from the menu's
// own config, silently.
//
// Five properties have to hold:
//
//   1. The scheme is owner-declared through PATCH /auth/me, validated to the
//      three known values, and echoed back so a client can render it.
//   2. A new menu item with no explicit gstPct picks up the scheme's slab —
//      0 for composition, 18 for specified premises, 5 for regular.
//   3. Loading a starter template does the same. The template's own 5% off
//      disk must NOT win over a composition dealer's declared scheme.
//   4. A composition dealer's ORDER carries zero GST even with
//      ORDER_TAX_ENFORCE=enforce and menu rows that still say 5% (items
//      created before they answered the question). This is the regression
//      that would otherwise ship the day that env var is flipped.
//   5. Nothing changes for a business that never answers: 'regular', 5%,
//      exactly the behaviour they have today.
//
// Conventions follow menuTemplates2026.test.js: resetDb / makeBusiness /
// tokenFor.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const gstSchemes = require('../../src/services/gstSchemeService');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');
const templates = require('../../src/services/menuTemplateService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

async function setScheme(businessId, scheme) {
  await query('UPDATE businesses SET gst_scheme = $1 WHERE id = $2',
    [scheme, businessId]);
}

async function gstOf(businessId, name) {
  const r = await query(
    'SELECT gst_pct FROM menu_items WHERE business_id = $1 AND name = $2',
    [businessId, name],
  );
  return r.rowCount ? Number(r.rows[0].gst_pct) : null;
}

// ── 1. Declaring it ───────────────────────────────────────────────────────

describe('declaring the scheme', () => {
  it('defaults to regular and is echoed on the business payload', async () => {
    const business = await makeBusiness({ email: 'gst-default' });
    const token = tokenFor(business);
    const res = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.business.gstScheme).toBe('regular');
  });

  it('PATCH /auth/me accepts the three known schemes', async () => {
    const business = await makeBusiness({ email: 'gst-patch' });
    const token = tokenFor(business);
    for (const scheme of ['composition', 'specified_premises', 'regular']) {
      const res = await request(app)
        .patch('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ gst_scheme: scheme });
      expect(res.status).toBe(200);
      expect(res.body.business.gstScheme).toBe(scheme);
    }
  });

  it('refuses an unknown scheme rather than writing it', async () => {
    const business = await makeBusiness({ email: 'gst-bad' });
    const token = tokenFor(business);
    const res = await request(app)
      .patch('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ gst_scheme: 'made_up' });
    expect(res.status).toBe(400);
    expect(await gstSchemes.getScheme(business.id)).toBe('regular');
  });
});

// ── 2. The menu default ───────────────────────────────────────────────────

describe('menu item GST default follows the scheme', () => {
  it('composition creates items at 0%', async () => {
    const business = await makeBusiness({ email: 'gst-menu-comp' });
    await setScheme(business.id, 'composition');
    await menuService.create(business.id, { name: 'Chai', price: 20 });
    expect(await gstOf(business.id, 'Chai')).toBe(0);
  });

  it('specified premises creates items at 18%', async () => {
    const business = await makeBusiness({ email: 'gst-menu-spec' });
    await setScheme(business.id, 'specified_premises');
    await menuService.create(business.id, { name: 'Chai', price: 20 });
    expect(await gstOf(business.id, 'Chai')).toBe(18);
  });

  it('regular (and an unanswered business) stays at 5%', async () => {
    const business = await makeBusiness({ email: 'gst-menu-reg' });
    await menuService.create(business.id, { name: 'Chai', price: 20 });
    expect(await gstOf(business.id, 'Chai')).toBe(5);
  });

  it('an explicit gstPct from the caller still wins', async () => {
    const business = await makeBusiness({ email: 'gst-menu-explicit' });
    await setScheme(business.id, 'composition');
    await menuService.create(business.id,
      { name: 'Packaged Water', price: 20, gstPct: 12 });
    expect(await gstOf(business.id, 'Packaged Water')).toBe(12);
  });

  it('a CSV import with no GST column follows the scheme', async () => {
    const business = await makeBusiness({ email: 'gst-bulk' });
    await setScheme(business.id, 'composition');
    const r = await menuService.bulkImport(business.id, [
      { name: 'Idli', price: 40 },
      { name: 'Vada', price: 30 },
    ]);
    expect(r.inserted).toBe(2);
    expect(await gstOf(business.id, 'Idli')).toBe(0);
    expect(await gstOf(business.id, 'Vada')).toBe(0);
  });

  it('a CSV that DOES name a GST column keeps the file\'s value', async () => {
    const business = await makeBusiness({ email: 'gst-bulk-explicit' });
    await setScheme(business.id, 'composition');
    const r = await menuService.bulkImport(business.id, [
      { name: 'Cold Drink', price: 40, gst_pct: 28 },
    ]);
    expect(r.inserted).toBe(1);
    expect(await gstOf(business.id, 'Cold Drink')).toBe(28);
  });
});

// ── 3. Templates ──────────────────────────────────────────────────────────

describe('starter templates respect the scheme', () => {
  const slug = templates.listTemplates()[0].slug;

  it("a composition dealer's loaded menu is entirely 0%, not the template's 5%",
    async () => {
      const business = await makeBusiness({ email: 'gst-tpl-comp' });
      await setScheme(business.id, 'composition');
      const r = await templates.applyTemplate(business.id, slug);
      expect(r.inserted).toBeGreaterThan(0);
      const rows = await query(
        'SELECT DISTINCT gst_pct FROM menu_items WHERE business_id = $1',
        [business.id],
      );
      expect(rows.rows.map((x) => Number(x.gst_pct))).toEqual([0]);
    });

  it('a regular business keeps the per-item slabs the template ships',
    async () => {
      const business = await makeBusiness({ email: 'gst-tpl-reg' });
      const r = await templates.applyTemplate(business.id, slug);
      expect(r.inserted).toBeGreaterThan(0);
      const rows = await query(
        `SELECT COUNT(*)::int AS c FROM menu_items
          WHERE business_id = $1 AND gst_pct = 0`,
        [business.id],
      );
      // Nothing was zeroed — the template's own slabs survived.
      expect(rows.rows[0].c).toBe(0);
    });
});

// ── 4. The bill — the regression that matters ─────────────────────────────

describe('a composition dealer is never charged GST on an order', () => {
  const prev = process.env.ORDER_TAX_ENFORCE;
  beforeAll(() => { process.env.ORDER_TAX_ENFORCE = 'enforce'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.ORDER_TAX_ENFORCE;
    else process.env.ORDER_TAX_ENFORCE = prev;
  });

  it('zeroes GST even when the menu row still says 5%', async () => {
    const business = await makeBusiness({ email: 'gst-order-comp' });
    // Item created BEFORE the owner answered the question — it carries 5%,
    // which is exactly the case that would otherwise re-add tax under
    // ORDER_TAX_ENFORCE=enforce.
    const item = await menuService.create(business.id,
      { name: 'Thali', price: 100 });
    expect(Number((await query(
      'SELECT gst_pct FROM menu_items WHERE id = $1', [item.id],
    )).rows[0].gst_pct)).toBe(5);

    await setScheme(business.id, 'composition');

    const order = await orderService.create(business.id, {
      items: [{ menuItemId: item.id, name: 'Thali', price: 100, qty: 1 }],
      source: 'takeaway',
      paymentMethod: 'cash',
    });
    expect(Number(order.tax)).toBe(0);
    expect(Number(order.total)).toBe(100);
    const row = await query(
      'SELECT tax, cgst, sgst, igst FROM orders WHERE id = $1', [order.id],
    );
    expect(Number(row.rows[0].tax)).toBe(0);
    expect(Number(row.rows[0].cgst)).toBe(0);
    expect(Number(row.rows[0].sgst)).toBe(0);
    expect(Number(row.rows[0].igst)).toBe(0);
  });

  it('a regular business on the same order DOES get the server GST', async () => {
    const business = await makeBusiness({ email: 'gst-order-reg' });
    const item = await menuService.create(business.id,
      { name: 'Thali', price: 100 });
    const order = await orderService.create(business.id, {
      items: [{ menuItemId: item.id, name: 'Thali', price: 100, qty: 1 }],
      source: 'takeaway',
      paymentMethod: 'cash',
    });
    // 5% of 100, computed server-side from the menu row.
    expect(Number(order.tax)).toBeCloseTo(5, 2);
  });
});

// ── 5. The resolver itself ────────────────────────────────────────────────

describe('gstSchemeService', () => {
  it('maps each scheme to a slab menu_items.gst_pct actually allows', () => {
    expect(gstSchemes.defaultGstPct('regular')).toBe(5);
    expect(gstSchemes.defaultGstPct('composition')).toBe(0);
    expect(gstSchemes.defaultGstPct('specified_premises')).toBe(18);
  });

  it('fails OPEN to 5% for an unknown or missing scheme', async () => {
    // A scheme we cannot read must never silently zero somebody's GST.
    expect(gstSchemes.defaultGstPct(null)).toBe(5);
    expect(gstSchemes.defaultGstPct('something_new')).toBe(5);
    expect(await gstSchemes.getScheme(null)).toBe('regular');
    expect(await gstSchemes.defaultGstPctFor(
      '00000000-0000-0000-0000-000000000000',
    )).toBe(5);
  });

  it('only composition means "no GST on the bill"', () => {
    expect(gstSchemes.chargesNoGst('composition')).toBe(true);
    expect(gstSchemes.chargesNoGst('regular')).toBe(false);
    expect(gstSchemes.chargesNoGst('specified_premises')).toBe(false);
  });
});
