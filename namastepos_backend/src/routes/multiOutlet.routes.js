// Multi-outlet / franchise management (Sprint 8)
// Mounted at /v1/outlet-groups — requires authenticated business owner.
// Group-scoped routes additionally verify that the caller's businessId is a
// member of the target group (or the caller is a super-admin via the admin
// app's separate token, not handled here).

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { Forbidden } = require('../utils/errors');
const multiOutlet = require('../services/multiOutletService');
const features = require('../services/featureService');
const { query } = require('../config/db');

const router = express.Router();
router.use(requireAuth);

// ── TENANT-DATA PRIVACY (2026-09-03) ────────────────────────────────────
// This router is mounted at /v1/outlet-groups, OUTSIDE /v1/businesses/:id,
// so it never passes through requireBusinessOwnership — where the
// deny-platform-staff-by-default rule lives. Worse, the role gates below
// short-circuit `next()` for `isSuperAdmin`, so a plain admin token reached
// the WRITE handlers and could create an orphan outlet group in a tenant's
// account, entirely outside the audited /admin surface.
//
// Platform staff get READ-ONLY here (support genuinely needs to see a
// customer's outlet structure); every mutation must go through /admin or an
// impersonation session, which is tenant-scoped and audited.
router.use((req, _res, next) => {
  if (!req.user?.isSuperAdmin) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return next(new Forbidden(
    'Platform staff cannot modify a tenant\'s outlets. Use the admin console '
    + 'or an impersonation session.',
  ));
});

// 2026-09-03 (plans/addons audit #3a): this router is mounted at
// /v1/outlet-groups — OUTSIDE /v1/businesses/:businessId — so the global
// featureGate middleware never saw it and any Starter tenant could create
// outlet groups. Gate the whole surface on the 'multi_outlet' feature,
// mirroring featureGate's 402 FEATURE_LOCKED shape. Super-admin tokens
// (read-only support tooling) skip the plan check.
router.use(async (req, res, next) => {
  if (req.user?.isSuperAdmin) return next();
  // 2026-09-03: /my-outlets is the dashboard's outlet SWITCHER feed. Every
  // tenant needs it (a single-outlet tenant simply gets one row), so it is
  // exempt from the paid gate — only creating additional outlets is gated.
  if (req.path === '/my-outlets') return next();
  // Removing a branch must stay possible AFTER a downgrade — otherwise a
  // tenant who drops off Pro is stuck paying for outlets they can't delete.
  if (/^\/outlets\/[^/]+\/delete(\/request-otp)?$/.test(req.path)) return next();
  const businessId = req.user?.businessId;
  if (!businessId) return next(); // no tenant context — role checks below reject
  try {
    const ok = await features.hasFeature(businessId, 'multi_outlet');
    if (ok) return next();
    const resolved = await features.resolveTierKind(businessId);
    const currentTier = resolved.tier_kind;
    const requiredTier = features.nextTierUp(currentTier);
    return res.status(402).json({
      error: 'FEATURE_LOCKED',
      feature: 'multi_outlet',
      currentTier,
      requiredTier,
      message: requiredTier
        ? `Upgrade to ${requiredTier} to unlock this feature.`
        : 'This feature is not included in your plan.',
      upgradeUrl: '/billing',
    });
  } catch (err) {
    return next(err);
  }
});

// Security fix — before Push 20+, any authenticated user (including staff
// cashiers) could list/create/manipulate any group. This middleware locks
// /:groupId/* routes to callers whose businessId belongs to that group.
const requireGroupMembership = asyncHandler(async (req, _res, next) => {
  const userBizId = req.user?.businessId;
  if (!userBizId) throw new Forbidden('No business context');
  // Schema stores membership as businesses.outlet_group_id.
  const r = await query(
    `SELECT 1 FROM businesses
       WHERE id = $1 AND outlet_group_id = $2 LIMIT 1`,
    [userBizId, req.params.groupId],
  );
  if (r.rowCount === 0) {
    throw new Forbidden('Your business is not a member of this outlet group');
  }
  next();
});

