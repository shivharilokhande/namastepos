// NamastePOS backend - addon routes
// Mounted twice:
//   /v1/addons                              public catalog
//   /v1/businesses/:businessId/addons       per-tenant (active list, subscribe, cancel)

const express = require('express');
const c = require('../controllers/addonController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const addonService = require('../services/addonService');
const { BadRequest } = require('../utils/errors');

const publicRouter = express.Router();
publicRouter.get('/', c.catalog);
module.exports.publicRouter = publicRouter;

const businessRouter = express.Router({ mergeParams: true });
businessRouter.use(requireAuth, requireBusinessOwnership);
businessRouter.get   ('/',                       c.myAddons);
businessRouter.post  ('/subscribe',              requireRole('business_owner'), ...c.subscribe);
businessRouter.post  ('/:slug/cancel',           requireRole('business_owner'), c.cancel);
businessRouter.post  ('/:slug/resume',           requireRole('business_owner'), c.resume);
// 2026-08-25 (founder bug: addons subscribed without charging) — second leg
// of the paid-addon checkout. POST /subscribe now returns a Razorpay order
// for paid addons instead of activating; the dashboard posts Checkout.js's
// success payload here, addonService verifies the HMAC signature and only
// then activates. Handler lives inline so the change surface stays within
// the files cleared for this fix (controller untouched).
businessRouter.post  ('/:slug/confirm-payment',  requireRole('business_owner'),
  asyncHandler(async (req, res) => {
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body || {};
    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      throw new BadRequest('razorpayPaymentId, razorpayOrderId and razorpaySignature are required');
    }
    const r = await addonService.confirmPayment(req.params.businessId, req.params.slug, {
      razorpayPaymentId: String(razorpayPaymentId),
      razorpayOrderId: String(razorpayOrderId),
      razorpaySignature: String(razorpaySignature),
    });
    res.json(r);
  }));
businessRouter.put   ('/:slug/settings',         requireRole(['business_owner','staff_manager']), c.updateSettings);
module.exports.businessRouter = businessRouter;
