// Round-2 fix batch (2026-09-06), CONTRACTS §4 — white label.
//
// `white_label` was sold on Enterprise and enforced nowhere. Now:
//   • GET/PUT /businesses/:id/white-label (owner, requireFeature('white_label'))
//     round-trips { enabled, brandName, hidePoweredBy, accentColor };
//   • the EFFECT is applied at render time by whiteLabelService.effective(),
//     which re-checks the plan: guest QR JSON, public site JSON + HTML and the
//     receipt text hide / rebrand "Powered by NamastePOS" only while enabled
//     AND entitled, and fall back to NamastePOS the moment the plan loses the
//     key — without touching the saved settings.

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const buildApp = require('../../src/app');
const {
  resetDb, makeBusiness, tokenFor, closePool,
} = require('../setup');
const { query } = require('../../src/config/db');
const env = require('../../src/config/env');
const featureService = require('../../src/services/featureService');
const whiteLabel = require('../../src/services/whiteLabelService');
const { formatToken } = require('../../src/utils/tokenPrinter');

/** See apiKeysRound2B: shim until app.js carries the mount; real app after. */
function appUnderTest() {
  const real = buildApp();
  const mounted = (real._router.stack || []).some((l) => l.regexp && l.regexp.test(`${env.API_PREFIX}/businesses/x/white-label`)
    && l.name === 'router' && l.handle && l.handle.stack
    && l.handle.stack.some((s) => s.route && s.route.methods && s.route.methods.put && s.route.path === '/'));
  if (mounted) return real;
  const shim = express();
  shim.set('trust proxy', 1);
  shim.use(express.json());
  shim.use(cookieParser());
  shim.use(`${env.API_PREFIX}/businesses/:businessId`, require('../../src/middleware/featureGate')());
  shim.use(`${env.API_PREFIX}/businesses/:businessId/white-label`, require('../../src/routes/whiteLabel.routes'));
  shim.use(real);
  // Errors raised inside the shim-mounted router skip the sub-app (Express
  // routes errors past plain middleware), so the real JSON error handler is
  // mounted here too — exactly the one app.js registers last.
  shim.use(require('../../src/middleware/errorHandler').errorHandler);
  return shim;
}

let app;
let ent; let entToken;
let starter;
let slug; let qrToken;
const H = (t) => ({ Authorization: `Bearer ${t}` });