// Only the business owner can create or list groups (not staff).
// SECURITY FIX (2026-08-23, review H5): the real owner role value is
// 'business_owner' (user_role enum) — the old `role !== 'owner'` check
// 403'd every legitimate owner AND let tokens with a missing role pass.
// NP-125 (2026-09-03): the hand-rolled check above trusted req.user.role
// straight from the JWT — a demoted/removed owner kept multi-outlet access
// until their token expired. Use the shared requireRole middleware, which
// re-verifies the caller's role against the live business_users row
// (30s-cached) exactly like every other owner-gated route.
const requireOwner = requireRole(['business_owner']);

/**
 * Owner of the CALLER's own business (req.user.businessId), ignoring any
 * :businessId in the path.
 *
 * `requireOwner` resolves `req.params.businessId || req.user.businessId`, so on
 * routes whose path names a DIFFERENT business (outlet delete names the target
 * branch) it checked membership in that branch instead of the caller's — an HQ
 * owner who isn't a member row of the branch would 403 before the real
 * HQ-ownership check ran. Group/HQ authority is verified separately by
 * multiOutletService.assertCanDeleteOutlet.
 */
const requireOwnerOfOwnBusiness = asyncHandler(async (req, _res, next) => {
  if (req.user?.isSuperAdmin) return next();
  const bid = req.user?.businessId;
  if (!bid) throw new Forbidden('No business context');
  const r = await query(
    `SELECT 1 FROM business_users
      WHERE user_id = $1 AND business_id = $2
        AND role = 'business_owner' AND is_active = TRUE
      LIMIT 1`,
    [req.user.id, bid],
  );
  if (r.rowCount === 0) throw new Forbidden('Only the business owner can do this');
  return next();
});

// SECURITY FIX (2026-08-23, review C1): verify a caller actually OWNS a
// business id they're operating on. Used wherever the request body names
// a business (add-outlet, stock transfers) — previously any authenticated
// user could attach or mutate ANY tenant by guessing/leaking a UUID.
async function assertOwnsBusiness(userId, businessId) {
  const r = await query(
    `SELECT 1 FROM business_users
      WHERE user_id = $1 AND business_id = $2
        AND role = 'business_owner' AND is_active = TRUE
      LIMIT 1`,
    [userId, businessId],
  );
  if (r.rowCount === 0) {
    throw new Forbidden('You do not own that business');
  }
}

// Owner can only see groups they own. Super-admin has a separate route.
router.get('/', requireOwner, asyncHandler(async (req, res) => res.json({ groups: await multiOutlet.listGroupsForOwner(req.user.businessId) })));

// ── 2026-09-03 — outlets the SIGNED-IN USER can switch into ─────────────
// Deliberately NOT behind the multi_outlet plan gate (see the router-level
// gate above): a single-outlet tenant must still be able to list "just me",
// so the dashboard switcher renders for everyone and only the CREATE action
// needs the paid capability.
router.get('/my-outlets', asyncHandler(async (req, res) => {
  res.json({
    outlets: await multiOutlet.listOutletsForUser(req.user.id, req.user.businessId),
  });
}));

/**
 * Provision a NEW outlet (own businesses row → own menu/staff/orders/
 * settings; nothing shared but the group rollup). Owner-only + multi_outlet.
 */
router.post(
  '/outlets/provision',
  requireOwner,
  validate({ body: Joi.object({
    name: Joi.string().min(1).max(120).required(),
    label: Joi.string().max(80).allow('', null),
    city: Joi.string().max(80).allow('', null),
    groupId: Joi.string().uuid().allow(null),
    // Seed the HQ's staff (same roles + permissions) into the new branch.
    copyStaff: Joi.boolean().default(true),
  }) }),
  asyncHandler(async (req, res) => {
    const out = await multiOutlet.provisionOutlet({
      ownerUserId: req.user.id,
      parentBusinessId: req.user.businessId,
      groupId: req.body.groupId || null,
      name: req.body.name,
      label: req.body.label,
      city: req.body.city,
      copyStaff: req.body.copyStaff !== false,
    });
    // The new outlet inherits the HQ's plan + feature overrides.
    try { await multiOutlet.syncPlanToOutlets(req.user.businessId); } catch (_) { /* non-fatal */ }
    res.status(201).json(out);
  }),
);

