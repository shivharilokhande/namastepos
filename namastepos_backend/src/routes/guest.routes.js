// NamastePOS backend - guest QR routes (PUBLIC — no auth)
// Token from URL is the only thing protecting these endpoints.

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/guestController');

const router = express.Router();

const tokenLimiter = rateLimit({
  windowMs: 60_000, max: 100,          // 100 requests/min per IP per token
  keyGenerator: (req) => `${req.ip}:${req.params.token?.slice(0, 16) || ''}`,
  standardHeaders: true, legacyHeaders: false,
});

router.get ('/menu/:token',                   tokenLimiter, c.menu);
router.post('/orders/:token',                 tokenLimiter, ...c.placeOrder);
router.get ('/orders/:token/:orderId',        tokenLimiter, c.orderStatus);
// FF-250 — guest can pay via Razorpay Checkout without any NamastePOS login
router.post('/orders/:token/:orderId/pay',         tokenLimiter, c.createCheckoutOrder);
router.post('/orders/:token/:orderId/confirm-pay', tokenLimiter, ...c.confirmPayment);
// FF-251 — running bill for this table's open session + settle all in one go
router.get ('/session/:token/current',             tokenLimiter, c.getRunningSession);
router.post('/session/:token/pay',                 tokenLimiter, c.paySession);
router.post('/session/:token/confirm-pay',         tokenLimiter, ...c.confirmSessionPayment);

module.exports = router;
