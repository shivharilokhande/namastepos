// Public brand-site endpoints — no auth.
// Mounted at /v1/site

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const site = require('../services/siteService');
const { query } = require('../config/db');

const router = express.Router();

router.get('/:slug', asyncHandler(async (req, res) => {
  const s = await site.bySlug(req.params.slug);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  // White label (2026-09-06, CONTRACTS §4): `whiteLabel.poweredBy` is the
  // attribution the client prints (null = none); re-checked against the plan
  // on every request by whiteLabelService.effective.
  const wl = await require('../services/whiteLabelService').effective(s.business_id);
  res.json({
    site: s,
    whiteLabel: {
      enabled: wl.enabled,
      brandName: wl.enabled ? wl.brandName : null,
      hidePoweredBy: wl.enabled ? wl.hidePoweredBy : false,
      accentColor: wl.enabled ? wl.accentColor : null,
      poweredBy: wl.poweredBy,
    },
  });
}));

router.get('/:slug/menu', asyncHandler(async (req, res) => {
  const s = await site.bySlug(req.params.slug);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const items = await query(
    `SELECT id, name, description, category, price, image_url, is_veg
       FROM menu_items
      WHERE business_id = $1 AND is_active = TRUE
        -- 2026-09-05 (review #12): a TIMED 86 must come back when it expires;
        -- a bare sold_out_until IS NULL hid the dish on the public site forever.
        AND (sold_out_until IS NULL OR sold_out_until < NOW())
      ORDER BY category, display_order, name`,
    [s.business_id],
  );
  res.json({ menu: items.rows });
}));

// Order tracker (public link with hash token)
router.get('/order-status/:token', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT order_no, status, source, total, created_at, ready_at, collected_at
       FROM orders WHERE tracker_token = $1 LIMIT 1`,
    [req.params.token],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ order: r.rows[0] });
}));

module.exports = router;
