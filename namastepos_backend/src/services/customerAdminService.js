// NamastePOS backend - super-admin customer service
//
// All the read-side drill-downs plus admin-only writes:
//   - create customer manually (for sales-led onboarding)
//   - edit any business field
//   - extend trial / set plan / suspend / restore
//   - drill into menu, orders, staff, invoices, payments, notes

const crypto = require('crypto');
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
    const dup = await client.query('SELECT id FROM businesses WHERE email = $1', [email]);
    if (dup.rowCount > 0) throw new Conflict('Customer with this email already exists');

    // 1) Create the user (no google_sub yet — owner will link on first Google login)
    const userIns = await client.query(
      `INSERT INTO users (email, display_name, phone)
       VALUES ($1, $2, $3) RETURNING *`,
      [email, ownerName || name, phone],
    );
    const user = userIns.rows[0];

    // 2) Create the business
    const bizIns = await client.query(
      `INSERT INTO businesses (google_sub, email, display_name, name, phone, city, category, onboarded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING *`,
      [`pending-${user.id}`, email, ownerName, name, phone, city, category],
    );
    const business = bizIns.rows[0];

    // 3) Owner membership
    await client.query(
      `INSERT INTO business_users (business_id, user_id, role)
       VALUES ($1, $2, 'business_owner')`,
      [business.id, user.id],
    );

    // 4) Subscription
    // A custom plan belongs to ONE tenant (plans.business_id, migration 074),
    // so a brand-new customer may only be put on a shared/public plan — never
    // on another tenant's bespoke one.
    const plan = await client.query(
      'SELECT id FROM plans WHERE tier = $1 AND business_id IS NULL',
      [planTier],
    );
    if (plan.rowCount === 0) throw new NotFound(`Plan ${planTier} not found`);
    // A9/A10 (2026-09-05): was `planTier === 'free' ? 'trialing' : 'active'`.
    // A ₹0 plan has nothing to trial — it is simply 'active' (matches
    // changePlan and the trial-expiry downgrade); a manually assigned paid
    // plan is 'active' too (the admin is deliberately granting it). No tier
    // code is consulted.
    const status = 'active';
    await client.query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, trial_ends_at, current_period_end)
       VALUES ($1, $2, $3::subscription_status,
               NOW() + make_interval(days => $4),
               NOW() + make_interval(days => $4))`,
      [business.id, plan.rows[0].id, status, trialDays],
    );

    return business;
  });
}

// ── Edit business fields ────────────────────────────────────────────────

async function updateCustomer(businessId, patch) {
  // TENANT PRIVACY (2026-09-03): `bank_account` and `bank_ifsc` were writable
  // here. That let any admin with customers.write REWRITE a restaurant's
  // payout account — a payout-redirection primitive sitting in the support
  // console — and the `RETURNING *` handed the current values straight back.
  // The tenant owns their own bank details in their dashboard settings; the
  // platform has no reason to set them. Do not re-add these keys.
  const fields = [
    'name', 'phone', 'city', 'category', 'gstin', 'address',
    'upi_id', 'logo_url', 'onboarded',
    'display_name', 'photo_url',
  ];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  // Redacted on the way out too (see adminService.redactBusinessRow) —
  // otherwise a no-op PATCH is a read of the fields we just removed.
  if (sets.length === 0) {
    const r = await query('SELECT * FROM businesses WHERE id = $1', [businessId]);
    return require('./adminService').redactBusinessRow(r.rows[0]);
  }
  values.push(businessId);
  const r = await query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return require('./adminService').redactBusinessRow(r.rows[0]);
}

// ── Trial / plan manual change ──────────────────────────────────────────

async function extendTrial(businessId, additionalDays) {
  // F4 (2026-09-05): only a TRIALING subscription can have its trial extended.
  // This used to set status='trialing' unconditionally, so "extend trial" on
  // an active paying tenant moved them to trialing (wrong MRR, wrong
  // changePlan CASE branch, and a paid plan now time-boxed by trial_ends_at).
  const r = await query(
    `UPDATE subscriptions
        SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + ($1 || ' days')::interval,
            current_period_end = current_period_end + ($1 || ' days')::interval,
            updated_at = NOW()
      WHERE business_id = $2 AND status = 'trialing'
      RETURNING *`,
    [additionalDays, businessId],
  );
  if (r.rowCount === 0) {
    const cur = await query('SELECT status FROM subscriptions WHERE business_id = $1', [businessId]);
    if (cur.rowCount === 0) throw new NotFound('No subscription');
    const err = new Conflict(
      `Only a trialing subscription can be extended (this one is ${cur.rows[0].status}).`,
    );
    err.code = 'NOT_TRIALING';
    throw err;
  }
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return r.rows[0];
}

async function setPlanManually(businessId, tier, { billingPeriod } = {}) {
  // Scope custom plans to their owner: a `custom-xxxxxxxx` tier belongs to one
  // tenant (plans.business_id, migration 074) and must never be attachable to
  // a different business — that would hand them another customer's bespoke
  // pricing and feature set.
  const plan = await query(
    `SELECT * FROM plans
      WHERE tier = $1 AND (business_id IS NULL OR business_id = $2)`,
    [tier, businessId],
  );
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
  // A9/A10 (2026-09-05): "is this the free plan" is a PRICE question, not the
  // tier code 'free'; and a ₹0 target is 'active' (nothing to trial), not
  // 'trialing' — the old CASE left a free-plan tenant as a perpetual trial.
  const isFree = require('./subscriptionService').isFreePlan(plan.rows[0]);
  const rollForward = !isFree;
  const dateSets = rollForward
    ? `, current_period_start = NOW(),
       current_period_end   = NOW() + INTERVAL '${cadence === 'yearly' ? '1 year' : '1 month'}',
       cancel_at_period_end = FALSE`
    : '';
  const r = await query(
    `UPDATE subscriptions
        SET plan_id = $1,
            -- A6: assigning a plan is not "restore"; a suspended row stays
            -- suspended (with pre_suspend_status intact) until restore().
            status = CASE WHEN status = 'suspended' THEN status
                          ELSE 'active'::subscription_status END,
            pending_plan_id = NULL,
            updated_at = NOW()
            ${setBillingPeriod ? ', billing_period = $3' : ''}
            ${dateSets}
      WHERE business_id = $2
      RETURNING *`,
    setBillingPeriod
      ? [plan.rows[0].id, businessId, billingPeriod]
      : [plan.rows[0].id, businessId],
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
  // 2026-09-03 — HQ plan changes propagate to the group's outlets.
  try {
    await require('./multiOutletService').syncPlanToOutlets(businessId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[setPlanManually] syncPlanToOutlets failed:', e?.message);
  }
  // 2026-09-03 — same rule as the tenant path: revoke addons the new plan
  // is not entitled to (multi-outlet is Pro+, etc).
  try {
    await require('./addonService').revokeIneligibleAddons(businessId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[setPlanManually] revokeIneligibleAddons failed:', e?.message);
  }
  return r.rows[0];
}

// ── Drill-down ──────────────────────────────────────────────────────────
//
// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ TENANT-DATA PRIVACY — READ BEFORE ADDING FIELDS HERE (2026-09-03)     ║
// ╠═══════════════════════════════════════════════════════════════════════╣
// ║ This endpoint used to return the tenant's last 50 ORDERS as individual ║
// ║ rows. That is the restaurant's own sales ledger and NamastePOS staff   ║
// ║ have no business browsing it — founder decision, and the right one     ║
// ║ under DPDP (we are a data processor for the tenant's diner data, not a ║
// ║ controller). It now returns `orderStats` AGGREGATES only.              ║
// ║                                                                       ║
// ║ ALLOWED here: what the tenant owes US (subscription invoices, plan,    ║
// ║   dunning, payment status of OUR charges), non-identifying volume /    ║
// ║   health metrics, their staff roster (our contractual counterparties), ║
// ║   support notes, audit trail.                                         ║
// ║ FORBIDDEN here: individual orders / bills / KOTs, order line items,    ║
// ║   diner (end-customer) names / phones / emails, loyalty or wallet      ║
// ║   balances, tenant expenses / income statement / their GST filings,    ║
// ║   tenant payout bank details or e-invoice credentials.                 ║
// ║                                                                       ║
// ║ Need ONE order for a "my order vanished" ticket? Use the narrow,       ║
// ║ super-admin-only, audit-logged singleOrderForSupport() below. Do NOT   ║
// ║ reopen the ledger here.                                               ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const adminLegacy = require('./adminService');

async function drilldown(businessId) {
  // PRIVACY: `SELECT *` on businesses shipped bank_account / bank_ifsc /
  // einvoice_* credentials. redactBusinessRow() strips them (last-4 hint only).
  const biz = await query(
    `SELECT b.*, ${adminLegacy.OUTLET_SELECT}
       FROM businesses b ${adminLegacy.OUTLET_JOIN}
      WHERE b.id = $1`,
    [businessId],
  );
  if (biz.rowCount === 0) throw new NotFound('Customer not found');

  const [sub, staff, menu, orderAgg, revByMonth, invoices, payments, notes, siblings] = await Promise.all([
    query(`SELECT s.*, p.tier, p.name AS plan_name, p.price_inr_paise
               FROM subscriptions s JOIN plans p ON p.id = s.plan_id
              WHERE s.business_id = $1`, [businessId]),
    query(`SELECT bu.*, u.email, u.display_name
               FROM business_users bu JOIN users u ON u.id = bu.user_id
              WHERE bu.business_id = $1 AND bu.is_active = TRUE`, [businessId]),
    query(`SELECT id, name, category, price, stock, is_active
               FROM menu_items WHERE business_id = $1 ORDER BY category, name`, [businessId]),
    // AGGREGATES ONLY — no ids, no order numbers, no diner columns. Enough
    // to answer "are they actually using it / how big are they / when did
    // they last transact", which is all support and billing need.
    query(`SELECT (COUNT(*) FILTER (WHERE status <> 'cancelled'))::int AS order_count,
                    (COUNT(*) FILTER (WHERE status = 'cancelled'))::int  AS cancelled_count,
                    (COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0))::float
                                                                        AS gross_volume,
                    MAX(created_at) FILTER (WHERE status <> 'cancelled') AS last_order_at,
                    MIN(created_at) FILTER (WHERE status <> 'cancelled') AS first_order_at
               FROM orders WHERE business_id = $1`, [businessId]),
    query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                    COUNT(*)::int                    AS orders,
                    COALESCE(SUM(total), 0)::float   AS revenue
               FROM orders
              WHERE business_id = $1
                AND status <> 'cancelled'
                AND created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
              GROUP BY 1 ORDER BY 1 ASC`, [businessId]),
    // OUR subscription invoices to the tenant — deliberately kept in full.
    query(`SELECT * FROM invoices WHERE business_id = $1
              ORDER BY created_at DESC LIMIT 50`, [businessId]),
    // OUR subscription charges. Explicit column list: `SELECT *` also
    // returned `raw_payload`, the whole Razorpay object (payer contact,
    // card metadata). The UI never used it.
    query(`SELECT id, invoice_id, amount_paise, currency, method,
                    razorpay_payment_id, status, failure_reason, created_at
               FROM payments WHERE business_id = $1
              ORDER BY created_at DESC LIMIT 50`, [businessId]),
    query(`SELECT n.*, au.email AS admin_email
               FROM support_notes n JOIN admin_users au ON au.id = n.admin_id
              WHERE n.business_id = $1
              ORDER BY n.pinned DESC, n.created_at DESC`, [businessId]),
    adminLegacy.outletSiblings(businessId),
  ]);

  const agg = orderAgg.rows[0] || {};
  const orderCount = agg.order_count || 0;
  const grossVolume = agg.gross_volume || 0;

  return {
    business: {
      ...adminLegacy.redactBusinessRow(biz.rows[0]),
      // 2026-09-03 — outlet visibility (HQ / outlet / standalone).
      outlet: adminLegacy.outletBlock(biz.rows[0], businessId),
      outletSiblings: siblings,
    },
    subscription: sub.rows[0] || null,
    staff: staff.rows.map((s) => ({
      userId: s.user_id,
      email: s.email,
      displayName: s.display_name,
      role: s.role,
      joinedAt: s.joined_at,
    })),
    menu: menu.rows,
    // REPLACES the removed `orders` array. Back-compat note: `orders` is gone
    // on purpose — an old client that reads it gets undefined, which is the
    // intended outcome. Do not re-add it.
    orderStats: {
      orderCount,
      cancelledCount: agg.cancelled_count || 0,
      grossVolumeInr: grossVolume,
      avgTicketInr: orderCount > 0 ? Math.round((grossVolume / orderCount) * 100) / 100 : 0,
      firstOrderAt: agg.first_order_at || null,
      lastOrderAt: agg.last_order_at || null,
      revenueByMonth: revByMonth.rows.map((m) => ({
        month: m.month, orders: m.orders, revenueInr: m.revenue,
      })),
    },
    invoices: invoices.rows,
    payments: payments.rows,
    notes: notes.rows.map((n) => ({
      id: n.id,
      body: n.body,
      pinned: n.pinned,
      adminEmail: n.admin_email,
      createdAt: n.created_at,
    })),
  };
}

