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
  res.json({ site: s });
}));

router.get('/:slug/menu', asyncHandler(async (req, res) => {
  const s = await site.bySlug(req.params.slug);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const items = await query(
    `SELECT id, name, description, category, price, image_url, is_veg
       FROM menu_items
      WHERE business_id = $1 AND is_active = TRUE AND sold_out_until IS NULL
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
