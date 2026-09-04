// Public restaurant mini-site — server-rendered HTML (founder bug #12,
// 2026-08-25).
//
// The dashboard's "Online site" page has always saved site_settings
// (slug, hero, colour, story, contact, publish flag) and the JSON API
// under /v1/site/:slug served it — but NOTHING rendered a human-visible
// page, so "publish" appeared to do nothing. This route is that missing
// renderer: one HTML template, filled per business at request time.
//
//   GET /site/:slug  →  the restaurant's public page (menu + contact)
//
// No per-customer deployment: publishing = flipping is_published in the
// dashboard; the page is live at https://api.namastepos.in/site/<slug>
// immediately (namastepos.in/site/<slug> redirects here via the landing
// project's _redirects file).

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const site = require('../services/siteService');
const { query } = require('../config/db');

const router = express.Router();

/** Escape user-controlled text before interpolation into HTML. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow #rrggbb colours through to the stylesheet. */
function safeColor(c, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : fallback;
}

// Strix L-2 (2026-08-31): HTML-entity escaping is the wrong tool for a URL that
// lands inside `url('…')` in a <style> block or an <img src>. Validate the
// SCHEME against an https?:// allowlist first (blocks javascript:, data:, etc.),
// then escape. Empty string = drop the URL entirely.
function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return esc(s);
}

router.get('/:slug', asyncHandler(async (req, res) => {
  const s = await site.bySlug(req.params.slug);
  if (!s) {
    return res.status(404).send(
      '<!doctype html><meta charset="utf-8"><title>Not found</title>'
      + '<body style="font-family:sans-serif;text-align:center;padding:4rem">'
      + '<h1>404</h1><p>This restaurant page does not exist or is not published.</p>',
    );
  }

  const menuRes = await query(
    `SELECT name, description, category, price, image_url, is_veg
       FROM menu_items
      WHERE business_id = $1 AND is_active = TRUE AND sold_out_until IS NULL
      ORDER BY category, display_order, name`,
    [s.business_id],
  );

  const color = safeColor(s.primary_color, '#FF6B35');
  const name = esc(s.biz_name);
  const phone = esc(s.contact_phone || '');
  const waPhone = (s.contact_phone || '').replace(/[^0-9]/g, '');

  // Group menu by category, preserving SQL order.
  const cats = new Map();
  for (const m of menuRes.rows) {
    const c = m.category || 'Menu';
    if (!cats.has(c)) cats.set(c, []);
    cats.get(c).push(m);
  }

  const menuHtml = [...cats.entries()].map(([cat, items]) => `
    <section class="cat">
      <h2>${esc(cat)}</h2>
      ${items.map((m) => `
        <div class="item">
          ${safeUrl(m.image_url) ? `<img loading="lazy" src="${safeUrl(m.image_url)}" alt="">` : ''}
          <div class="item-body">
            <div class="item-head">
              <span class="veg ${m.is_veg ? 'v' : 'nv'}" title="${m.is_veg ? 'Veg' : 'Non-veg'}"></span>
              <span class="item-name">${esc(m.name)}</span>
              <span class="item-price">₹${Number(m.price).toFixed(0)}</span>
            </div>
            ${m.description ? `<p class="item-desc">${esc(m.description)}</p>` : ''}
          </div>
        </div>`).join('')}
    </section>`).join('');

  res.set('Cache-Control', 'public, max-age=60');
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Menu &amp; Ordering</title>
<meta name="description" content="${esc((s.brand_story || '').slice(0, 150)) || `Menu and contact for ${name}`}">
<style>
  :root { --brand: ${color}; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #222; background: #faf8f5; }
  .hero { background: linear-gradient(160deg, var(--brand), #00000088), #333 center/cover no-repeat;
          ${safeUrl(s.hero_image_url) ? `background-image: linear-gradient(160deg, ${color}cc, #000000aa), url('${safeUrl(s.hero_image_url)}');` : ''}
          color: #fff; padding: 4rem 1.2rem 3rem; text-align: center; }
  .hero h1 { font-size: 2.2rem; letter-spacing: .5px; }
  .hero p { margin-top: .8rem; opacity: .92; max-width: 40rem; margin-inline: auto; line-height: 1.5; }
  .cta { display: inline-block; margin-top: 1.4rem; background: #fff; color: var(--brand);
         font-weight: 700; padding: .8rem 1.6rem; border-radius: 999px; text-decoration: none; }
  main { max-width: 46rem; margin: 0 auto; padding: 1.2rem; }
  .cat h2 { margin: 1.6rem 0 .6rem; font-size: 1.15rem; color: var(--brand);
            border-bottom: 2px solid var(--brand); display: inline-block; padding-bottom: .15rem; }
  .item { display: flex; gap: .8rem; background: #fff; border: 1px solid #eee;
          border-radius: 12px; padding: .8rem; margin-bottom: .6rem; }
  .item img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; flex: none; }
  .item-body { flex: 1; min-width: 0; }
  .item-head { display: flex; align-items: center; gap: .5rem; }
  .item-name { font-weight: 600; flex: 1; }
  .item-price { font-weight: 700; color: var(--brand); }
  .item-desc { font-size: .84rem; color: #777; margin-top: .25rem; line-height: 1.4; }
  .veg { width: 14px; height: 14px; border: 2px solid; border-radius: 3px; position: relative; flex: none; }
  .veg::after { content: ''; position: absolute; inset: 2px; border-radius: 50%; }
  .veg.v { border-color: #2e7d32; } .veg.v::after { background: #2e7d32; }
  .veg.nv { border-color: #b71c1c; } .veg.nv::after { background: #b71c1c; }
  .contact { background: #fff; border: 1px solid #eee; border-radius: 12px;
             padding: 1rem; margin: 1.6rem 0; font-size: .92rem; line-height: 1.7; }
  footer { text-align: center; color: #999; font-size: .78rem; padding: 2rem 0 3rem; }
  footer a { color: var(--brand); text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
  <header class="hero">
    <h1>${name}</h1>
    ${s.brand_story ? `<p>${esc(s.brand_story)}</p>` : ''}
    ${waPhone ? `<a class="cta" href="https://wa.me/${waPhone.length === 10 ? `91${waPhone}` : waPhone}?text=${encodeURIComponent(`Hi! I'd like to order from ${s.biz_name}`)}">Order on WhatsApp</a>` : ''}
  </header>
  <main>
    ${menuHtml || '<p style="text-align:center;color:#999;padding:2rem">Menu coming soon.</p>'}
    <div class="contact">
      <strong>Contact</strong><br>
      ${s.address ? `${esc(s.address)}<br>` : ''}
      ${phone ? `☎ <a href="tel:${phone}">${phone}</a><br>` : ''}
      ${s.contact_email ? `✉ ${esc(s.contact_email)}<br>` : ''}
      ${s.delivery_radius_km ? `Delivery within ${esc(s.delivery_radius_km)} km` : ''}
    </div>
  </main>
  <footer>Powered by <a href="https://namastepos.in">NamastePOS</a></footer>
</body>
</html>`);
}));

module.exports = router;