// ── Single-order support lookup (narrow escape hatch) ───────────────────
//
// POLICY: this is the ONLY admin path to a tenant order, and it exists for one
// scenario — a ticket like "order #412 vanished from my bill". Constraints
// that must survive any refactor:
//   • one order, addressed by BOTH businessId and orderId (tenant-scoped);
//   • no listing, no searching, no date range — you must already know the id;
//   • gated on `settings.write`, i.e. super_admin only (see adminRbac.js);
//   • every call writes an audit_log row BEFORE the response is sent;
//   • diner PII is masked here, server-side: name → initials, phone → last 4.
// The founder may decide to delete this endpoint entirely; nothing else in the
// product depends on it.

/** "Rahul Sharma" → "R.S." · "" / null → null. Never returns a full name. */
function maskName(name) {
  if (!name) return null;
  const initials = String(name).trim().split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase());
  return initials.length ? `${initials.join('.')}.` : null;
}

/** "+919812345678" → "••••5678". Never returns dialable digits. */
function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
}

async function singleOrderForSupport(businessId, orderId) {
  // Tenant-scoped by BOTH ids — a super-admin with an order UUID from another
  // tenant still gets a 404, which keeps the audit trail honest.
  const r = await query(
    // Explicit column list. NOTE what is deliberately absent: `customer_id`
    // (the FK into the tenant's own diner CRM — following it would hand over
    // the diner's full profile) and every aggregator payload column.
    `SELECT id, order_no, status, source, subtotal, tax, discount, total,
            payment_method, cancel_reason, customer_name, customer_phone,
            created_at, updated_at
       FROM orders WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [orderId, businessId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found for this customer');
  const o = r.rows[0];

  const items = await query(
    `SELECT name, qty, price, note FROM order_items WHERE order_id = $1
      ORDER BY name ASC`,
    [orderId],
  );

  return {
    id: o.id,
    orderNo: o.order_no,
    status: o.status,
    source: o.source,
    subtotal: o.subtotal == null ? null : parseFloat(o.subtotal),
    tax: o.tax == null ? null : parseFloat(o.tax),
    discount: o.discount == null ? null : parseFloat(o.discount),
    total: o.total == null ? null : parseFloat(o.total),
    paymentMethod: o.payment_method || null,
    cancelReason: o.cancel_reason || null,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    // MASKED — see policy above. `customerName` / `customerPhone` must never
    // appear in this response, only these derived, non-identifying forms.
    diner: {
      initials: maskName(o.customer_name),
      phoneLast4: maskPhone(o.customer_phone),
    },
    items: items.rows.map((i) => ({
      name: i.name,
      qty: i.qty,
      price: i.price == null ? null : parseFloat(i.price),
      note: i.note || null,
    })),
    privacyNotice: 'Diner name and phone are masked by policy. '
      + 'This lookup is super-admin only and is recorded in the audit log.',
  };
}

// ── Notes ───────────────────────────────────────────────────────────────

async function addNote({ businessId, adminId, body, pinned = false }) {
  const r = await query(
    `INSERT INTO support_notes (business_id, admin_id, body, pinned)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, adminId, body, pinned],
  );
  return r.rows[0];
}