// ── Delete an outlet (primary/HQ owner only, email-OTP verified) ─────────
// Step 1: mail a 6-digit code to the owner's address.
router.post(
  '/outlets/:businessId/delete/request-otp',
  requireOwnerOfOwnBusiness,
  asyncHandler(async (req, res) => {
    res.json(await multiOutlet.requestOutletDeleteOtp({
      userId: req.user.id,
      callerBusinessId: req.user.businessId,
      targetBusinessId: req.params.businessId,
    }));
  }),
);

// Step 2: confirm with the code. Soft-deletes the outlet (history retained for
// GST/audit); it vanishes from the switcher, rollups and every listing.
router.post(
  '/outlets/:businessId/delete',
  requireOwnerOfOwnBusiness,
  validate({ body: Joi.object({
    requestId: Joi.string().uuid().required(),
    code: Joi.string().min(4).max(10).required(),
  }) }),
  asyncHandler(async (req, res) => {
    res.json(await multiOutlet.deleteOutletWithOtp({
      userId: req.user.id,
      callerBusinessId: req.user.businessId,
      targetBusinessId: req.params.businessId,
      requestId: req.body.requestId,
      code: req.body.code,
    }));
  }),
);

router.post(
  '/',
  requireOwner,
  validate({ body: Joi.object({
    name: Joi.string().required(),
    parentBusinessId: Joi.string().uuid().allow(null),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ group: await multiOutlet.createGroup(req.body.name, req.body.parentBusinessId || req.user.businessId) })),
);

router.post(
  '/:groupId/outlets',
  requireOwner,
  requireGroupMembership,
  validate({ body: Joi.object({
    businessId: Joi.string().uuid().required(),
    label: Joi.string().allow('', null),
  }) }),
  asyncHandler(async (req, res) => {
    // C1 fix: the outlet being attached must be owned by the caller —
    // attaching someone else's business would expose their revenue via
    // the group rollup.
    await assertOwnsBusiness(req.user.id, req.body.businessId);
    await multiOutlet.addOutlet(req.params.groupId, req.body.businessId, req.body.label);
    res.json({ success: true });
  }),
);

// Security review 2026-08-26: consolidated cross-outlet revenue (rollup) and
// stock transfers are owner-level actions — previously any group-member staff
// (incl. cashiers) could read group-wide revenue or move stock. Require owner.
router.get(
  '/:groupId/rollup',
  requireOwner,
  requireGroupMembership,
  validate({ query: Joi.object({
    startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).unknown(true) }),
  asyncHandler(async (req, res) => res.json({ rollup: await multiOutlet.groupRollup(req.params.groupId, req.query) })),
);

router.post(
  '/:groupId/transfers',
  requireOwner,
  requireGroupMembership,
  asyncHandler(async (req, res) => res.status(201).json({ transfer: await multiOutlet.transferStock(req.params.groupId, req.body, req.user?.id) })),
);

router.post(
  '/:groupId/transfers/:id/receive',
  requireOwner,
  requireGroupMembership,
  asyncHandler(async (req, res) =>
    // C1 fix: pass the groupId so the transfer must belong to THIS group.
    res.json({ transfer: await multiOutlet.receiveTransfer(req.params.id, req.user?.id, req.params.groupId) })),
);

router.get(
  '/:groupId/franchise-prices',
  requireGroupMembership,
  asyncHandler(async (req, res) => res.json({ prices: await multiOutlet.listFranchisePrices(req.params.groupId) })),
);

router.put(
  '/:groupId/franchise-prices/:sku',
  requireOwner,
  requireGroupMembership,
  validate({ body: Joi.object({ price: Joi.number().required() }) }),
  asyncHandler(async (req, res) => {
    await multiOutlet.setFranchisePrice(req.params.groupId, req.params.sku, req.body.price);
    res.json({ success: true });
  }),
);

module.exports = router;
