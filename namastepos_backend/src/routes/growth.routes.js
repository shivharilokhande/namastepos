// Growth & engagement — referral, promo evaluation, feature-flag overrides,
// memberships, the online-ordering brand site and WhatsApp campaigns.
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

const membership = require('../services/membershipService');
const site = require('../services/siteService');
const whatsapp = require('../services/whatsappService');
const featureFlags = require('../services/featureFlagsService');
const referral = require('../services/referralService');
const promo = require('../services/promoRulesService');

const router = express.Router({ mergeParams: true });

// ── FF-333 referral ────────────────────────────────────────────────────
router.get('/referral',
  asyncHandler(async (req, res) => {
    const code = await referral.myCode(req.params.businessId);
    const stats = await referral.stats(req.params.businessId);
    res.json({ code, stats });
  }));

// ── FF-329 promo evaluation ────────────────────────────────────────────
router.post('/promo/evaluate',
  validate({ body: Joi.object({
    code: Joi.string().required(),
    customerId: Joi.string().uuid().allow(null),
    orderSubtotalInr: Joi.number().min(0).required(),
  })}),
  asyncHandler(async (req, res) =>
    res.json(await promo.evaluate({ ...req.body, businessId: req.params.businessId }))));

// ── FF-315 Feature-flag overrides (owner-scoped read; write is admin-only elsewhere) ──
router.get('/feature-overrides',
  asyncHandler(async (req, res) =>
    res.json({ overrides: await featureFlags.list(req.params.businessId) })));

// ── Membership plans + subscriptions ─────────────────────────────────────
router.get ('/memberships', asyncHandler(async (req, res) =>
  res.json({ memberships: await membership.listMemberships(req.params.businessId) })));
// 2026-08-26: roster of customers who hold a membership (name/phone/plan/
// amount/status/expiry) for the Members list on mobile + web.
router.get ('/memberships/subscribers', asyncHandler(async (req, res) =>
  res.json({ subscribers: await membership.listSubscribers(req.params.businessId) })));
router.post('/memberships',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    name: Joi.string().required(), description: Joi.string().allow('', null),
    priceInr: Joi.number().positive().required(),
    validityDays: Joi.number().integer().min(1).max(3650).default(30),
    benefits: Joi.object().unknown(true).allow(null),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ membership: await membership.createMembership(req.params.businessId, req.body) }))
);
// Membership plan Update + Delete (2026-08-24): screen had create+read only.
router.put('/memberships/:id',
  requireRole(['business_owner']),
  // NB: don't validate params here — mergeParams injects businessId too and
  // the strict validator rejects unknown keys. The :id is used in a
  // business-scoped query, so a bad/foreign id simply 404s.
  validate({
    body: Joi.object({
      name: Joi.string(), description: Joi.string().allow('', null),
      priceInr: Joi.number().positive(),
      validityDays: Joi.number().integer().min(1).max(3650),
      benefits: Joi.object().unknown(true).allow(null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ membership: await membership.updateMembership(req.params.businessId, req.params.id, req.body) }))
);
router.delete('/memberships/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.json(await membership.deleteMembership(req.params.businessId, req.params.id)))
);
router.post('/memberships/subscribe',
  validate({ body: Joi.object({
    customerId: Joi.string().uuid().required(),
    membershipId: Joi.string().uuid().required(),
    // NP-116 (2026-09-03): optional idempotency key — a retried subscribe
    // with the same clientKey returns the original sale instead of selling
    // (and wallet-debiting) twice. Same pattern as orders.clientId.
    clientKey: Joi.string().max(64).allow(null),
    // 2026-08-25 (founder): membership sell is a real payment now —
    // 'wallet' debits the customer wallet atomically with the sale, and an
    // optional paymentBreakdown splits the plan price across 1-3 tenders
    // (service enforces legs sum = plan price ±₹0.01, else 400).
    paymentMethod: Joi.string().valid('cash','upi','card','online','wallet').default('cash'),
    paymentBreakdown: Joi.array().items(Joi.object({
      method: Joi.string().valid('cash','upi','card','online','wallet').required(),
      amountInr: Joi.number().positive().required(),
    })).min(1).max(3).allow(null),
  })}),
  asyncHandler(async (req, res) => res.status(201).json({ subscription: await membership.subscribe(req.params.businessId, req.body) }))
);
// 2026-08-25 (founder): cancel a sold membership → refund the unused share.
// Remaining value = price paid × (remaining bundle qty ÷ original bundle
// qty) — time-prorated for plans without an item bundle — minus the
// cancellation charge (cancellationPct, default 10). mode 'wallet' credits
// the customer wallet (ledger reason 'membership_refund'); 'cash'/'upi'
// records a payout in `refunds` so the income statement can net it off as
// 'Membership refunds'. Owner/manager only — refunds move money.
router.post('/customer-memberships/:id/cancel',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    mode: Joi.string().valid('wallet', 'cash', 'upi').required(),
    cancellationPct: Joi.number().min(0).max(100).allow(null),
  })}),
  asyncHandler(async (req, res) => res.json(
    await membership.cancelSubscription(
      req.params.businessId, req.params.id, {
        mode: req.body.mode,
        cancellationPct: req.body.cancellationPct ?? null,
      })))
);

// ── Site (online ordering brand site) ───────────────────────────────────
router.get ('/site', asyncHandler(async (req, res) =>
  res.json({ site: await site.get(req.params.businessId) })));
router.put ('/site',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    brandSlug: Joi.string().lowercase().pattern(/^[a-z0-9-]{2,60}$/).allow('', null),
    heroImageUrl: Joi.string().uri().allow('', null),
    primaryColor: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null),
    brandStory: Joi.string().max(2000).allow('', null),
    contactEmail: Joi.string().email().allow('', null),
    contactPhone: Joi.string().max(20).allow('', null),
    address: Joi.string().max(500).allow('', null),
    deliveryRadiusKm: Joi.number().min(0).max(100),
    minOrderInr: Joi.number().min(0),
    deliveryFeeInr: Joi.number().min(0),
    isPublished: Joi.boolean(),
  })}),
  asyncHandler(async (req, res) =>
    res.json({ site: await site.update(req.params.businessId, req.body) })
  )
);

// ── WhatsApp campaigns ──────────────────────────────────────────────────
router.get ('/wa/campaigns', asyncHandler(async (req, res) =>
  res.json({ campaigns: await whatsapp.listCampaigns(req.params.businessId) })));
router.post('/wa/campaigns',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(),
    templateBody: Joi.string().required(),
    audienceFilter: Joi.object().unknown(true).allow(null),
    scheduledAt: Joi.date().iso().allow(null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ campaign: await whatsapp.createCampaign(req.params.businessId, req.body, req.user?.id) })
  )
);
router.post('/wa/campaigns/:id/run',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) =>
    res.json(await whatsapp.runCampaign(req.params.businessId, req.params.id))
  )
);

module.exports = router;