// P0-10: Must scope by business_id — without it, any admin with notes.write
// permission could DELETE any note across tenants by guessing UUIDs.
async function deleteNote(businessId, noteId) {
  const r = await query(
    'DELETE FROM support_notes WHERE id = $1 AND business_id = $2 RETURNING id',
    [noteId, businessId],
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
    'UPDATE businesses SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
    [businessId],
  );
  await query(
    'UPDATE subscriptions SET status = \'cancelled\' WHERE business_id = $1',
    [businessId],
  );
}

// ── Lifecycle actions (2026-09-03, SaaS control-plane gaps) ─────────────
//
// Everything below is an admin action a real support/CS team needs and that
// previously had no endpoint at all. They are deliberately thin wrappers
// around existing, already-hardened services (subscriptionService,
// complianceService, onboardingEmailService) rather than reimplementations.

/**
 * Cancel a subscription.
 *   atPeriodEnd (default) → keeps service until the paid period ends and
 *     cancels the Razorpay mandate at cycle end. This is the ONLY correct
 *     default: cutting service the customer already paid for is a chargeback.
 *   immediate → also flips the local status to 'cancelled' now. Reserved for
 *     fraud / never-paid / explicit customer demand.
 */
async function cancelSubscription(businessId, { immediate = false, reason = null } = {}) {
  const sub = require('./subscriptionService');
  const row = await sub.cancelAtPeriodEnd(businessId); // also cancels at the gateway
  if (!immediate) return row;

  const r = await query(
    `UPDATE subscriptions
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE business_id = $1
      RETURNING *`,
    [businessId],
  );
  _activity(businessId, 'billing', 'Subscription cancelled immediately', reason);
  return r.rows[0];
}

