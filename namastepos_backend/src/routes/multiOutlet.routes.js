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
const { query } = require('../config/db');

const router = express.Router();
router.use(requireAuth);

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
    [userBizId, req.params.groupId]
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
router.get ('/', requireOwner, asyncHandler(async (req, res) =>
  res.json({ groups: await multiOutlet.listGroupsForOwner(req.user.businessId) })));

router.post('/', requireOwner,
  validate({ body: Joi.object({
    name: Joi.string().required(),
    parentBusinessId: Joi.string().uuid().allow(null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ group: await multiOutlet.createGroup(req.body.name, req.body.parentBusinessId || req.user.businessId) })
  )
);

router.post('/:groupId/outlets', requireOwner, requireGroupMembership,
  validate({ body: Joi.object({
    businessId: Joi.string().uuid().required(),
    label: Joi.string().allow('', null),
  })}),
  asyncHandler(async (req, res) => {
    // C1 fix: the outlet being attached must be owned by the caller —
    // attaching someone else's business would expose their revenue via
    // the group rollup.
    await assertOwnsBusiness(req.user.id, req.body.businessId);
    await multiOutlet.addOutlet(req.params.groupId, req.body.businessId, req.body.label);
    res.json({ success: true });
  })
);

// Security review 2026-08-26: consolidated cross-outlet revenue (rollup) and
// stock transfers are owner-level actions — previously any group-member staff
// (incl. cashiers) could read group-wide revenue or move stock. Require owner.
router.get ('/:groupId/rollup', requireOwner, requireGroupMembership,
  validate({ query: Joi.object({
    startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate:   Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).unknown(true) }),
  asyncHandler(async (req, res) =>
    res.json({ rollup: await multiOutlet.groupRollup(req.params.groupId, req.query) }))
);

router.post('/:groupId/transfers', requireOwner, requireGroupMembership,
  asyncHandler(async (req, res) =>
    res.status(201).json({ transfer: await multiOutlet.transferStock(req.params.groupId, req.body, req.user?.id) })
  )
);

router.post('/:groupId/transfers/:id/receive', requireOwner, requireGroupMembership,
  asyncHandler(async (req, res) =>
    // C1 fix: pass the groupId so the transfer must belong to THIS group.
    res.json({ transfer: await multiOutlet.receiveTransfer(req.params.id, req.user?.id, req.params.groupId) })
  )
);

router.get ('/:groupId/franchise-prices', requireGroupMembership,
  asyncHandler(async (req, res) =>
    res.json({ prices: await multiOutlet.listFranchisePrices(req.params.groupId) }))
);

router.put ('/:groupId/franchise-prices/:sku', requireOwner, requireGroupMembership,
  validate({ body: Joi.object({ price: Joi.number().required() })}),
  asyncHandler(async (req, res) => {
    await multiOutlet.setFranchisePrice(req.params.groupId, req.params.sku, req.body.price);
    res.json({ success: true });
  })
);

module.exports = router;