async function putOnPlan(biz, tier) {
  const planId = (await query('SELECT id FROM plans WHERE tier = $1', [tier])).rows[0].id;
  await query(
    `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '1 month')
     ON CONFLICT (business_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
    [biz.id, planId],
  );
  featureService.clearCache(biz.id);
}

beforeAll(async () => {
  await resetDb();
  app = appUnderTest();
  ent = await makeBusiness({ name: 'Brand Bistro', email: 'wl-ent@example.com' });
  starter = await makeBusiness({ name: 'Plain Stall', email: 'wl-free@example.com' });
  await putOnPlan(ent, 'pro'); // seed: 'pro' carries white_label
  await putOnPlan(starter, 'free');
  entToken = tokenFor(ent);
  expect(await featureService.hasFeature(ent.id, 'white_label')).toBe(true);
  expect(await featureService.hasFeature(starter.id, 'white_label')).toBe(false);

  // A published mini-site + a QR table token for the render-time checks.
  slug = `brand-bistro-${Date.now()}`;
  await query(
    `INSERT INTO site_settings (business_id, brand_slug, is_published) VALUES ($1, $2, TRUE)
     ON CONFLICT (business_id) DO UPDATE SET brand_slug = EXCLUDED.brand_slug, is_published = TRUE`,
    [ent.id, slug],
  );
  // Same setup guest_benefit2026 uses: a floor, a table, a QR token.
  const floor = (await query(
    'INSERT INTO floors (business_id, name) VALUES ($1, \'Ground\') RETURNING id',
    [ent.id],
  )).rows[0];
  const table = await require('../../src/services/tableService').createTable(ent.id, { floorId: floor.id, label: 'T1', seats: 4 });
  qrToken = await require('../../src/services/qrService').issueTokenForTable(ent.id, table.id);
  await query('UPDATE tables SET qr_enabled = TRUE WHERE id = $1', [table.id]);
});
afterAll(async () => { await closePool(); });

describe('settings endpoint', () => {
  it('GET returns defaults when nothing is saved', async () => {
    const r = await request(app).get(`/v1/businesses/${ent.id}/white-label`).set(H(entToken));
    expect(r.status).toBe(200);
    expect(r.body.whiteLabel).toEqual({ enabled: false, brandName: null, hidePoweredBy: false, accentColor: null });
  });

  it('PUT/GET round-trip (validated + normalised)', async () => {
    const put = await request(app).put(`/v1/businesses/${ent.id}/white-label`).set(H(entToken))
      .send({ enabled: true, brandName: '  Brand Bistro Digital ', hidePoweredBy: false, accentColor: '#1A2B3C' });
    expect(put.status).toBe(200);
    expect(put.body.whiteLabel).toEqual({
      enabled: true, brandName: 'Brand Bistro Digital', hidePoweredBy: false, accentColor: '#1a2b3c',
    });
    const get = await request(app).get(`/v1/businesses/${ent.id}/white-label`).set(H(entToken));
    expect(get.body.whiteLabel).toEqual(put.body.whiteLabel);
    const col = (await query('SELECT white_label FROM businesses WHERE id = $1', [ent.id])).rows[0].white_label;
    expect(col.brandName).toBe('Brand Bistro Digital');
  });

  it('rejects a bad colour and unknown fields (400)', async () => {
    const a = await request(app).put(`/v1/businesses/${ent.id}/white-label`).set(H(entToken)).send({ accentColor: 'red' });
    expect(a.status).toBe(400);
    const b = await request(app).put(`/v1/businesses/${ent.id}/white-label`).set(H(entToken)).send({ logoUrl: 'x' });
    expect(b.status).toBe(400);
  });

  it('Starter → 402 FEATURE_LOCKED on GET and PUT', async () => {
    const t = tokenFor(starter);
    const g = await request(app).get(`/v1/businesses/${starter.id}/white-label`).set(H(t));
    expect(g.status).toBe(402);
    expect(g.body.feature).toBe('white_label');
    const p = await request(app).put(`/v1/businesses/${starter.id}/white-label`).set(H(t)).send({ enabled: true });
    expect(p.status).toBe(402);
  });

  it('staff cannot change branding (403)', async () => {
    const staff = (await query(
      'INSERT INTO users (email, display_name, google_sub) VALUES (\'wl-cashier@example.com\', \'Cashier\', \'sub-wl-cashier\') RETURNING id',
    )).rows[0];
    await query(
      'INSERT INTO business_users (business_id, user_id, role, is_active) VALUES ($1, $2, \'staff_cashier\', TRUE)',
      [ent.id, staff.id],
    );
    const t = require('../../src/utils/jwt').issueAccessToken({ sub: staff.id, bid: ent.id, role: 'staff_cashier' });
    const r = await request(app).put(`/v1/businesses/${ent.id}/white-label`).set(H(t)).send({ enabled: false });
    expect(r.status).toBe(403);
  });
});

describe('render-time effect', () => {
  it('guest QR page carries the brand while enabled + entitled', async () => {
    expect(qrToken).toBeTruthy();
    const r = await request(app).get(`/v1/guest/menu/${qrToken}`);
    expect(r.status).toBe(200);
    expect(r.body.whiteLabel).toEqual({
      enabled: true,
      brandName: 'Brand Bistro Digital',
      hidePoweredBy: false,
      accentColor: '#1a2b3c',
      poweredBy: 'Brand Bistro Digital',
    });
    expect(r.body.business.name).toBe('Brand Bistro'); // the restaurant's own name is untouched
  });

  it('public site JSON + HTML: brand replaces NamastePOS; hidePoweredBy drops the footer', async () => {
    const j = await request(app).get(`/v1/site/${slug}`);
    expect(j.status).toBe(200);
    expect(j.body.whiteLabel.poweredBy).toBe('Brand Bistro Digital');
    const h = await request(app).get(`/site/${slug}`);
    expect(h.status).toBe(200);
    expect(h.text).toContain('Powered by Brand Bistro Digital');
    expect(h.text).not.toContain('Powered by <a href="https://namastepos.in">NamastePOS</a>');

    await request(app).put(`/v1/businesses/${ent.id}/white-label`).set(H(entToken))
      .send({ enabled: true, brandName: 'Brand Bistro Digital', hidePoweredBy: true })
      .expect(200);
    const h2 = await request(app).get(`/site/${slug}`);
    expect(h2.text).not.toContain('Powered by');
    const g2 = await request(app).get(`/v1/guest/menu/${qrToken}`);
    expect(g2.body.whiteLabel.poweredBy).toBeNull();
    expect(g2.body.whiteLabel.hidePoweredBy).toBe(true);
  });

  it('receipt text honours the resolved brand (caller passes effective())', async () => {
    const order = {
      orderNo: 7,
      source: 'pos',
      createdAt: new Date().toISOString(),
      items: [{ name: 'Dosa', qty: 1, price: 60 }],
      subtotal: 60,
      tax: 0,
      discount: 0,
      total: 60,
      paymentMethod: 'cash',
    };
    const biz = { name: 'Brand Bistro' };
    expect(formatToken(order, biz)).toContain('Powered by NamastePOS');
    const eff = await whiteLabel.effective(ent.id);
    expect(eff.enabled).toBe(true);
    expect(eff.poweredBy).toBeNull(); // hidePoweredBy from the previous test
    expect(formatToken(order, biz, 32, { whiteLabel: eff })).not.toContain('Powered by');
    expect(formatToken(order, biz, 32, { whiteLabel: { poweredBy: 'Acme POS' } })).toContain('Powered by Acme POS');
  });

  it('the plan losing white_label turns it all back to NamastePOS — settings untouched', async () => {
    await putOnPlan(ent, 'free');
    const eff = await whiteLabel.effective(ent.id);
    expect(eff.enabled).toBe(false);
    expect(eff.entitled).toBe(false);
    expect(eff.poweredBy).toBe('NamastePOS');
    const g = await request(app).get(`/v1/guest/menu/${qrToken}`);
    expect(g.body.whiteLabel).toEqual({
      enabled: false, brandName: null, hidePoweredBy: false, accentColor: null, poweredBy: 'NamastePOS',
    });
    const h = await request(app).get(`/site/${slug}`);
    expect(h.text).toContain('Powered by <a href="https://namastepos.in">NamastePOS</a>');
    // Saved settings survive the downgrade…
    const col = (await query('SELECT white_label FROM businesses WHERE id = $1', [ent.id])).rows[0].white_label;
    expect(col.enabled).toBe(true);
    // …and come straight back on upgrade.
    await putOnPlan(ent, 'pro');
    expect((await whiteLabel.effective(ent.id)).enabled).toBe(true);
  });

  it('effective() never throws for an unknown business', async () => {
    const eff = await whiteLabel.effective('00000000-0000-0000-0000-000000000000');
    expect(eff.enabled).toBe(false);
    expect(eff.poweredBy).toBe('NamastePOS');
  });
});