/**
 * Change the owner's email everywhere it identifies them: the business
 * record (login identity + billing contact) and the owner's user row.
 *
 * Both columns are UNIQUE, so a collision surfaces as a 409 rather than a
 * raw Postgres error. Refresh tokens are revoked because the login identity
 * just changed — the old sessions were issued against the old address.
 */
async function changeOwnerEmail(businessId, newEmail) {
  const email = String(newEmail || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new BadRequest('A valid email is required');
  }
  return withTransaction(async (client) => {
    const b = await client.query('SELECT id, email FROM businesses WHERE id = $1 FOR UPDATE', [businessId]);
    if (b.rowCount === 0) throw new NotFound('Customer not found');
    const previous = b.rows[0].email;

    const clash = await client.query(
      `SELECT 1 FROM businesses WHERE email = $1 AND id <> $2
        UNION ALL
       SELECT 1 FROM users WHERE email = $1
         AND id <> COALESCE((SELECT user_id FROM business_users
                              WHERE business_id = $2 AND role = 'business_owner'
                                AND is_active = TRUE LIMIT 1),
                            '00000000-0000-0000-0000-000000000000'::uuid)
       LIMIT 1`,
      [email, businessId],
    );
    if (clash.rowCount > 0) throw new Conflict('That email is already in use');

    await client.query(
      'UPDATE businesses SET email = $2, updated_at = NOW() WHERE id = $1',
      [businessId, email],
    );
    await client.query(
      `UPDATE users SET email = $2, updated_at = NOW()
        WHERE id = (SELECT user_id FROM business_users
                     WHERE business_id = $1 AND role = 'business_owner'
                       AND is_active = TRUE LIMIT 1)`,
      [businessId, email],
    );
    // The identity behind every live session just changed.
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE business_id = $1 AND revoked_at IS NULL`,
      [businessId],
    );
    _activity(businessId, 'account', 'Owner email changed', `${previous} → ${email}`);
    const out = await client.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
    return out.rows[0];
  });
}

/**
 * Reset the owner's device credentials.
 *
 * NOTE for whoever reads this next: NamastePOS has no password-reset-link
 * flow to trigger — owners authenticate with Google Sign-In and then unlock
 * the app with an MPIN (business_users.pin_hash). So "reset password" here
 * means: clear the owner's MPIN + any brute-force lockout, and revoke live
 * sessions. The owner signs in with Google again and sets a fresh MPIN.
 * Staff PINs are untouched — this is scoped to the owner row only.
 */
async function resetOwnerCredentials(businessId) {
  const r = await query(
    `UPDATE business_users
        SET pin_hash = NULL,
            pin_fail_count = 0,
            pin_locked_until = NULL,
            pin_first_fail_at = NULL
      WHERE business_id = $1 AND role = 'business_owner'
      RETURNING user_id`,
    [businessId],
  );
  if (r.rowCount === 0) throw new NotFound('No owner found for this customer');
  const revoked = await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE business_id = $1 AND revoked_at IS NULL`,
    [businessId],
  );
  _activity(
    businessId,
    'account',
    'Owner MPIN reset by admin',
    'Owner must sign in with Google again and set a new MPIN',
  );
  return { mpinCleared: true, sessionsRevoked: revoked.rowCount };
}

/**
 * Re-send the welcome / onboarding email to the owner.
 *
 * email_dispatch_log has a UNIQUE (user_id, template) index that makes the
 * lifecycle scheduler idempotent — which also means a straight re-send of
 * 'onboarding_d0' is swallowed as "already sent". A manual resend is an
 * explicit human decision, so we send it under a distinct template key and
 * the log shows both the original and the resend.
 */
async function resendWelcomeEmail(businessId) {
  const r = await query(
    `SELECT u.id AS user_id, u.email, u.display_name AS name, b.name AS business_name
       FROM business_users bu
       JOIN users u      ON u.id = bu.user_id
       JOIN businesses b ON b.id = bu.business_id
      WHERE bu.business_id = $1 AND bu.role = 'business_owner' AND bu.is_active = TRUE
      LIMIT 1`,
    [businessId],
  );
  const owner = r.rows[0];
  if (!owner) throw new NotFound('No active owner found for this customer');
  if (!owner.email) throw new BadRequest('Owner has no email address on file');

  const onboarding = require('./onboardingEmailService');
  const email = require('./emailService');
  const tpl = onboarding.__tplD0({ name: owner.name || owner.business_name });
  const logRow = await email.sendMail({
    template: `onboarding_d0_resend_${Date.now()}`,
    recipient: owner.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    businessId,
    // userId deliberately omitted: the (user_id, template) unique index is
    // the scheduler's idempotency guard, not ours.
  });
  _activity(businessId, 'email', 'Welcome email re-sent', owner.email);
  return { recipient: owner.email, status: logRow?.status || 'queued' };
}

/**
 * Account-management fields: which internal AE/CSM owns the tenant, segment
 * tags, and the CRM lifecycle stage. Partial patch — only what's passed is
 * written (see the Joi-fork lesson: undefined must not blank a column).
 */
async function setAccountFields(businessId, { accountOwnerEmail, tags, lifecycleStage } = {}) {
  const sets = []; const values = []; let idx = 1;
  if (accountOwnerEmail !== undefined) {
    sets.push(`account_owner_email = $${idx++}`);
    values.push(accountOwnerEmail ? String(accountOwnerEmail).trim().toLowerCase() : null);
  }
  if (tags !== undefined) {
    const clean = Array.from(new Set(
      (Array.isArray(tags) ? tags : [])
        .map((t) => String(t).trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40),
    )).slice(0, 20);
    sets.push(`tags = $${idx++}::text[]`);
    values.push(clean);
  }
  if (lifecycleStage !== undefined) {
    sets.push(`lifecycle_stage = $${idx++}`);
    values.push(lifecycleStage || null);
  }
  if (sets.length === 0) throw new BadRequest('Nothing to update');

  values.push(businessId);
  const r = await query(
    `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${idx} RETURNING *`,
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
  return r.rows[0];
}

/**
 * DPDP erasure — the "danger zone" action.
 *
 * Anonymises every human identifier attached to the tenant, then soft-deletes
 * the business. It does NOT drop orders, invoices or payments: DPDP lets a
 * fiduciary retain transaction records for tax/audit, and we still owe GST
 * returns on historical revenue. Per-user erasure is delegated to
 * complianceService.eraseUser so the consent-withdrawal + DSR paper trail is
 * identical to a self-service request.
 *
 * Irreversible. The caller must pass an explicit confirmation string.
 */
async function anonymiseCustomer(businessId, { reason, confirm } = {}) {
  if (confirm !== 'ANONYMISE') {
    throw new BadRequest('Set confirm to "ANONYMISE" to run an irreversible DPDP erasure');
  }
  if (!reason || !String(reason).trim()) {
    throw new BadRequest('A reason is required (recorded on the DSR trail)');
  }
  const b = await query('SELECT id, name, email, deleted_at FROM businesses WHERE id = $1', [businessId]);
  if (b.rowCount === 0) throw new NotFound('Customer not found');

  // 1. Erase each attached user (identifiers → hashed tokens + DSR row).
  const users = await query('SELECT DISTINCT user_id FROM business_users WHERE business_id = $1', [businessId]);
  const compliance = require('./complianceService');
  const erased = [];
  const failed = [];
  for (const row of users.rows) {
    try {
      await compliance.eraseUser({
        userId: row.user_id,
        reason: `admin_erasure: ${String(reason).trim()}`,
        actorUserId: null,
      });
      erased.push(row.user_id);
    } catch (e) {
      // A user shared with another tenant, or already erased — record and
      // continue; the business-level scrub below still runs.
      failed.push({ userId: row.user_id, error: e.message });
    }
  }

  // 2. Scrub business-level identifiers. email + google_sub are UNIQUE NOT
  //    NULL, so they get collision-proof placeholders rather than NULL.
  const anon = crypto.createHash('sha256')
    .update(`${businessId}:${Date.now()}`).digest('hex').slice(0, 16);
  await query(
    `UPDATE businesses
        SET name         = 'Erased Business',
            legal_name   = NULL,
            email        = $2,
            google_sub   = $3,
            phone        = NULL,
            address      = NULL,
            display_name = NULL,
            photo_url    = NULL,
            logo_url     = NULL,
            gstin        = NULL,
            pan          = NULL,
            fssai        = NULL,
            upi_id       = NULL,
            bank_account = NULL,
            bank_ifsc    = NULL,
            google_place_id = NULL,
            google_maps_url = NULL,
            deleted_at   = COALESCE(deleted_at, NOW()),
            updated_at   = NOW()
      WHERE id = $1`,
    [businessId, `erased+${anon}@erased.namastepos.invalid`, `erased-${anon}`],
  );
  await query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW())
      WHERE business_id = $1`,
    [businessId],
  );
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE business_id = $1 AND revoked_at IS NULL`,
    [businessId],
  );

  return {
    businessId,
    usersErased: erased.length,
    usersFailed: failed,
    anonRef: anon,
    // Financial rows are intentionally retained — see the doc comment.
    retained: ['orders', 'invoices', 'payments', 'refunds', 'tax_invoices'],
  };
}

// Best-effort CRM timeline entry. logActivity already swallows its own
// errors; the extra guard covers a missing module in a trimmed deploy.
function _activity(businessId, kind, title, body) {
  try {
    require('./crmService').logActivity({
      businessId, kind, title, body: body || null, actorType: 'admin',
    }).catch(() => {});
  } catch (_) { /* non-fatal */ }
}

module.exports = {
  createCustomer,
  updateCustomer,
  extendTrial,
  setPlanManually,
  drilldown,
  addNote,
  deleteNote,
  deleteCustomer,
  // 2026-09-03 tenant-privacy: the ONLY admin path to a single tenant order.
  // Super-admin only + audit-logged at the controller. See the policy block
  // above singleOrderForSupport before wiring this anywhere else.
  singleOrderForSupport,
  maskName,
  maskPhone,
  // 2026-09-03 lifecycle actions
  cancelSubscription,
  changeOwnerEmail,
  resetOwnerCredentials,
  resendWelcomeEmail,
  setAccountFields,
  anonymiseCustomer,
};
