// NamastePOS backend - customer routes (mounted at /businesses/:businessId/customers)
// Gated behind the 'loyalty' add-on. Each business pays to access this CRM.

const express = require('express');
const c = require('../controllers/customerController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const requireStaffPerm = require('../middleware/requireStaffPerm');
const requireAddon = require('../middleware/requireAddon');
const noPlatformStaff = require('../middleware/noPlatformStaff');
const idempotent = require('../middleware/idempotent');

const router = express.Router({ mergeParams: true });
// 2026-09-03: plan-granted 'loyalty' (or an admin override) opens the CRM
// too — the addon is one way to get the feature, not the only way.
//
// TENANT PRIVACY (2026-09-03, founder-driven): this router returns the
// restaurant's END-CUSTOMERS — diner names, phones, loyalty points, wallet
// balances. requireBusinessOwnership lets a plain super-admin token read any
// tenant route, so without noPlatformStaff every NamastePOS staff member could
// list any restaurant's diners with no ticket and no audit trail.
// noPlatformStaff blocks the plain admin token and still allows an audited
// impersonation session. See middleware/noPlatformStaff.js.
router.use(
  requireAuth,
  requireBusinessOwnership,
  noPlatformStaff,
  requireAddon('loyalty', { orFeature: 'loyalty' }),
);

// Customer CRUD
// 2026-09-06 (CONTRACTS §7): the read AND write paths are gated on the
// `customers` staff permission instead of a hard-coded role list. Before this,
// POST / and PATCH /:id had NO gate at all — a cook could rewrite a diner's
// name and phone — while the reads named roles, so an owner who ticked
// `customers` for a captain (a default grant, see DEFAULT_PERMS_BY_ROLE) still
// saw that captain 403 on the lookup the POS needs. Owner always passes;
// DELETE stays owner-only and points stay owner/manager below.
router.get('/', requireStaffPerm('customers'), ...c.list);
router.get('/lookup', requireStaffPerm('customers'), c.lookup); // ?phone=…
// NP-401 note: POST / is an UPSERT keyed on the phone number and PATCH
// /:customerId sets absolute field values — replaying either is already a
// no-op (no duplicate row, no drifting balance), so neither needs the
// idempotency gate. The points endpoint below is the one that moves a
// RELATIVE balance.
router.post('/', requireStaffPerm('customers'), ...c.upsert);
router.get('/:customerId', requireStaffPerm('customers'), c.get);
router.patch('/:customerId', requireStaffPerm('customers'), ...c.update);
router.delete('/:customerId', requireRole(['business_owner']), c.remove);
router.post(
  '/:customerId/points',
  requireRole(['business_owner', 'staff_manager']),
  // NP-401 (2026-09-04): `points` is a signed DELTA written straight onto
  // customers.points_balance plus a loyalty_transactions row. A replay grants
  // (or burns) the points twice and leaves two ledger rows whose
  // balance_after values contradict each other.
  idempotent('POST /customers/:customerId/points'),
  ...c.adjustPoints,
);

// Loyalty settings
router.get('/_settings/loyalty', c.getLoyaltySettings);
router.put(
  '/_settings/loyalty',
  requireRole(['business_owner']),
  c.updateLoyaltySettings,
);

module.exports = router;
