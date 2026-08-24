// NamastePOS backend - staff routes (mounted at /businesses/:businessId/staff)

const express = require('express');
const c = require('../controllers/staffController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// Anyone in the business can list members; only owners/managers mutate.
router.get('/',             c.list);
router.get('/invites',      requireRole(['business_owner','staff_manager']), c.invites);
router.post('/invites',     requireRole(['business_owner','staff_manager']),
                            sub.enforceLimit('staff'), ...c.invite);
router.delete('/invites/:inviteId',
              requireRole(['business_owner','staff_manager']), c.revokeInvite);
router.put('/:userId/role', requireRole(['business_owner']), ...c.updateRole);
router.delete('/:userId',   requireRole(['business_owner']), c.remove);

// Push 14a — direct PIN-based staff CRUD (no email invite required).
// Used by the mobile staff-management screen + PIN login picker.
// enforceLimit('staff') reads the active plan's limits.staff and 402s
// when the count would exceed it — same gate as the invite path so the
// super-admin plan limits stay authoritative.
router.get(    '/pin',            requireRole(['business_owner','staff_manager']), c.listPin);
router.post(   '/pin',            requireRole(['business_owner']),
                                  sub.enforceLimit('staff'), ...c.createPin);
router.put(    '/pin/:userId',    requireRole(['business_owner']), ...c.updatePin);

// Push 14e — auto-comply with plan limit (deactivates newest hires until
// active staff count fits plan.limits.staff). Owner-only.
router.post(   '/pin/comply-limit', requireRole(['business_owner']), c.comply);

module.exports = router;
