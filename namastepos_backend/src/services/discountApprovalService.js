// Manager approval for discounts above threshold (Sprint 3 / FF-502)

const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const { Unauthorized, Forbidden, BadRequest } = require('../utils/errors');

// P0 fix (2026-08-22): threshold used a single global platform_settings
// row keyed only by `order.discount_approval_threshold_inr` — any owner
// setting their threshold overwrote the platform-wide default for every
// other tenant. Now the key is per-business.
function _thresholdKey(businessId) {
  return `order.discount_approval_threshold_inr:${businessId}`;
}

async function getThresholdPaise(businessId) {
  const r = await query(
    'SELECT value FROM platform_settings WHERE key = $1',
    [_thresholdKey(businessId)],
  );
  // Default ₹100
  const inr = r.rowCount > 0 ? Number(r.rows[0].value) : 100;
  return inr * 100;
}

async function setThreshold(businessId, inr) {
  await query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, to_jsonb($2::int), NOW())
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb($2::int), updated_at = NOW()`,
    [_thresholdKey(businessId), inr],
  );
}

async function verifyManagerPin(businessId, managerUserId, pin) {
  // Manager PINs live on business_users.discount_pin_hash (lazy column add).
  const r = await query(
    `SELECT discount_pin_hash FROM business_users
      WHERE business_id = $1 AND user_id = $2
        AND role IN ('business_owner','staff_manager')
        AND is_active = TRUE LIMIT 1`,
    [businessId, managerUserId],
  );
  if (r.rowCount === 0) throw new Forbidden('Not a manager for this business');
  const hash = r.rows[0].discount_pin_hash;
  if (!hash) throw new BadRequest('Manager has not set a PIN');
  const ok = await bcrypt.compare(pin, hash);
  if (!ok) throw new Unauthorized('Invalid PIN');
  return true;
}

async function setMyPin(businessId, userId, pin) {
  if (!pin || pin.length < 4) throw new BadRequest('PIN must be at least 4 digits');
  const hash = await bcrypt.hash(pin, 10);
  await query(
    `UPDATE business_users SET discount_pin_hash = $1
      WHERE business_id = $2 AND user_id = $3`,
    [hash, businessId, userId],
  );
}

async function logApproval(businessId, body) {
  const { orderId, managerUserId, amountPaise, reason } = body;
  const r = await query(
    `INSERT INTO discount_approvals
       (business_id, order_id, manager_user_id, amount_paise, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [businessId, orderId || null, managerUserId, amountPaise, reason || null],
  );
  return r.rows[0];
}

async function listApprovals(businessId, { limit = 100 } = {}) {
  const r = await query(
    `SELECT da.*, u.email AS manager_email
       FROM discount_approvals da
  LEFT JOIN users u ON u.id = da.manager_user_id
      WHERE da.business_id = $1
      ORDER BY da.approved_at DESC LIMIT $2`,
    [businessId, limit],
  );
  return r.rows;
}

module.exports = {
  getThresholdPaise,
  setThreshold,
  verifyManagerPin,
  setMyPin,
  logApproval,
  listApprovals,
};
