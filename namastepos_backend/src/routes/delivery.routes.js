// Delivery & channels — aggregator credentials/mapping/OTP-linking, delivery
// zones, drivers and delivery assignments.
//
// NP-145 (2026-09-03): split out of sprintsAll.routes.js. Pure move — same
// paths, same middleware order, same handlers. Mounted by sprintsAll.routes.js
// under /v1/businesses/:businessId AFTER requireAuth + requireBusinessOwnership
// — do not mount this router directly.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireRole } = require('../middleware/auth');

const aggregator = require('../services/aggregatorService');
const zones = require('../services/deliveryZoneService');
const driver = require('../services/driverService');

const router = express.Router({ mergeParams: true });

// ── Delivery fulfilment board (2026-09-03) ─────────────────────────────
// The live accept → preparing → ready → handover → delivered flow, shared by
// the dashboard board and the mobile app. Anyone who works the floor needs it
// (captain, cashier, kitchen), so it is role-gated to exclude nobody except
// where money is involved — the transition itself carries no financial risk
// beyond the delivered→collected mirror, which orderService owns.
const fulfilment = require('../services/fulfilmentService');

router.get('/fulfilment/board', asyncHandler(async (req, res) => {
  res.json({ orders: await fulfilment.board(req.params.businessId) });
}));

router.post(
  '/fulfilment/:orderId/transition',
  validate({ body: Joi.object({
    state: Joi.string().valid(...fulfilment.STATES).required(),
    // Required when accepting: the kitchen's promise, shown to the diner.
    prepMinutes: Joi.number().integer().min(1).max(240),
    // Required when rejecting.
    reason: Joi.string().max(500),
    rider: Joi.object({
      name: Joi.string().max(120).allow('', null),
      phone: Joi.string().max(20).allow('', null),
      otp: Joi.string().max(8).allow('', null),
    }),
    // The code staff typed off the delivery partner's screen.
    otp: Joi.string().max(8),
  }) }),
  asyncHandler(async (req, res) => {
    res.json({
      order: await fulfilment.transition(req.params.businessId, req.params.orderId, req.body),
    });
  }),
);

// ── FF-331 delivery zones ──────────────────────────────────────────────
router.get(
  '/delivery-zones',
  asyncHandler(async (req, res) => res.json({ zones: await zones.list(req.params.businessId) })),
);
router.put(
  '/delivery-zones',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    id: Joi.string().uuid(),
    name: Joi.string().max(80).required(),
    feeInr: Joi.number().min(0).precision(2).default(0),
    minOrderInr: Joi.number().min(0).precision(2).default(0),
    pincodes: Joi.array().items(Joi.string().length(6)).default([]),
    displayOrder: Joi.number().integer().default(100),
  }) }),
  asyncHandler(async (req, res) => res.json(await zones.upsert(req.params.businessId, req.body))),
);
router.delete(
  '/delivery-zones/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await zones.remove(req.params.businessId, req.params.id);
    res.json({ ok: true });
  }),
);

// ── Aggregator credentials + mapping ─────────────────────────────────────
router.get('/aggregators', asyncHandler(async (req, res) => res.json({ credentials: await aggregator.listCredentials(req.params.businessId) })));
router.put(
  '/aggregators',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato', 'swiggy', 'dunzo', 'magicpin').required(),
    outletId: Joi.string().max(100).allow('', null),
    apiKey: Joi.string().allow('', null),
    webhookSecret: Joi.string().allow('', null),
    autoAccept: Joi.boolean().default(false),
  }) }),
  asyncHandler(async (req, res) => res.json({ credentials: await aggregator.upsertCredentials(req.params.businessId, req.body) })),
);
router.get('/aggregators/mapping-issues', asyncHandler(async (req, res) => res.json({ issues: await aggregator.listMappingIssues(req.params.businessId) })));
router.post(
  '/aggregators/menu-items/:itemId/sku',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato', 'swiggy', 'dunzo', 'magicpin').required(),
    sku: Joi.string().max(80).required(),
  }) }),
  asyncHandler(async (req, res) => {
    await aggregator.setExternalSku(req.params.businessId, req.params.itemId, req.body.provider, req.body.sku);
    res.json({ success: true });
  }),
);

