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

router.post('/', createOrderLimiter, sub.enforceLimit('monthly_orders'), ...c.create);
router.get('/', ...c.list);
router.get('/:orderId', c.get);
router.put('/:orderId/status', ...c.updateStatus);
router.put('/:orderId/customer', ...c.assignCustomer);
router.post('/:orderId/print', c.print);

module.exports = router;
