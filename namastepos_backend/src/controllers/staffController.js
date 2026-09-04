// NamastePOS backend - staff endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const staff = require('../services/staffService');

const inviteBody = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid('staff_manager', 'staff_cashier').default('staff_cashier'),
});

const updateRoleBody = Joi.object({
  role: Joi.string().valid('business_owner', 'staff_manager', 'staff_cashier').required(),
});

const acceptBody = Joi.object({
  token: Joi.string().required(),
});

// Push 14a — direct PIN-based staff creation
const ALL_STAFF_ROLES = [
  'staff_manager', 'staff_captain', 'staff_waiter',
  'staff_cashier', 'staff_kitchen', 'staff_driver',
];
const createPinBody = Joi.object({
  displayName: Joi.string().min(1).max(120).required(),
  role: Joi.string().valid(...ALL_STAFF_ROLES).required(),
  pin: Joi.string().length(4).pattern(/^\d{4}$/).required(),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  permissions: Joi.array().items(Joi.string().max(40)),
});
const updatePinBody = Joi.object({
  displayName: Joi.string().min(1).max(120),
  role: Joi.string().valid(...ALL_STAFF_ROLES),
  pin: Joi.string().length(4).pattern(/^\d{4}$/),
  isActive: Joi.boolean(),
  phone: Joi.string().max(20).allow('', null),
  permissions: Joi.array().items(Joi.string().max(40)),
}).min(1);

module.exports = {
  list: asyncHandler(async (req, res) => {
    const members = await staff.listStaff(req.params.businessId);
    res.json({ members });
  }),

  invites: asyncHandler(async (req, res) => {
    const invitations = await staff.listInvitations(req.params.businessId);
    res.json({ invitations });
  }),

  invite: [
    validate({ body: inviteBody }),
    asyncHandler(async (req, res) => {
      const { invite, token } = await staff.invite({
        businessId: req.params.businessId,
        invitedBy: req.user.id,
        email: req.body.email,
        role: req.body.role,
      });
      // In production: email the link below to invite.email
      // For now we surface it so the inviter can share it manually.
      const acceptLink = `${req.headers.origin || ''}/accept-invite?token=${token}`;
      res.status(201).json({ invitation: invite, acceptLink });
    }),
  ],

  revokeInvite: asyncHandler(async (req, res) => {
    const invitation = await staff.revokeInvite({
      businessId: req.params.businessId,
      inviteId: req.params.inviteId,
    });
    res.json({ invitation });
  }),

  acceptInvite: [
    validate({ body: acceptBody }),
    asyncHandler(async (req, res) => {
      const result = await staff.acceptInvite({
        token: req.body.token,
        user: { id: req.user.id, email: req.user.email },
      });
      res.json(result);
    }),
  ],

  updateRole: [
    validate({ body: updateRoleBody }),
    asyncHandler(async (req, res) => {
      const r = await staff.updateRole({
        businessId: req.params.businessId,
        userId: req.params.userId,
        role: req.body.role,
      });
      res.json({ membership: r });
    }),
  ],

  remove: asyncHandler(async (req, res) => {
    const r = await staff.removeStaff({
      businessId: req.params.businessId,
      userId: req.params.userId,
      actingUserId: req.user.id,
    });
    res.json({ membership: r });
  }),

  // ── Push 14a: PIN-based CRUD (no email invite required) ─────────────
  listPin: asyncHandler(async (req, res) => {
    res.json({ staff: await staff.listStaffWithPin(req.params.businessId) });
  }),
  createPin: [
    validate({ body: createPinBody }),
    asyncHandler(async (req, res) => {
      const member = await staff.createStaffWithPin(req.params.businessId, req.body);
      res.status(201).json({ staff: member });
    }),
  ],
  updatePin: [
    validate({ body: updatePinBody }),
    asyncHandler(async (req, res) => {
      const member = await staff.updateStaffWithPin(req.params.businessId, req.params.userId, req.body);
      res.json({ staff: member });
    }),
  ],
  // Push 14e — auto-comply with plan limit: deactivate excess non-owner
  // staff, keeping the earliest joined N. Triggered by the "Comply now"
  // button on the over-limit banner.
  comply: asyncHandler(async (req, res) => {
    const result = await staff.complyStaffLimit(req.params.businessId);
    res.json(result);
  }),
};
