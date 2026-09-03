// Multi-outlet / franchise rollup (Sprint 8 / FF-1201, FF-1202, FF-1203)

const { query, withTransaction } = require('../config/db');
const { NotFound } = require('../utils/errors');

async function listGroups() {
  const r = await query(
    `SELECT g.*, COUNT(b.id)::int AS outlet_count
       FROM outlet_groups g
  LEFT JOIN businesses b ON b.outlet_group_id = g.id
      GROUP BY g.id ORDER BY g.name`
  );
  return r.rows;
}

async function createGroup(name, parentBusinessId) {
  const r = await query(
    `INSERT INTO outlet_groups (name, parent_business_id)
     VALUES ($1, $2) RETURNING *`,
    [name, parentBusinessId || null]
  );
  return r.rows[0];
}

/**
 * 2026-09-03 — PROVISION a brand-new outlet (founder request: "create another
 * outlet" from the dashboard). An outlet is its own `businesses` row, so it
 * starts EMPTY: its own menu, tables, staff, orders, settings, printers,
 * customers and reports. Nothing is copied and nothing is shared except the
 * group rollup — that is what guarantees the data can never mix.
 *
 * The caller (group owner) is added as business_owner of the new outlet so
 * they can switch into it, and it inherits the parent's subscription tier by
 * being placed on the same plan (billing stays one subscription per outlet
 * row, matching how the rest of the system counts limits).
 */
