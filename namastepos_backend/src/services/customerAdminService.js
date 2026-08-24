// NamastePOS backend - super-admin customer service
//
// All the read-side drill-downs plus admin-only writes:
//   - create customer manually (for sales-led onboarding)
//   - edit any business field
//   - extend trial / set plan / suspend / restore
//   - drill into menu, orders, staff, invoices, payments, notes

const { query, withTransaction } = require('../config/db');
const env = require('../config/env');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');

// ── Manual customer creation ────────────────────────────────────────────

async function createCustomer({
  email, name, phone = null, city = null, category = null,
  ownerName = null, planTier = 'free', trialDays = env.TRIAL_DAYS,
}) {
  if (!email || !name) throw new BadRequest('email and name are required');

  return withTransaction(async (client) => {
    // Block if a business with this email already exists
    const dup = await client.query(`SELECT id FROM businesses WHERE email = $1`, [email]);
    if (dup.rowCount > 0) throw new Conflict('Customer with this email already exists');

    // 1) Create the user (no google_sub yet — owner will link on first Google login)
    const userIns = await client.query(
      `INSERT INTO users (email, display_name, phone)
       VALUES ($1, $2, $3) RETURNING *`,
      [email, ownerName || name, phone]
    );
    const user = userIns.rows[0];

    // 2) Create the business
    const bizIns = await client.query(
      `INSERT INTO businesses (google_sub, email, display_name, name, phone, city, category, onboarded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING *`,
      [`pending-${user.id}`, email, ownerName, name, phone, city, category]
    );
    const business = bizIns.rows[0];

    // 3) Owner membership
    await client.query(
      `INSERT INTO business_users (business_id, user_id, role)
       VALUES ($1, $2, 'business_owner')`,
      [business.id, user.id]
    );

    // 4) Subscription
    const plan = await client.query(`SELECT id FROM plans WHERE tier = $1`, [planTier]);
    if (plan.rowCount === 0) throw new NotFound(`Plan ${planTier} not found`);
    const status = planTier === 'free' ? 'trialing' : 'active';
    await client.query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, trial_ends_at, current_period_end)
       VALUES ($1, $2, $3::subscription_status,
               NOW() + make_interval(days => $4),
               NOW() + make_interval(days => $4))`,
      [business.id, plan.rows[0].id, status, trialDays]
    );

    return business;
  });
}

// ── Edit business fields ────────────────────────────────────────────────

async function updateCustomer(businessId, patch) {
  const fields = [
    'name', 'phone', 'city', 'category', 'gstin', 'address',
    'upi_id', 'bank_account', 'bank_ifsc', 'logo_url', 'onboarded',
    'display_name', 'photo_url',
  ];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  if (sets.length === 0) {
    const r = await query(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
    return r.rows[0];
  }
  values.push(businessId);
  const r = await query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return r.rows[0];
}

// ── Trial / plan manual change ──────────────────────────────────────────

async function extendTrial(businessId, additionalDays) {
  const r = await query(
    `UPDATE subscriptions
        SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + ($1 || ' days')::interval,
            current_period_end = current_period_end + ($1 || ' days')::interval,
            status = 'trialing'::subscription_status
      WHERE business_id = $2
      RETURNING *`,
    [additionalDays, businessId]
  );
  if (r.rowCount === 0) throw new NotFound('No subscription');
  return r.rows[0];
}

async function setPlanManually(businessId, tier, { reason = 'admin-manual', billingPeriod } = {}) {
  const plan = await query(`SELECT * FROM plans WHERE tier = $1`, [tier]);
  if (plan.rowCount === 0) throw new NotFound('Plan not found');
  // FF-402c — persist the cadence choice too so renewal + Razorpay
  // sync bill the right amount. Blank ⇒ keep whatever the sub had.
  const setBillingPeriod = billingPeriod === 'monthly' || billingPeriod === 'yearly';
  // FF-402f — roll forward the billing period. Previously we only
  // touched status + plan_id, so the sub kept whatever `current_period_end`
  // was set at signup (trial_end). A tenant manually upgraded to Pro
  // showed "Renews on <trial-end-date-in-the-past>" forever. Now:
  //   • Free/trial target → keep the existing trial_ends_at.
  //   • Paid target       → set current_period_start = NOW(), and
  //     current_period_end = NOW() + 1 month (or 12 months if yearly).
  // Razorpay webhooks still overwrite these on real charge events —
  // this is the safe manual-admin fallback for the common case where
  // support toggles a plan without a real payment.
  const cadence = billingPeriod === 'yearly' ? 'yearly' : 'monthly';
  const rollForward = tier !== 'free';
  const dateSets = rollForward
    ? `, current_period_start = NOW(),
       current_period_end   = NOW() + INTERVAL '${cadence === 'yearly' ? '1 year' : '1 month'}',
       cancel_at_period_end = FALSE`
    : '';
  const r = await query(
    `UPDATE subscriptions
        SET plan_id = $1,
            status = CASE WHEN $2 = 'free' THEN 'trialing'::subscription_status
                          ELSE 'active'::subscription_status END
            ${setBillingPeriod ? ', billing_period = $4' : ''}
            ${dateSets}
      WHERE business_id = $3
      RETURNING *`,
    setBillingPeriod
      ? [plan.rows[0].id, tier, businessId, billingPeriod]
      : [plan.rows[0].id, tier, businessId]
  );
  if (r.rowCount === 0) throw new NotFound('No subscription');
  // Push 4: Invalidate the in-process tier cache so the next /auth/me or
  // any feature-gated request immediately reflects the new tier. Without
  // this, clients see stale plan features for up to 60s.
  try { require('./featureService').clearCache(businessId); } catch (_) {}
  // Push 14e — on plan change, auto-prune over-limit staff. Without this,
  // a business downgraded by super-admin would stay over-limit forever
  // (the gate only blocks ADDS, not existing rows). We deactivate newest
  // hires first, keeping the earliest joined N where N = limits.staff.
  try {
    await require('./staffService').complyStaffLimit(businessId);
  } catch (e) {
    // Don't fail the plan change just because prune hit a snag — log only.
    // eslint-disable-next-line no-console
    console.warn('[setPlanManually] complyStaffLimit failed:', e?.message);
  }
  return r.rows[0];
}

// ── Drill-down ──────────────────────────────────────────────────────────

async function drilldown(businessId) {
  const biz = await query(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
  if (biz.rowCount === 0) throw new NotFound('Customer not found');

  const [sub, staff, menu, orders, invoices, payments, notes] = await Promise.all([
    query(`SELECT s.*, p.tier, p.name AS plan_name, p.price_inr_paise
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.business_id = $1`, [businessId]),
    query(`SELECT bu.*, u.email, u.display_name
             FROM business_users bu JOIN users u ON u.id = bu.user_id
            WHERE bu.business_id = $1 AND bu.is_active = TRUE`, [businessId]),
    query(`SELECT id, name, category, price, stock, is_active
             FROM menu_items WHERE business_id = $1 ORDER BY category, name`, [businessId]),
    query(`SELECT id, order_no, status, total, source, created_at
             FROM orders WHERE business_id = $1
            ORDER BY created_at DESC LIMIT 50`, [businessId]),
    query(`SELECT * FROM invoices WHERE business_id = $1
            ORDER BY created_at DESC LIMIT 50`, [businessId]),
    query(`SELECT * FROM payments WHERE business_id = $1
            ORDER BY created_at DESC LIMIT 50`, [businessId]),
    query(`SELECT n.*, au.email AS admin_email
             FROM support_notes n JOIN admin_users au ON au.id = n.admin_id
            WHERE n.business_id = $1
            ORDER BY n.pinned DESC, n.created_at DESC`, [businessId]),
  ]);

  return {
    business: biz.rows[0],
    subscription: sub.rows[0] || null,
    staff: staff.rows.map((s) => ({
      userId: s.user_id, email: s.email, displayName: s.display_name,
      role: s.role, joinedAt: s.joined_at,
    })),
    menu: menu.rows,
    orders: orders.rows,
    invoices: invoices.rows,
    payments: payments.rows,
    notes: notes.rows.map((n) => ({
      id: n.id, body: n.body, pinned: n.pinned,
      adminEmail: n.admin_email, createdAt: n.created_at,
    })),
  };
}

// ── Notes ───────────────────────────────────────────────────────────────

async function addNote({ businessId, adminId, body, pinned = false }) {
  const r = await query(
    `INSERT INTO support_notes (business_id, admin_id, body, pinned)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, adminId, body, pinned]
  );
  return r.rows[0];
}

// P0-10: Must scope by business_id — without it, any admin with notes.write
// permission could DELETE any note across tenants by guessing UUIDs.
async function deleteNote(businessId, noteId) {
  const r = await query(
    `DELETE FROM support_notes WHERE id = $1 AND business_id = $2 RETURNING id`,
    [noteId, businessId]
  );
  if (r.rowCount === 0) throw new NotFound('Note not found for this customer');
}

// ── Soft-delete (P0-7: never hard-DELETE in production) ─────────────────
//
// Hard-deleting a business cascades through orders → order_items → KOT →
// loyalty, obliterating financial history that we still need for audits,
// GST returns, and refund handling. We mark the business as deleted and
// pause its subscription instead. The row stays for reporting; all read
// paths should filter on `deleted_at IS NULL`.
async function deleteCustomer(businessId) {
  await query(
    `UPDATE businesses SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
    [businessId]
  );
  await query(
    `UPDATE subscriptions SET status = 'cancelled' WHERE business_id = $1`,
    [businessId]
  );
}

module.exports = {
  createCustomer, updateCustomer,
  extendTrial, setPlanManually,
  drilldown, addNote, deleteNote, deleteCustomer,
};
