// NamastePOS backend - customer CRM endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const customers = require('../services/customerService');
const loyalty = require('../services/loyaltyService');

const listQuery = Joi.object({
  search: Joi.string().max(100),
  tier: Joi.string().valid('bronze', 'silver', 'gold'),
  sort: Joi.string().valid('recent', 'top_spender', 'top_loyalty').default('recent'),
  limit: Joi.number().integer().min(1).max(500)
    .default(100),
  offset: Joi.number().integer().min(0).default(0),
});

const upsertBody = Joi.object({
  phone: Joi.string().required(),
  name: Joi.string().max(255).allow('', null),
  email: Joi.string().email().allow('', null),
  birthday: Joi.date().iso().allow(null),
  gender: Joi.string().valid('male', 'female', 'other', 'prefer_not').allow(null),
  tags: Joi.array().items(Joi.string()).allow(null),
  notes: Joi.string().max(1000).allow('', null),
  marketingOptin: Joi.boolean().default(true),
});

// Fix (2026-08-23, review): strip inherited .default()s — a partial update
// was resetting marketingOptin to true. Same class of bug as menuController.
const updateBody = upsertBody.fork(['phone'], (s) => s.optional()).min(1)
  .prefs({ noDefaults: true });

const adjustBody = Joi.object({
  points: Joi.number().integer().required(),
  note: Joi.string().max(500).allow('', null),
});

module.exports = {
  list: [
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const result = await customers.list(req.params.businessId, req.query);
      res.json(result);
    }),
  ],
  get: asyncHandler(async (req, res) => {
    const customer = await customers.byId(req.params.businessId, req.params.customerId);
    const orders = await customers.recentOrders(req.params.businessId, req.params.customerId);
    const txns = await loyalty.listTransactions(req.params.businessId, req.params.customerId);
    res.json({ customer, recentOrders: orders, loyaltyTransactions: txns });
  }),
  lookup: asyncHandler(async (req, res) => {
    const customer = await customers.byPhone(req.params.businessId, req.query.phone);
    if (!customer) return res.json({ customer: null });
    // Include current loyalty settings so the mobile knows what the redemption value is
    const settings = await loyalty.getSettings(req.params.businessId);
    // Membership context (2026-08-23): active bundle (with what's left)
    // + most-recent expired sub so the POS can offer a renewal.
    let membership = null;
    let expiredMembership = null;
    try {
      const membershipSvc = require('../services/membershipService');
      membership = await membershipSvc.activeForCustomer(req.params.businessId, customer.id);
      if (!membership) {
        expiredMembership = await membershipSvc.lastExpiredForCustomer(req.params.businessId, customer.id);
      }
    } catch (_) { /* membership tables may predate migration 020/055 */ }
    res.json({ customer, loyaltySettings: settings, membership, expiredMembership });
  }),
  upsert: [
    validate({ body: upsertBody }),
    asyncHandler(async (req, res) => {
      const customer = await customers.upsert(req.params.businessId, req.body);
      res.status(201).json({ customer });
    }),
  ],
  update: [
    validate({ body: updateBody }),
    asyncHandler(async (req, res) => {
      const customer = await customers.update(req.params.businessId, req.params.customerId, req.body);
      res.json({ customer });
    }),
  ],
  remove: asyncHandler(async (req, res) => {
    await customers.softDelete(req.params.businessId, req.params.customerId);
    res.json({ success: true });
  }),

  // ── Loyalty ────────────────────────────────────────────────────────────
  getLoyaltySettings: asyncHandler(async (req, res) => {
    res.json({ settings: await loyalty.getSettings(req.params.businessId) });
  }),
  updateLoyaltySettings: asyncHandler(async (req, res) => {
    res.json({ settings: await loyalty.updateSettings(req.params.businessId, req.body) });
  }),
  adjustPoints: [
    validate({ body: adjustBody }),
    asyncHandler(async (req, res) => {
      const balance = await loyalty.manualAdjust({
        businessId: req.params.businessId,
        customerId: req.params.customerId,
        points: req.body.points,
        note: req.body.note,
        adminUserId: req.user.id,
      });
      res.json({ pointsBalance: balance });
    }),
  ],
};