async function provisionOutlet({
  ownerUserId, parentBusinessId, groupId, name, label, city, copyStaff = true,
}) {
  const { NotFound: NF, BadRequest: BR } = require('../utils/errors');
  if (!name || !String(name).trim()) throw new BR('Outlet name is required');

  // Resolve (or create) the group this outlet belongs to.
  let gid = groupId || null;
  if (!gid) {
    const existing = await query(
      `SELECT outlet_group_id FROM businesses WHERE id = $1`, [parentBusinessId]
    );
    gid = existing.rows[0]?.outlet_group_id || null;
  }
  if (!gid) {
    const parent = await query(`SELECT name FROM businesses WHERE id = $1`, [parentBusinessId]);
    if (parent.rowCount === 0) throw new NF('Parent business not found');
    const g = await createGroup(`${parent.rows[0].name} Group`, parentBusinessId);
    gid = g.id;
    // The parent becomes the first outlet in its own group.
    await query(
      `UPDATE businesses SET outlet_group_id = $1 WHERE id = $2 AND outlet_group_id IS NULL`,
      [gid, parentBusinessId]
    );
  }

  const parent = await query(
    `SELECT b.email, b.google_sub, b.display_name, b.photo_url, b.city, b.category,
            s.plan_id
       FROM businesses b
       LEFT JOIN subscriptions s ON s.business_id = b.id
      WHERE b.id = $1`,
    [parentBusinessId]
  );
  if (parent.rowCount === 0) throw new NF('Parent business not found');
  const p = parent.rows[0];

  return withTransaction(async (client) => {
    // `businesses.email` and `google_sub` are both UNIQUE, so an outlet cannot
    // reuse the parent's. Derive a plus-addressed alias (RFC 5233 subaddress —
    // real mail still lands in the owner's inbox) and a synthetic google_sub;
    // the OWNER's login is unaffected because sign-in resolves the user by
    // `users.email` and then the business_users membership, not by this column.
    const stamp = Date.now().toString(36);
    const outletEmail = p.email
      ? p.email.replace(/^([^@]+)@/, `$1+outlet-${stamp}@`)
      : `outlet-${stamp}@namastepos.local`;
    const ins = await client.query(
      `INSERT INTO businesses
         (google_sub, email, display_name, photo_url, name, city, category,
          onboarded, outlet_group_id, outlet_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9)
       RETURNING *`,
      [`outlet-${gid}-${stamp}`, outletEmail, p.display_name, p.photo_url,
       String(name).trim(), city || p.city || null, p.category || null,
       gid, (label || String(name)).trim().slice(0, 80)]
    );
    const outlet = ins.rows[0];

    // The group owner owns the new outlet too (so they can switch into it).
    await client.query(
      `INSERT INTO business_users (business_id, user_id, role)
       VALUES ($1, $2, 'business_owner')
       ON CONFLICT (business_id, user_id) DO NOTHING`,
      [outlet.id, ownerUserId]
    );

    // Mirror the parent's plan so gating/limits behave from day one.
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_end)
       VALUES ($1, COALESCE($2, (SELECT id FROM plans WHERE tier = 'free')),
               'active', NOW() + INTERVAL '30 days')
       ON CONFLICT (business_id) DO NOTHING`,
      [outlet.id, p.plan_id || null]
    );

    // Seed the HQ's staff roster (same roles + permission lists) unless the
    // caller opted out — "everything should be same as per main outlet".
    let staffCopied = 0;
    if (copyStaff !== false) {
      staffCopied = await copyStaffToOutlet(parentBusinessId, outlet.id, client);
    }

    return { outlet, groupId: gid, staffCopied };
  });
}

/**
 * 2026-09-03 (founder: "multi outlet should be synced with plans and features,
 * also on staff") — propagate the HQ's plan to every outlet in its group.
 *
 * Each outlet has its OWN subscription row (that is how limits are counted per
 * branch and how data stays isolated), but the ENTITLEMENT must match the HQ:
 * an owner who buys Pro for the group should not find a branch stuck on
 * starter. Called after any plan change on the group parent. Returns the
 * outlet ids updated.
 */
async function syncPlanToOutlets(parentBusinessId) {
  const g = await query(
    `SELECT og.id AS group_id
       FROM outlet_groups og
      WHERE og.parent_business_id = $1
      LIMIT 1`,
    [parentBusinessId]
  );
  if (g.rowCount === 0) return [];   // not an HQ — nothing to propagate
  const groupId = g.rows[0].group_id;

  const parentSub = await query(
    `SELECT plan_id, status, billing_period, current_period_end
       FROM subscriptions WHERE business_id = $1 LIMIT 1`,
    [parentBusinessId]
  );
  if (parentSub.rowCount === 0) return [];
  const p = parentSub.rows[0];

  const kids = await query(
    `SELECT id FROM businesses
      WHERE outlet_group_id = $1 AND id <> $2 AND deleted_at IS NULL`,
    [groupId, parentBusinessId]
  );
  const updated = [];
  for (const k of kids.rows) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, billing_period, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id) DO UPDATE
         SET plan_id = EXCLUDED.plan_id,
             status = EXCLUDED.status,
             billing_period = EXCLUDED.billing_period,
             current_period_end = EXCLUDED.current_period_end,
             updated_at = NOW()`,
      [k.id, p.plan_id, p.status, p.billing_period || 'monthly', p.current_period_end]
    );
    try { require('./featureService').clearCache(k.id); } catch (_) { /* non-fatal */ }
    // Feature overrides the admin set on the HQ apply to the whole group too,
    // so a bespoke capability isn't silently HQ-only.
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO business_feature_overrides (business_id, feature_key, enabled, reason)
       SELECT $1, feature_key, enabled, COALESCE(reason, '') || ' [synced from HQ]'
         FROM business_feature_overrides WHERE business_id = $2
       ON CONFLICT (business_id, feature_key) DO UPDATE
         SET enabled = EXCLUDED.enabled`,
      [k.id, parentBusinessId]
    );
    try { require('./featureService').clearCache(k.id); } catch (_) { /* non-fatal */ }
    updated.push(k.id);
  }
  if (updated.length > 0) {
    logger.info(`[outlets] plan synced from HQ ${parentBusinessId} to ${updated.length} outlet(s)`);
  }
  return updated;
}

/**
 * Copy the HQ's staff roster into a newly provisioned outlet — same people,
 * same roles, same explicit permission lists ("access, permissions on each as
 * like main outlet"). The staff records themselves stay per-outlet rows, so
 * a later change in one branch does NOT leak into another; this is a one-time
 * seed at provisioning, not a live mirror. PINs are per person and are not
 * copied — staff sign in with phone + their own PIN.
 */
async function copyStaffToOutlet(parentBusinessId, outletId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const r = await q(
    `INSERT INTO business_users (business_id, user_id, role, permissions, is_active, invited_by)
     SELECT $1, bu.user_id, bu.role, bu.permissions, bu.is_active, bu.invited_by
       FROM business_users bu
      WHERE bu.business_id = $2 AND bu.is_active = TRUE
     ON CONFLICT (business_id, user_id) DO NOTHING
     RETURNING user_id`,
    [outletId, parentBusinessId]
  );
  return r.rowCount;
}

/**
 * Every outlet the signed-in user can act in (for the dashboard switcher).
 * Membership comes from business_users, so a manager who only belongs to one
 * branch sees only that branch.
 */
async function listOutletsForUser(userId, currentBusinessId) {
  const r = await query(
    `SELECT b.id, b.name, b.outlet_label, b.city, b.outlet_group_id,
            bu.role, og.name AS group_name,
            (og.parent_business_id = b.id) AS is_parent
       FROM business_users bu
       JOIN businesses b ON b.id = bu.business_id
       LEFT JOIN outlet_groups og ON og.id = b.outlet_group_id
      WHERE bu.user_id = $1 AND bu.is_active = TRUE AND b.deleted_at IS NULL
      ORDER BY (og.parent_business_id = b.id) DESC NULLS LAST, b.created_at ASC`,
    [userId]
  );
  return r.rows.map((row) => ({
    businessId: row.id,
    name: row.name,
    outletLabel: row.outlet_label || row.name,
    city: row.city,
    groupId: row.outlet_group_id,
    groupName: row.group_name,
    isParent: !!row.is_parent,
    role: row.role,
    current: row.id === currentBusinessId,
  }));
}

// ── Outlet deletion, gated by an email OTP to the primary owner ──────────
// Founder: "primary owner should have rights to delete the outlet but with
// email OTP verification required for that." Deleting a branch destroys its
// orders/reports, so we require proof of inbox control — the same
// challenge-response shape as phone OTP, reusing `otp_requests` (its `phone`
// column carries the email for this purpose; documented here so nobody
// mistakes it for a phone number).
const OUTLET_DELETE_PURPOSE = 'outlet_delete';
const OUTLET_DELETE_TTL_MIN = 10;

/** The group's HQ business id, or null when this business isn't grouped. */
async function _hqFor(businessId) {
  const r = await query(
    `SELECT og.parent_business_id, b.outlet_group_id
       FROM businesses b
       LEFT JOIN outlet_groups og ON og.id = b.outlet_group_id
      WHERE b.id = $1`,
    [businessId]
  );
  if (r.rowCount === 0) return null;
  return { hqId: r.rows[0].parent_business_id, groupId: r.rows[0].outlet_group_id };
}

/**
 * Assert the caller is the PRIMARY (HQ) owner and the target is a deletable
 * outlet — never the HQ itself, never a business outside the caller's group.
 */
async function assertCanDeleteOutlet(userId, callerBusinessId, targetBusinessId) {
  const { Forbidden: FB, NotFound: NF, BadRequest: BR } = require('../utils/errors');
  const target = await _hqFor(targetBusinessId);
  if (!target || !target.groupId) throw new NF('Outlet not found');
  const caller = await _hqFor(callerBusinessId);
  if (!caller || caller.groupId !== target.groupId) {
    throw new FB('You can only delete outlets in your own group');
  }
  if (target.hqId === targetBusinessId) {
    throw new BR('The primary outlet (HQ) cannot be deleted. Close the account instead.');
  }
  // Only the HQ's owner may delete a branch — a branch owner cannot.
  if (callerBusinessId !== target.hqId) {
    throw new FB('Only the primary outlet owner can delete an outlet');
  }
  const own = await query(
    `SELECT 1 FROM business_users
      WHERE user_id = $1 AND business_id = $2
        AND role = 'business_owner' AND is_active = TRUE LIMIT 1`,
    [userId, target.hqId]
  );
  if (own.rowCount === 0) throw new FB('Only the primary outlet owner can delete an outlet');
  return target;
}

/** Send a 6-digit code to the HQ owner's email. Returns { requestId, sentTo }. */
async function requestOutletDeleteOtp({ userId, callerBusinessId, targetBusinessId }) {
  await assertCanDeleteOutlet(userId, callerBusinessId, targetBusinessId);
  const bcrypt = require('bcryptjs');
  const owner = await query(
    `SELECT u.email FROM users u WHERE u.id = $1`, [userId]
  );
  const email = owner.rows[0]?.email;
  if (!email) {
    const { BadRequest: BR } = require('../utils/errors');
    throw new BR('No email on file for your account');
  }
  const target = await query(
    `SELECT name, outlet_label FROM businesses WHERE id = $1`, [targetBusinessId]
  );
  const label = target.rows[0]?.outlet_label || target.rows[0]?.name || 'this outlet';

  // Rate-limit: 5 delete-OTPs per hour per email.
  const recent = await query(
    `SELECT COUNT(*)::int AS c FROM otp_requests
      WHERE phone = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
    [email, OUTLET_DELETE_PURPOSE]
  );
  if (recent.rows[0].c >= 5) {
    const { TooManyRequests } = require('../utils/errors');
    throw new TooManyRequests('Too many delete requests. Try again in an hour.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const ins = await query(
    `INSERT INTO otp_requests (phone, purpose, code_hash, expires_at, meta)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, $5::jsonb)
     RETURNING id, expires_at`,
    [email, OUTLET_DELETE_PURPOSE, codeHash, String(OUTLET_DELETE_TTL_MIN),
     JSON.stringify({ targetBusinessId, callerBusinessId, userId })]
  );

  await require('./emailService').sendMail({
    template: 'outlet_delete_otp',
    recipient: email,
    subject: `Confirm deleting "${label}" — code ${code}`,
    html: `<p>You asked to delete the outlet <b>${label}</b> from your NamastePOS group.</p>
           <p style="font-size:22px;letter-spacing:3px"><b>${code}</b></p>
           <p>This code expires in ${OUTLET_DELETE_TTL_MIN} minutes. Deleting an outlet
           removes its orders, menu, staff and reports — it cannot be undone.
           If you did not request this, ignore this email and change your password.</p>`,
    text: `Code ${code} to delete outlet "${label}". Expires in ${OUTLET_DELETE_TTL_MIN} minutes.`,
  }).catch((e) => { logger.warn(`[outlets] delete OTP email failed: ${e.message}`); });

  return { requestId: ins.rows[0].id, sentTo: email.replace(/^(.).*(@.*)$/, '$1•••$2'),
    expiresAt: ins.rows[0].expires_at };
}

