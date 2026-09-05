// NamastePOS backend - order routes

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/orderController');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// P1 (Arvind #6): per-business rate limit on order creation so a misbehaving
// POS (or a malicious staff member) can't DoS the kitchen. 60 orders/min per
// business is generous — busiest reported customer averages ~25/min at peak.
const createOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `orders:${req.params.businessId}`,
  message: { error: 'TOO_MANY_ORDERS', message: 'Slow down — too many orders in the last minute' },
});

// `monthly_orders` is a SOFT limit (2026-09-04, decision 5): this middleware
// NEVER refuses the bill. It stays mounted because it is what notices the
// breach — it records the upsell signal and merges a `planLimit` notice into
// the 201 body so analytics still sees the pricing cliff. The soft/hard
// classification is data in subscriptionService.METRIC_POLICY; this line does
// not need to know which class the metric is in.
// 2026-09-05 (churn batch): a PAUSED subscription cannot take new bills. This
// is the only route that gate is mounted on — reads stay open on purpose, see
// churnService.js for the recorded pause decision. It sits before the limit
// middleware because "you are paused" is a truer answer than "you are near
// your plan cap".
router.post('/', createOrderLimiter, sub.blockIfPaused(), sub.enforceLimit('monthly_orders'), ...c.create);
router.get('/', ...c.list);
router.get('/:orderId', c.get);
router.put('/:orderId/status', ...c.updateStatus);
router.put('/:orderId/customer', ...c.assignCustomer);
router.post('/:orderId/print', c.print);

module.exports = router;
