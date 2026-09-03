// NamastePOS backend - addon marketplace endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const addons = require('../services/addonService');

// ── Public catalog ──────────────────────────────────────────────────────
const catalog = asyncHandler(async (_req, res) => {
  res.json({ addons: await addons.listCatalog() });
});

// ── Per-business: list active addons ────────────────────────────────────
const myAddons = asyncHandler(async (req, res) => {
  const active = await addons.listActiveForBusiness(req.params.businessId);
  const all    = await addons.listAllForBusiness(req.params.businessId);
  res.json({ active, history: all });
});

// ── Subscribe / cancel / resume ─────────────────────────────────────────
const subscribeBody = Joi.object({
  slug: Joi.string().min(1).max(50).required(),
});

const subscribe = [
  validate({ body: subscribeBody }),
  asyncHandler(async (req, res) => {
    const r = await addons.subscribe(req.params.businessId, req.body.slug);
    res.status(201).json(r);
  }),
];

const cancel = asyncHandler(async (req, res) => {
  const a = await addons.cancel(req.params.businessId, req.params.slug);
  res.json({ activation: a });
});

const resume = asyncHandler(async (req, res) => {
  const a = await addons.resume(req.params.businessId, req.params.slug);
  res.json({ activation: a });
});

const updateSettings = asyncHandler(async (req, res) => {
  const a = await addons.updateSettings(req.params.businessId, req.params.slug, req.body);
  res.json({ activation: a });
});

// ── Admin catalog CRUD ──────────────────────────────────────────────────
const adminList = asyncHandler(async (_req, res) => {
  res.json({ addons: await addons.listCatalog({ onlyActive: false }) });
});

const adminCreateBody = Joi.object({
  slug: Joi.string().min(2).max(50).required(),
  name: Joi.string().min(1).max(100).required(),
  tagline: Joi.string().max(255).allow('', null),
  description: Joi.string().max(2000).allow('', null),
  icon: Joi.string().max(50).allow('', null),
  category: Joi.string().valid('integrations','marketing','operations','reports').required(),
  price_inr_paise: Joi.number().integer().min(0).required(),
  billing_period: Joi.string().valid('monthly','yearly','one_time').default('monthly'),
  required_plan_tier: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).allow(null, ''),
  trial_days: Joi.number().integer().min(0).max(365).default(0),
  features: Joi.object().default({}),
  is_active: Joi.boolean().default(true),
  display_order: Joi.number().integer().default(100),
  partner_name: Joi.string().max(120).allow('', null),
  revenue_share_pct: Joi.number().min(0).max(100).default(0),
  // 2026-09-03 — feature keys this addon unlocks (migration 074). Accept
  // both the AddonsPage camelCase name and the DB snake_case name.
  grants_features: Joi.array().items(Joi.string().min(1).max(60)).max(50),
  grantsFeatures: Joi.array().items(Joi.string().min(1).max(60)).max(50),
});

// Normalise grantsFeatures (camel) → grants_features (snake) for the service.
function _normalizeGrants(body) {
  if (body.grantsFeatures !== undefined && body.grants_features === undefined) {
    body.grants_features = body.grantsFeatures;
  }
  delete body.grantsFeatures;
  return body;
}

const adminCreate = [
  validate({ body: adminCreateBody }),
  asyncHandler(async (req, res) => {
    const a = await addons.createAddon(_normalizeGrants(req.body));
    res.status(201).json({ addon: a });
  }),
];

const adminUpdateBody = Joi.object({
  name: Joi.string().min(1).max(100),
  tagline: Joi.string().max(255).allow('', null),
  description: Joi.string().max(2000).allow('', null),
  icon: Joi.string().max(50).allow('', null),
  category: Joi.string().valid('integrations','marketing','operations','reports'),
  price_inr_paise: Joi.number().integer().min(0),
  billing_period: Joi.string().valid('monthly','yearly','one_time'),
  required_plan_tier: Joi.string().pattern(/^[a-z][a-z0-9_-]{1,39}$/).allow(null, ''),
  trial_days: Joi.number().integer().min(0).max(365),
  features: Joi.object(),
  is_active: Joi.boolean(),
  display_order: Joi.number().integer(),
  partner_name: Joi.string().max(120).allow('', null),
  revenue_share_pct: Joi.number().min(0).max(100),
  grants_features: Joi.array().items(Joi.string().min(1).max(60)).max(50),
  grantsFeatures: Joi.array().items(Joi.string().min(1).max(60)).max(50),
}).min(1);

const adminUpdate = [
  validate({ body: adminUpdateBody }),
  asyncHandler(async (req, res) => {
    const a = await addons.updateAddon(req.params.slug, _normalizeGrants(req.body));
    res.json({ addon: a });
  }),
];

const adminSyncRazorpay = asyncHandler(async (_req, res) => {
  res.json({ synced: await addons.syncRazorpayPlans() });
});

const adminActivationsForCustomer = asyncHandler(async (req, res) => {
  res.json({ addons: await addons.listAllForBusiness(req.params.businessId) });
});

// Push 19b — admin can attach/detach addons from any customer.
// Wraps the owner-side subscribe()/cancel() flow with explicit super-admin
// scope. Used by the Customer detail page's add-ons tab.
const adminAttachToCustomer = asyncHandler(async (req, res) => {
  // Founder bug fix (2026-08-25): an admin attaching an addon is a deliberate
  // FREE grant (comp), so it must force-activate regardless of price. This
  // used to call subscribe(), but a 2026-08-25 change made subscribe() return
  // { requiresPayment: true } for PAID addons whenever Razorpay is configured
  // (i.e. production) and write NO business_addons row — so admin comps never
  // activated (showed attached but stayed cancelled), and re-attach after a
  // detach kept hitting the paid branch. forceActivate() writes/updates the
  // row directly and resets the period, so detach→attach cycles work. The
  // customer-facing marketplace subscribe() (payment-required) is unchanged.
  const r = await addons.forceActivate(req.params.businessId, req.params.slug);
  res.json(r);
});
const adminDetachFromCustomer = asyncHandler(async (req, res) => {
  // Push 20a — hard-cancel, not schedule-cancel. Owner clicked Detach
  // expecting the addon to disappear right now.
  const r = await addons.detach(req.params.businessId, req.params.slug);
  res.json(r);
});

module.exports = {
  catalog,
  myAddons,
  subscribe, cancel, resume, updateSettings,
  adminList, adminCreate, adminUpdate, adminSyncRazorpay,
  adminActivationsForCustomer,
  adminAttachToCustomer, adminDetachFromCustomer,
};