/** Verify the emailed code and SOFT-delete the outlet (history is retained). */
async function deleteOutletWithOtp({ userId, callerBusinessId, targetBusinessId, requestId, code }) {
  const { Forbidden: FB, BadRequest: BR } = require('../utils/errors');
  await assertCanDeleteOutlet(userId, callerBusinessId, targetBusinessId);
  const bcrypt = require('bcryptjs');
  const r = await query(
    `SELECT * FROM otp_requests
      WHERE id = $1 AND purpose = $2 AND verified_at IS NULL
        AND expires_at > NOW() AND attempts < 5
      LIMIT 1`,
    [requestId, OUTLET_DELETE_PURPOSE]
  );
  if (r.rowCount === 0) throw new BR('Code expired or already used — request a new one');
  const row = r.rows[0];
  const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta || {});
  // The code is bound to the exact outlet + requester it was issued for.
  if (meta.targetBusinessId !== targetBusinessId || meta.userId !== userId) {
    throw new FB('This code was issued for a different request');
  }
  const ok = await bcrypt.compare(String(code), row.code_hash);
  await query(`UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1`, [requestId]);
  if (!ok) throw new BR('Incorrect code');
  await query(`UPDATE otp_requests SET verified_at = NOW() WHERE id = $1`, [requestId]);

  // Soft delete: the row (and its orders/invoices) stays for GST + audit, but
  // the outlet disappears from the switcher, rollups and every listing.
  await query(
    `UPDATE businesses SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
    [targetBusinessId]
  );
  await query(
    `UPDATE business_users SET is_active = FALSE WHERE business_id = $1`,
    [targetBusinessId]
  );
  await query(
    `UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = TRUE
      WHERE business_id = $1`,
    [targetBusinessId]
  );
  try { require('./featureService').clearCache(targetBusinessId); } catch (_) { /* non-fatal */ }
  logger.info(`[outlets] outlet ${targetBusinessId} deleted by owner ${userId} (OTP verified)`);
  return { deleted: true, businessId: targetBusinessId };
}

async function addOutlet(groupId, businessId, label) {
  await query(
    `UPDATE businesses SET outlet_group_id = $1, outlet_label = $2
      WHERE id = $3`,
    [groupId, label || null, businessId]
  );
}

async function groupRollup(groupId, { startDate, endDate }) {
  const outlets = await query(
    `SELECT id, name, outlet_label FROM businesses
      WHERE outlet_group_id = $1 AND deleted_at IS NULL`,
    [groupId]
  );
  if (outlets.rowCount === 0) throw new NotFound('No outlets in group');

  const ids = outlets.rows.map((o) => o.id);
  const perOutlet = await query(
    `SELECT business_id,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total), 0)::float AS gross,
            COALESCE(SUM(food_cost_paise), 0)::bigint AS food_cost_paise
       FROM orders
      WHERE business_id = ANY($1::uuid[])
        AND created_at >= $2::date
        AND created_at < ($3::date + INTERVAL '1 day')
        AND status <> 'cancelled'
      GROUP BY business_id`,
    [ids, startDate, endDate]
  );
  const byBiz = new Map(perOutlet.rows.map((r) => [r.business_id, r]));
  const grouped = outlets.rows.map((o) => ({
    businessId: o.id,
    name: o.name,
    outletLabel: o.outlet_label,
    metrics: byBiz.get(o.id) || { orders: 0, gross: 0, food_cost_paise: 0 },
  }));
  return {
    outlets: grouped,
    totals: {
      orders:   grouped.reduce((s, x) => s + Number(x.metrics.orders), 0),
      grossInr: grouped.reduce((s, x) => s + Number(x.metrics.gross), 0),
      foodCostInr: grouped.reduce((s, x) => s + Number(x.metrics.food_cost_paise), 0) / 100,
    },
  };
}

async function transferStock(groupId, body, initiatedBy) {
  const { fromBusinessId, toBusinessId, ingredientId, menuItemId, qty, unit, notes } = body;
  const { BadRequest } = require('../utils/errors');
  if (!fromBusinessId || !toBusinessId || !(Number(qty) > 0)) {
    throw new BadRequest('fromBusinessId, toBusinessId and a positive qty are required');
  }
  return withTransaction(async (client) => {
    // SECURITY FIX (2026-08-23, review C1): both ends of a transfer must
    // be members of THIS group — previously arbitrary businessIds were
    // accepted, letting a tenant mutate another tenant's stock.
    const members = await client.query(
      `SELECT id FROM businesses
        WHERE outlet_group_id = $1 AND id = ANY($2::uuid[])`,
      [groupId, [fromBusinessId, toBusinessId]],
    );
    if (members.rowCount !== new Set([fromBusinessId, toBusinessId]).size) {
      const { Forbidden } = require('../utils/errors');
      throw new Forbidden('Both outlets must belong to this group');
    }
    const t = await client.query(
      `INSERT INTO stock_transfers
         (outlet_group_id, from_business_id, to_business_id, ingredient_id,
          menu_item_id, qty, unit, initiated_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [groupId, fromBusinessId, toBusinessId, ingredientId || null,
       menuItemId || null, qty, unit || null, initiatedBy, notes || null]
    );
    return t.rows[0];
  });
}