// ── Aggregator OTP-based merchant linking (2026-08-22) ───────────────────
// UX: owner picks Zomato/Swiggy → enters their merchant-linked phone →
// receives OTP → enters OTP → link created. See aggregatorLinkService.js
// for the full design + Partner-API vs reverse-engineered discussion.
const aggregatorLink = require('../services/aggregatorLinkService');

router.post(
  '/aggregators/link/start',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    provider: Joi.string().valid('zomato', 'swiggy').required(),
    phone: Joi.string().max(20).required(),
  }) }),
  asyncHandler(async (req, res) => {
    const out = await aggregatorLink.startLink({
      businessId: req.params.businessId,
      provider: req.body.provider,
      phone: req.body.phone,
    });
    res.json(out);
  }),
);
router.post(
  '/aggregators/link/verify',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    sessionId: Joi.string().uuid().required(),
    code: Joi.string().length(6).pattern(/^\d+$/).required(),
  }) }),
  asyncHandler(async (req, res) => {
    const out = await aggregatorLink.verifyLink({
      businessId: req.params.businessId,
      sessionId: req.body.sessionId,
      code: req.body.code,
    });
    res.json(out);
  }),
);
router.get(
  '/aggregators/link/sessions',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    const sessions = await aggregatorLink.listSessions(req.params.businessId);
    res.json({ sessions });
  }),
);

// ── Drivers ──────────────────────────────────────────────────────────────
// Sync-fix (2026-08-22): the following routes previously had no role
// gate — any authenticated user (including kitchen role) could list
// drivers, edit them, ping their location, or assign them to orders.
// Aligned with the driver-management responsibility (owner + manager
// for CRUD; owner + manager + cashier for assign/mark-status because
// the counter staff are the ones who actually dispatch).
router.get(
  '/drivers',
  // staff_driver added 2026-08-22 — riders pick themselves in the app.
  requireRole(['business_owner', 'staff_manager', 'staff_cashier', 'staff_driver']),
  asyncHandler(async (req, res) => res.json({ drivers: await driver.list(req.params.businessId) })),
);
router.post(
  '/drivers',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().required(),
    vehicleNo: Joi.string().allow('', null),
    vehicleType: Joi.string().valid('bike', 'scooter', 'car', 'cycle', 'other'),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ driver: await driver.create(req.params.businessId, req.body) })),
);
router.put(
  '/drivers/:id',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.json({ driver: await driver.update(req.params.businessId, req.params.id, req.body) })),
);
router.post(
  '/drivers/:id/ping',
  // Ping is called by the driver's own app — the driver is authenticated
  // as their own user. Allow all roles so both the driver's PIN-login
  // session and the manager (for admin overrides) can call it.
  validate({ body: Joi.object({ lat: Joi.number().required(), lng: Joi.number().required() }) }),
  asyncHandler(async (req, res) => {
    await driver.ping(req.params.businessId, req.params.id, req.body);
    res.json({ success: true });
  }),
);
router.post(
  '/orders/:orderId/assign-driver',
  requireRole(['business_owner', 'staff_manager', 'staff_cashier']),
  validate({ body: Joi.object({
    driverId: Joi.string().uuid().required(),
    address: Joi.string().allow('', null),
    lat: Joi.number().allow(null),
    lng: Joi.number().allow(null),
    distanceKm: Joi.number().allow(null),
    deliveryFeePaise: Joi.number().integer().min(0).default(0),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ assignment: await driver.assignOrder(req.params.businessId, req.params.orderId, req.body.driverId, req.body) })),
);
router.put(
  '/delivery-assignments/:id/status',
  // staff_driver added 2026-08-22 — riders mark picked-up/delivered.
  requireRole(['business_owner', 'staff_manager', 'staff_cashier', 'staff_driver']),
  validate({ body: Joi.object({ status: Joi.string().valid('assigned', 'picked_up', 'delivered', 'failed').required() }) }),
  asyncHandler(async (req, res) => res.json({ assignment: await driver.markStatus(req.params.businessId, req.params.id, req.body.status) })),
);
router.get(
  '/delivery-assignments/live',
  // staff_driver added 2026-08-22 — riders see their own job queue.
  requireRole(['business_owner', 'staff_manager', 'staff_cashier', 'staff_driver']),
  asyncHandler(async (req, res) => res.json({ assignments: await driver.liveAssignments(req.params.businessId) })),
);

module.exports = router;
