// NamastePOS backend - order routes

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/orderController');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');
const requireStaffPerm = require('../middleware/requireStaffPerm');
const { query } = require('../config/db');
const { HttpError } = require('../utils/errors');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── Staff permissions on the order surface (2026-09-06, CONTRACTS §7) ─────
// Until this batch every ACTIVE member of a business — a cook, a driver —
// could create, list and cancel orders straight from the API; only the mobile
// drawer hid the screens. The keys are the same ones the owner toggles per
// staff (staffService.PERMISSION_KEYS / DEFAULT_PERMS_BY_ROLE):
//   • create        → `pos`           (the bill-creating permission)
//   • list / detail → `orders` OR `pos` — anyone who can ring a bill must be
//                     able to read it back (reprint, see its status); the app
//                     loads GET /orders on launch for every role holding `pos`
//                     (waiters), so `orders`-only would 403 them on boot.
//   • status flip   → `orders` OR `kds` (kitchen marks ready)
//   • assign customer / print → `orders` OR `pos`
// Owner always passes; an `api_key` principal passes GET only (see
// middleware/requireStaffPerm.js).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cancelling an order that was already COLLECTED (paid) is a refund in all but
 * name — the till-skim vector from review #7: a cashier rings a bill, takes
 * the cash, then cancels it. Owner or manager only. Runs AFTER
 * requireStaffPerm so `req.user.role` is the LIVE membership role, never the
 * JWT claim. Everything else (pending→cancelled, →ready, →collected) is left
 * to the permission gate above.
 */
async function ownerOrManagerForCollectedCancel(req, _res, next) {
  try {
    if (req.body?.status !== 'cancelled') return next();
    if (!UUID_RE.test(String(req.params.orderId || ''))) return next(); // controller 404s
    const r = await query(
      'SELECT status FROM orders WHERE business_id = $1 AND id = $2',
      [req.params.businessId, req.params.orderId],
    );
    if (r.rowCount === 0 || r.rows[0].status !== 'collected') return next();
    if (req.user?.isSuperAdmin) return next();
    const role = req.user?.role;
    if (role === 'business_owner' || role === 'staff_manager') return next();
    return next(new HttpError(
      403,
      'Only the owner or a manager can cancel an order that has already been paid',
      'OWNER_OR_MANAGER_REQUIRED',
    ));
  } catch (err) {
    return next(err);
  }
}

// P1 (Arvind #6): per-business rate limit on order creation so a misbehaving
// POS (or a malicious staff member) can't DoS the kitchen. 60 orders/min per
// business is generous — busiest reported customer averages ~25/min at peak.
const createOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `orders:${req.params.businessId}`,
  message: { error: 'TOO_MANY_ORDERS', message: 'Slow down — too many orders in the last minute' },
});

// `monthly_orders` is a SOFT limit (2026-09-04, decision 5): this middleware
// NEVER refuses the bill. It stays mounted because it is what notices the
// breach — it records the upsell signal and merges a `planLimit` notice into
// the 201 body so analytics still sees the pricing cliff. The soft/hard
// classification is data in subscriptionService.METRIC_POLICY; this line does
// not need to know which class the metric is in.
// 2026-09-05 (churn batch): a PAUSED subscription cannot take new bills. This
// is the only route that gate is mounted on — reads stay open on purpose, see
// churnService.js for the recorded pause decision. It sits before the limit
// middleware because "you are paused" is a truer answer than "you are near
// your plan cap".
router.post('/', createOrderLimiter, requireStaffPerm('pos'), sub.blockIfPaused(), sub.enforceLimit('monthly_orders'), ...c.create);
router.get('/', requireStaffPerm(['orders', 'pos']), ...c.list);
router.get('/:orderId', requireStaffPerm(['orders', 'pos']), c.get);
router.put('/:orderId/status', requireStaffPerm(['orders', 'kds']), ownerOrManagerForCollectedCancel, ...c.updateStatus);
router.put('/:orderId/customer', requireStaffPerm(['orders', 'pos']), ...c.assignCustomer);
router.post('/:orderId/print', requireStaffPerm(['orders', 'pos']), c.print);

module.exports = router;