async function receiveTransfer(transferId, receivedBy, groupId = null) {
  return withTransaction(async (client) => {
    // SECURITY FIX (2026-08-23, review C1): scope by outlet group so a
    // caller can only receive transfers belonging to their own group.
    const t = await client.query(
      `UPDATE stock_transfers SET status = 'received',
                                  received_at = NOW(),
                                  received_by_user_id = $1
        WHERE id = $2 AND status IN ('pending', 'in_transit')
          AND ($3::uuid IS NULL OR outlet_group_id = $3::uuid)
        RETURNING *`,
      [receivedBy, transferId, groupId]
    );
    if (t.rowCount === 0) throw new NotFound('Transfer not found or already received');
    const xfer = t.rows[0];
    if (xfer.ingredient_id) {
      // Move stock from → to (only the *destination* knows the NamastePOS ingredient
      // by id since each tenant has separate ingredients; in practice this would
      // be matched on name+unit. Simplification here.)
      await client.query(
        `UPDATE ingredients SET stock = stock + $1
          WHERE business_id = $2 AND id = $3`,
        [xfer.qty, xfer.to_business_id, xfer.ingredient_id]
      );
      await client.query(
        `UPDATE ingredients SET stock = GREATEST(0, stock - $1)
          WHERE business_id = $2 AND id = $3`,
        [xfer.qty, xfer.from_business_id, xfer.ingredient_id]
      );
    }
    return xfer;
  });
}

