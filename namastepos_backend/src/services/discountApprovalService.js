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

// 2026-09-05 (review #8, P2): brute-force lockout for the manager discount
// PIN. A 4-digit PIN with no lockout and only the global 600/min/IP limiter
// was ~17 minutes from being guessed, and a guessed PIN mints approvals that
// orderService.create honours under ORDER_TAX_ENFORCE=enforce. This reuses
// the PERSISTENT counters the staff login PIN already keeps on the manager's
// own business_users row (pin_fail_count / pin_first_fail_at /
// pin_locked_until, migration 057 — S4 fix): shared across workers, survives
// restarts, atomic. Both PINs authenticate the same person on the same row,
// so one lockout state per (business, manager) is the intended behaviour —
// five wrong discount PINs also lock that manager's login PIN for 15 min,
// which is the right response to a till being attacked.
const MAX_PIN_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // sliding window for the counter
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // lock after the cap

async function verifyManagerPin(businessId, managerUserId, pin) {
  // Manager PINs live on business_users.discount_pin_hash (lazy column add).
  const r = await query(
    `SELECT discount_pin_hash, pin_locked_until FROM business_users
      WHERE business_id = $1 AND user_id = $2
        AND role IN ('business_owner','staff_manager')
        AND is_active = TRUE LIMIT 1`,
    [businessId, managerUserId],
  );
  if (r.rowCount === 0) throw new Forbidden('Not a manager for this business');
  const row = r.rows[0];
  // Read-only lock check first — a locked row rejects before bcrypt runs.
  const lockedUntil = row.pin_locked_until ? new Date(row.pin_locked_until).getTime() : 0;
  if (lockedUntil > Date.now()) {
    const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
    throw new Unauthorized(`Too many wrong PINs. Try again in ${mins} min.`);
  }
  const hash = row.discount_pin_hash;
  if (!hash) throw new BadRequest('Manager has not set a PIN');
  const ok = await bcrypt.compare(pin, hash);
  if (ok) {
    await query(
      `UPDATE business_users
          SET pin_fail_count = 0, pin_first_fail_at = NULL, pin_locked_until = NULL
        WHERE business_id = $1 AND user_id = $2`,
      [businessId, managerUserId],
    );
    return true;
  }
  // Failure — one atomic statement (same shape as staffService.verifyPin) so
  // concurrent workers cannot race past the cap.
  const upd = await query(
    `UPDATE business_users
        SET pin_first_fail_at = CASE
              WHEN pin_first_fail_at IS NULL
                OR NOW() - pin_first_fail_at > ($3 || ' milliseconds')::interval
              THEN NOW() ELSE pin_first_fail_at END,
            pin_fail_count = CASE
              WHEN pin_first_fail_at IS NULL
                OR NOW() - pin_first_fail_at > ($3 || ' milliseconds')::interval
              THEN 1 ELSE pin_fail_count + 1 END,
            pin_locked_until = CASE
              WHEN (CASE
                      WHEN pin_first_fail_at IS NULL
                        OR NOW() - pin_first_fail_at > ($3 || ' milliseconds')::interval
                      THEN 1 ELSE pin_fail_count + 1 END) >= $4
              THEN NOW() + ($5 || ' milliseconds')::interval ELSE NULL END
      WHERE business_id = $1 AND user_id = $2
      RETURNING pin_fail_count, pin_locked_until`,
    [businessId, managerUserId, String(PIN_WINDOW_MS), MAX_PIN_ATTEMPTS, String(PIN_LOCKOUT_MS)],
  );
  const st = upd.rows[0] || {};
  if (st.pin_locked_until) {
    throw new Unauthorized('Too many wrong PINs. Locked for 15 min.');
  }
  throw new Unauthorized('Invalid PIN');
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