async function setFranchisePrice(groupId, sku, price) {
  await query(
    `INSERT INTO franchise_prices (outlet_group_id, menu_item_sku, price)
     VALUES ($1, $2, $3)
     ON CONFLICT (outlet_group_id, menu_item_sku) DO UPDATE
       SET price = EXCLUDED.price, updated_at = NOW()`,
    [groupId, sku, price]
  );
}

async function listFranchisePrices(groupId) {
  const r = await query(
    `SELECT * FROM franchise_prices WHERE outlet_group_id = $1 ORDER BY menu_item_sku`,
    [groupId]
  );
  return r.rows;
}

// Security-scoped list — only return groups the caller's business belongs to.
async function listGroupsForOwner(businessId) {
  const r = await query(
    `SELECT g.*, COUNT(b2.id)::int AS outlet_count
       FROM outlet_groups g
       JOIN businesses b1 ON b1.outlet_group_id = g.id AND b1.id = $1
  LEFT JOIN businesses b2 ON b2.outlet_group_id = g.id
      GROUP BY g.id ORDER BY g.name`,
    [businessId]
  );
  return r.rows;
}

module.exports = {
  listGroups, listGroupsForOwner, createGroup, addOutlet, groupRollup,
  provisionOutlet, listOutletsForUser,
  syncPlanToOutlets, copyStaffToOutlet,
  assertCanDeleteOutlet, requestOutletDeleteOtp, deleteOutletWithOtp,
  transferStock, receiveTransfer,
  setFranchisePrice, listFranchisePrices,
};
