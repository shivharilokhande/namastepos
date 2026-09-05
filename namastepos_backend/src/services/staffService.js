// NamastePOS backend - staff (business_users + invitations) service

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const { NotFound, Conflict, BadRequest } = require('../utils/errors');

/**
 * Security review 2026-09-04 (item 1) — drop the cached RBAC membership for a
 * staff member (or, with no userId, for every member of the business) the
 * moment their role / permissions / active flag changes.
 *
 * middleware/auth.js caches `business_users.role + permissions` for 30s per
 * (userId, businessId) to keep the permission gate off the hot path. Nothing
 * used to invalidate it, so "Remove staff" / "change role" / "untick a
 * permission" took up to 30 seconds to bite — on EVERY instance, with no
 * cross-instance signal at all. This helper publishes on the shared Redis
 * cache bus (local-only when REDIS_URL is unset).
 *
 * Deliberately non-throwing: a cache miss is a 30s staleness, never a reason
 * to fail the owner's write.
 */
function _invalidateMembership(businessId, userId) {
  try {
    require('../middleware/auth').invalidateMembership(businessId, userId);
  } catch (_) { /* non-fatal — worst case we fall back to the TTL */ }
}

const STAFF_ROLES = [
  'staff_manager',
  'staff_captain',
  'staff_waiter',
  'staff_cashier',
  'staff_kitchen',
  'staff_driver', // 2026-08-22 — delivery rider (PIN sign-in, driver screen)
];

// NOTE: informational only — the authoritative cap is plans.limits.staff
// (enforced by subscriptionService.enforceLimit / complyStaffLimit),
// and staff caps EXCLUDE the owner from the count.
const TIER_STAFF_CAPS = {
  starter: 1, // staff only — owner is not counted
  pro: 3,
  enterprise: Infinity,
};

// Push 14c — full permission keyspace. Keep in sync with the mobile
// app's namastepos_flutter/lib/utils/role_permissions.dart areas list.
// The owner can toggle any subset of these per-staff; new staff get
// the role's defaults below.
// Push 16a — added per-report permission keys so owners can grant P&L /
// register / tax-invoice access independently. Previously the drawer
// gated these on 'orders' OR 'reports', which let captain see them.
// `memberships` removed (Push 16b — feature deprecated).
const PERMISSION_KEYS = [
  'home', 'pos', 'orders', 'tables', 'reports',
  'pnl_statement', 'income_register', 'expense_register',
  'invoice_register', 'tax_invoices',
  'menu_editor', 'modifier_groups',
  'customers', 'reservations',
  'wastage', 'daily_closing',
  'kds', 'captain', 'driver',
  'surge', 'qr_codes',
  'bill_template', 'thermal_printer', 'aggregators',
  'whatsapp_marketing', 'auto_whatsapp_order',
  // NP-201: 'expenses' (booking petty cash) was already a key the mobile
  // drawer gated on (role_permissions.dart granted it to cashiers) but it was
  // missing from the backend keyspace, so the /expenses endpoints had nothing
  // to authorise against and ran wide open. Added here so the owner can toggle
  // it per-staff and requireStaffPerm has a key to check.
  'expenses',
];

const DEFAULT_PERMS_BY_ROLE = {
  staff_manager: [
    'home', 'pos', 'orders', 'tables', 'reports',
    'pnl_statement', 'income_register', 'expense_register',
    'invoice_register', 'tax_invoices',
    'menu_editor', 'modifier_groups',
    'customers', 'reservations',
    'wastage', 'daily_closing',
    'kds', 'captain', 'driver',
    'surge', 'qr_codes',
    'bill_template', 'thermal_printer', 'aggregators',
    'whatsapp_marketing', 'auto_whatsapp_order',
    'expenses',
  ],
  // Captain → just POS + Orders + Tables. NO reports / no invoices /
  // no P&L (was leaking via the loose 'orders OR reports' drawer gate).
  staff_captain: [
    'home', 'pos', 'orders', 'tables', 'customers', 'captain',
  ],
  staff_waiter: [
    'home', 'pos', 'tables', 'captain',
  ],
  // Cashier handles bills + tax invoices, gets reports but NOT P&L.
  staff_cashier: [
    'home', 'pos', 'orders', 'reports',
    'tax_invoices', 'invoice_register',
    'customers', 'bill_template',
    // FF-332 / NP-201: cashiers book petty cash at the register.
    'expenses',
  ],
  staff_kitchen: [
    'home', 'kds',
  ],
  staff_driver: [
    'home', 'driver',
  ],
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function serializeStaff(row) {
  // Display-name resolution:
  //   - Owner row → always shows the business name. Single-proprietor
  //     convention — the owner's identity in the Staff list is the
  //     business itself. Tap into User profile if you ever want their
  //     personal name.
  //   - Non-owner rows → use the user's display_name; fall back to the
  //     email's local part, then a generic "Staff".
  let displayName;
  if (row.role === 'business_owner') {
    displayName = row.business_name
                  || row.display_name
                  || (row.email ? String(row.email).split('@')[0] : 'Owner');
  } else {
    displayName = row.display_name
                  || (row.email ? String(row.email).split('@')[0] : 'Staff');
  }
  return {
    membershipId: row.id,
    userId: row.user_id,
    businessId: row.business_id,
    role: row.role,
    isActive: row.is_active,
    joinedAt: row.joined_at,
    email: row.email,
    displayName,
    photoUrl: row.photo_url,
    // Surface owner's phone so the Staff page can show it next to the
    // owner row. Non-owner staff rows still rely on their own data.
    phone: row.user_phone || null,
    lastSeenAt: row.last_seen_at,
  };
}

function serializeInvite(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

async function listStaff(businessId) {
  // Join on businesses so the owner row can display the business
  // name (single-proprietor convention: "Cafe Sugar & Spice" not the
  // person's name). Non-owners still get their own display_name.
  const r = await query(
    `SELECT bu.*, u.email, u.display_name, u.photo_url, u.last_seen_at,
            u.phone AS user_phone, b.name AS business_name
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
       LEFT JOIN businesses b ON b.id = bu.business_id
      WHERE bu.business_id = $1 AND bu.is_active = TRUE
      ORDER BY bu.joined_at ASC`,
    [businessId],
  );
  return r.rows.map(serializeStaff);
}

async function listInvitations(businessId) {
  const r = await query(
    `SELECT * FROM invitations WHERE business_id = $1
      ORDER BY created_at DESC`,
    [businessId],
  );
  return r.rows.map(serializeInvite);
}

async function invite({ businessId, invitedBy, email, role = 'staff_cashier' }) {
  // Block duplicate pending invites for same email
  const dup = await query(
    `SELECT 1 FROM invitations
      WHERE business_id = $1 AND email = $2 AND status = 'pending'`,
    [businessId, email],
  );
  if (dup.rowCount > 0) throw new Conflict('Invite already pending for this email');

  // If user with this email exists AND is already a member, conflict
  const existing = await query(
    `SELECT bu.* FROM business_users bu
       JOIN users u ON u.id = bu.user_id
      WHERE bu.business_id = $1 AND u.email = $2`,
    [businessId, email],
  );
  if (existing.rowCount > 0) throw new Conflict('User is already a member');

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const r = await query(
    `INSERT INTO invitations
       (business_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
     RETURNING *`,
    [businessId, email, role, tokenHash, invitedBy],
  );
  return { invite: serializeInvite(r.rows[0]), token };
}

async function revokeInvite({ businessId, inviteId }) {
  const r = await query(
    `UPDATE invitations SET status = 'revoked'
      WHERE business_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
    [businessId, inviteId],
  );
  if (r.rowCount === 0) throw new NotFound('Invitation not found or already finalised');
  return serializeInvite(r.rows[0]);
}

/**
 * Accept an invitation. The caller must be authenticated as a user whose
 * email matches the invite (or the inviter chose to use any-email policy).
 */
async function acceptInvite({ token, user }) {
  const tokenHash = hashToken(token);
  const r = await query(
    `SELECT * FROM invitations
      WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );
  if (r.rowCount === 0) throw new NotFound('Invitation invalid or expired');
  const invite = r.rows[0];
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new BadRequest('Invitation was sent to a different email');
  }
  await query(
    `INSERT INTO business_users (business_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, is_active = TRUE`,
    [invite.business_id, user.id, invite.role, invite.invited_by],
  );
  await query(
    `UPDATE invitations SET status = 'accepted', accepted_at = NOW()
      WHERE id = $1`,
    [invite.id],
  );
  // The upsert above may have REACTIVATED a previously removed member with a
  // new role — an entry for them can already be cached.
  _invalidateMembership(invite.business_id, user.id);
  return { businessId: invite.business_id, role: invite.role };
}

async function updateRole({ businessId, userId, role }) {
  const r = await query(
    `UPDATE business_users SET role = $1
      WHERE business_id = $2 AND user_id = $3 AND is_active = TRUE
      RETURNING *`,
    [role, businessId, userId],
  );
  if (r.rowCount === 0) throw new NotFound('Member not found');
  _invalidateMembership(businessId, userId);
  return r.rows[0];
}

async function removeStaff({ businessId, userId, actingUserId }) {
  if (userId === actingUserId) {
    throw new BadRequest('You cannot remove yourself; transfer ownership first');
  }
  const r = await query(
    `UPDATE business_users SET is_active = FALSE
      WHERE business_id = $1 AND user_id = $2
      RETURNING *`,
    [businessId, userId],
  );
  if (r.rowCount === 0) throw new NotFound('Member not found');
  // THE case this whole mechanism exists for: a removed staff member must
  // stop authorising on the next request, not 30s later on one instance only.
  _invalidateMembership(businessId, userId);
  return r.rows[0];
}

// ──────────────────────────────────────────────────────────────────────
// Push 14a — Direct staff CRUD with PIN-based login (no email invite).
// Owners use this to add captains/waiters/cooks etc. who'll sign in on
// the same device with a 4-digit PIN.
// ──────────────────────────────────────────────────────────────────────

function serializeStaffPin(row) {
  // Resolve effective permissions: explicit row value if non-empty,
  // otherwise the role's defaults. Owners always have full access — the
  // client should treat business_owner as "all perms" and never check
  // this list for them.
  const raw = row.permissions;
  const explicit = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
  const effective = explicit.length > 0
    ? explicit
    : (DEFAULT_PERMS_BY_ROLE[row.role] || []);
  // displayName resolution mirrors serializeStaff: owner → business name;
  // non-owner → PIN row's name, then user's name, then email username.
  let displayName;
  if (row.role === 'business_owner') {
    displayName = row.business_name
                  || row.bu_display_name
                  || row.u_display_name
                  || (row.email ? String(row.email).split('@')[0] : 'Owner');
  } else {
    displayName = row.bu_display_name
                  || row.u_display_name
                  || (row.email ? String(row.email).split('@')[0] : 'Staff');
  }
  return {
    userId: row.user_id,
    businessId: row.business_id,
    role: row.role,
    displayName,
    email: row.email,
    phone: row.phone,
    isActive: row.is_active,
    hasPin: row.pin_hash != null,
    createdAt: row.joined_at || row.created_at,
    permissions: effective,
  };
}

async function listStaffWithPin(businessId) {
  // Same join as listStaff — pulls businesses.name so the owner row in
  // the PIN-staff endpoint can display the business name when
  // business_users.display_name is null. The PIN endpoint is what the
  // dashboard's Staff page actually calls (separate from `list`).
  const r = await query(
    `SELECT bu.user_id, bu.business_id, bu.role,
            bu.display_name AS bu_display_name,
            u.display_name  AS u_display_name,
            bu.pin_hash, bu.is_active, bu.joined_at, bu.permissions,
            u.email, u.phone, b.name AS business_name
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
       LEFT JOIN businesses b ON b.id = bu.business_id
      WHERE bu.business_id = $1
      ORDER BY bu.role, bu.display_name`,
    [businessId],
  );
  return r.rows.map(serializeStaffPin);
}

async function createStaffWithPin(businessId, body) {
  const { displayName, role, pin, phone, email } = body;
  if (!displayName) throw new BadRequest('Name required');
  if (!STAFF_ROLES.includes(role)) {
    throw new BadRequest(`Role must be one of: ${STAFF_ROLES.join(', ')}`);
  }
  if (!pin || !/^\d{4}$/.test(pin)) {
    throw new BadRequest('PIN must be exactly 4 digits');
  }
  if (!phone) {
    throw new BadRequest('Phone number required — used as the unique key for staff');
  }

  // Push 14a polish: phone is the PRIMARY identifier for staff. If a row
  // already exists for this (business, phone), reactivate it instead of
  // creating a duplicate. Prevents the "I deleted Arun then added him
  // back and now there are two Aruns" bug.
  const existingByPhone = await query(
    `SELECT bu.user_id, bu.is_active FROM business_users bu
       JOIN users u ON u.id = bu.user_id
      WHERE bu.business_id = $1 AND u.phone = $2
      LIMIT 1`,
    [businessId, phone],
  );
  if (existingByPhone.rowCount > 0) {
    const userId = existingByPhone.rows[0].user_id;
    if (existingByPhone.rows[0].is_active) {
      throw new Conflict('Active staff already exists with this phone');
    }
    // Reactivate + refresh fields. Treats this as an undelete.
    const pinHash = await bcrypt.hash(pin, 10);
    await query(
      `UPDATE business_users
          SET role = $1::user_role, display_name = $2, pin_hash = $3,
              is_active = TRUE
        WHERE business_id = $4 AND user_id = $5`,
      [role, displayName, pinHash, businessId, userId],
    );
    await query(
      'UPDATE users SET display_name = $1 WHERE id = $2',
      [displayName, userId],
    );
    // Undelete path: role + is_active just changed on an existing row, so a
    // stale "not a member" / old-role entry may be cached.
    _invalidateMembership(businessId, userId);
    const fresh = await query(
      `SELECT bu.user_id, bu.business_id, bu.role, bu.display_name, bu.pin_hash,
              bu.is_active, bu.joined_at, bu.permissions, u.email, u.phone
         FROM business_users bu
         JOIN users u ON u.id = bu.user_id
        WHERE bu.user_id = $1 AND bu.business_id = $2 LIMIT 1`,
      [userId, businessId],
    );
    return serializeStaffPin(fresh.rows[0]);
  }

  // Push 14c.4: tier-cap check moved to subscriptionService.enforceLimit
  // middleware on the route. It reads the authoritative limit from
  // plans.limits.staff (set by the super-admin) instead of the
  // hardcoded TIER_STAFF_CAPS map below. Keeping the map only for the
  // `listStaffWithPin` summary view since it's still informational.

  // Cross-business identity (2026-08-26): a phone number identifies a PERSON,
  // not a single restaurant. The same staffer can legitimately work at two
  // restaurants that both run NamastePOS (part-time, or moved jobs and the
  // old owner hasn't deactivated them yet). users.phone is NOT unique, so we
  // treat the phone as the person's identity: if a user row already exists
  // for this phone, REUSE it and just add a new membership for THIS business.
  // Never block the second owner with "phone already in use" — the two
  // memberships are independent, each with its own PIN/role/permissions.
  let userId;
  let createdNewUser = false;
  const existingUser = await query(
    'SELECT id FROM users WHERE phone = $1 ORDER BY created_at ASC LIMIT 1',
    [phone],
  );
  if (existingUser.rowCount > 0) {
    userId = existingUser.rows[0].id;
    // Backfill display_name only if the shared user row never had one; do not
    // clobber the name another restaurant is already using for this person.
    await query(
      `UPDATE users SET display_name = COALESCE(NULLIF(display_name, ''), $1)
        WHERE id = $2`,
      [displayName, userId],
    );
  } else {
    userId = uuid();
    createdNewUser = true;
    const userEmail = email || `${userId}@staff.namastepos.local`;
    try {
      await query(
        `INSERT INTO users (id, email, phone, display_name)
         VALUES ($1, $2, $3, $4)`,
        [userId, userEmail, phone, displayName],
      );
    } catch (err) {
      if (err.code === '23505') throw new Conflict('Email already in use');
      throw err;
    }
  }

  const pinHash = await bcrypt.hash(pin, 10);
  // Seed permissions from owner's checkbox selection if provided,
  // otherwise from the role's defaults.
  const seededPerms = Array.isArray(body.permissions)
    ? body.permissions.filter((k) => PERMISSION_KEYS.includes(k))
    : (DEFAULT_PERMS_BY_ROLE[role] || []);
  try {
    await query(
      `INSERT INTO business_users
         (business_id, user_id, role, display_name, pin_hash, is_active, permissions)
       VALUES ($1, $2, $3::user_role, $4, $5, TRUE, $6::jsonb)
       ON CONFLICT (business_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, display_name = EXCLUDED.display_name,
             pin_hash = EXCLUDED.pin_hash, is_active = TRUE,
             permissions = EXCLUDED.permissions`,
      [businessId, userId, role, displayName, pinHash,
        JSON.stringify(seededPerms)],
    );
  } catch (err) {
    // Roll back the orphaned users row ONLY if we created it in this call.
    // A reused user (shared with another restaurant) must never be deleted —
    // that would wipe the person's membership at their other job.
    if (createdNewUser) {
      await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    // 22P02 = invalid_text_representation → the role value isn't in the
    // user_role enum yet. This is exactly what happens for 'staff_driver'
    // when migration 054 (ADD VALUE 'staff_driver') hasn't been applied.
    if (err.code === '22P02' && role === 'staff_driver') {
      throw new BadRequest(
        'The Driver role needs a pending database update. Run "npm run migrate" on the backend (applies migration 054), then try again.',
      );
    }
    throw err;
  }

  // The upsert's DO UPDATE branch can revive a soft-deleted member with a new
  // role + permission list, so an existing cache entry must go.
  _invalidateMembership(businessId, userId);

  // 2026-08-22: driver staff also get a drivers-table record so the
  // delivery-assignment picker sees them immediately. Best-effort —
  // a duplicate phone just reactivates the existing driver row.
  if (role === 'staff_driver') {
    try {
      await query(
        `INSERT INTO drivers (business_id, name, phone)
         VALUES ($1, $2, $3)`,
        [businessId, displayName, phone],
      );
    } catch (err) {
      if (err.code === '23505') {
        await query(
          `UPDATE drivers SET name = $1, is_active = TRUE
            WHERE business_id = $2 AND phone = $3`,
          [displayName, businessId, phone],
        );
      } // any other failure is non-fatal — staff row already exists
    }
  }

  const fresh = await query(
    `SELECT bu.user_id, bu.business_id, bu.role, bu.display_name, bu.pin_hash,
            bu.is_active, bu.joined_at, bu.permissions, u.email, u.phone
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
      WHERE bu.user_id = $1 AND bu.business_id = $2 LIMIT 1`,
    [userId, businessId],
  );
  return serializeStaffPin(fresh.rows[0]);
}

async function updateStaffWithPin(businessId, userId, patch) {
  // business_users updates (role / display_name / pin / active)
  const sets = [];
  const values = [];
  let idx = 1;
  if (patch.displayName) {
    sets.push(`display_name = $${idx++}`); values.push(patch.displayName);
  }
  if (patch.role) {
    if (!STAFF_ROLES.includes(patch.role)) {
      throw new BadRequest(`Invalid role: ${patch.role}`);
    }
    sets.push(`role = $${idx++}::user_role`); values.push(patch.role);
  }
  if (patch.pin) {
    if (!/^\d{4}$/.test(patch.pin)) {
      throw new BadRequest('PIN must be exactly 4 digits');
    }
    sets.push(`pin_hash = $${idx++}`);
    values.push(await bcrypt.hash(patch.pin, 10));
  }
  if (typeof patch.isActive === 'boolean') {
    sets.push(`is_active = $${idx++}`); values.push(patch.isActive);
  }
  if (Array.isArray(patch.permissions)) {
    // Reject any unknown keys to keep the column tidy.
    const clean = patch.permissions.filter((k) => PERMISSION_KEYS.includes(k));
    sets.push(`permissions = $${idx++}::jsonb`);
    values.push(JSON.stringify(clean));
  }

  // users updates (phone / display_name) — phone lives on users not
  // business_users. Without this, the edit sheet's phone field would be
  // silently dropped.
  const userSets = [];
  const userValues = [];
  let uidx = 1;
  if (patch.phone !== undefined) {
    userSets.push(`phone = $${uidx++}`);
    userValues.push(patch.phone === '' ? null : patch.phone);
  }
  if (patch.displayName) {
    userSets.push(`display_name = $${uidx++}`); userValues.push(patch.displayName);
  }

  if (sets.length === 0 && userSets.length === 0) {
    throw new BadRequest('Nothing to update');
  }

  // SECURITY (2026-09-05, review #4 — cross-tenant write on `users`): when
  // the patch only touched `users` columns (phone / display name) the
  // tenant-scoped business_users UPDATE below was skipped entirely and the
  // `UPDATE users … WHERE id = $userId` ran with NO membership check — any
  // owner could null out or hijack the login phone of ANY user whose UUID
  // they knew, including another tenant's owner (users.phone is the identity
  // for /auth/staff-resolve). Verify membership FIRST — the target must be a
  // non-owner member of THIS business — before either statement runs.
  const member = await query(
    `SELECT 1 FROM business_users
      WHERE business_id = $1 AND user_id = $2 AND role <> 'business_owner'
      LIMIT 1`,
    [businessId, userId],
  );
  if (member.rowCount === 0) {
    throw new NotFound('Staff member not found (owner cannot be edited here)');
  }

  if (sets.length > 0) {
    const r = await query(
      `UPDATE business_users SET ${sets.join(', ')}
        WHERE business_id = $${idx++} AND user_id = $${idx++}
          AND role <> 'business_owner'
        RETURNING *`,
      [...values, businessId, userId],
    );
    if (r.rowCount === 0) {
      throw new NotFound('Staff member not found (owner cannot be edited here)');
    }
    // role / is_active / permissions may all have moved in this statement —
    // this is the "owner unticked a permission" path.
    _invalidateMembership(businessId, userId);
  }

  if (userSets.length > 0) {
    try {
      // Belt and braces: the membership is re-asserted INSIDE the statement,
      // so the write cannot outrun a concurrent removal from the business.
      await query(
        `UPDATE users SET ${userSets.join(', ')}
          WHERE id = $${uidx++}
            AND EXISTS (SELECT 1 FROM business_users bu
                         WHERE bu.business_id = $${uidx++} AND bu.user_id = users.id
                           AND bu.role <> 'business_owner')`,
        [...userValues, userId, businessId],
      );
    } catch (err) {
      if (err.code === '23505') {
        throw new Conflict('Phone already in use by another staff member');
      }
      throw err;
    }
  }
  const fresh = await query(
    `SELECT bu.user_id, bu.business_id, bu.role, bu.display_name, bu.pin_hash,
            bu.is_active, bu.joined_at, bu.permissions, u.email, u.phone
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
      WHERE bu.user_id = $1 AND bu.business_id = $2 LIMIT 1`,
    [userId, businessId],
  );
  return serializeStaffPin(fresh.rows[0]);
}

/// Picker — returns active non-owner staff for a business, with just
/// enough fields to render the PIN login screen. NO auth required (the
/// caller hasn't logged in yet) but we deliberately exclude phone and
/// any sensitive fields. Owner is excluded because the owner signs in
/// with email/password, not a PIN.
async function listForPicker(businessId) {
  const r = await query(
    `SELECT bu.user_id, bu.role, bu.display_name
       FROM business_users bu
      WHERE bu.business_id = $1
        AND bu.is_active = TRUE
        AND bu.role <> 'business_owner'
        AND bu.pin_hash IS NOT NULL
      ORDER BY bu.display_name`,
    [businessId],
  );
  return r.rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    displayName: row.display_name,
  }));
}

/// Resolve every active restaurant a staffer belongs to, by phone number.
/// Powers the mobile "Sign in as staff" flow so the owner never has to log in
/// first on the staffer's phone: enter phone -> pick outlet (if >1) -> PIN.
/// Returns only ACTIVE, non-owner memberships that have a PIN set. A phone at
/// two restaurants yields two rows (each independent). Owners keep using
/// email/Google, so they are intentionally excluded here.
async function resolveStaffByPhone(phone) {
  if (!phone) return [];
  const r = await query(
    `SELECT bu.user_id, bu.business_id, bu.role, bu.display_name,
            b.name AS business_name
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
       LEFT JOIN businesses b ON b.id = bu.business_id
      WHERE u.phone = $1
        AND bu.is_active = TRUE
        AND bu.role <> 'business_owner'
        AND bu.pin_hash IS NOT NULL
      ORDER BY b.name`,
    [phone],
  );
  return r.rows.map((row) => ({
    userId: row.user_id,
    businessId: row.business_id,
    role: row.role,
    displayName: row.display_name,
    businessName: row.business_name,
  }));
}

// PIN brute-force lockout. S4 fix (2026-08-23): the counter used to live in an
// in-memory Map, so it reset on every restart/deploy and was per-process —
// under PM2 cluster mode the effective cap multiplied by the worker count.
// It now lives on business_users (pin_fail_count / pin_first_fail_at /
// pin_locked_until), so it is shared across workers and survives restarts.
const MAX_PIN_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 min sliding window
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout after cap

/// Verify a 4-digit PIN for a specific (businessId, userId). Returns the
/// staff row + user for session issuance. Throws on bad creds or owner
/// (owner uses email/password, not PIN). Lockout state is persisted.
async function verifyPin(businessId, userId, pin) {
  const { Unauthorized } = require('../utils/errors');
  const r = await query(
    `SELECT bu.user_id, bu.business_id, bu.role, bu.display_name, bu.pin_hash,
            bu.is_active, bu.permissions,
            bu.pin_fail_count, bu.pin_first_fail_at, bu.pin_locked_until,
            u.email, u.phone, u.display_name AS user_name
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
      WHERE bu.business_id = $1 AND bu.user_id = $2 AND bu.is_active = TRUE
      LIMIT 1`,
    [businessId, userId],
  );
  if (r.rowCount === 0) {
    // No row to record against; still fail closed.
    throw new NotFound('Staff member not found');
  }
  const row = r.rows[0];

  // Read-only lock check first.
  const now = Date.now();
  const lockedUntil = row.pin_locked_until ? new Date(row.pin_locked_until).getTime() : 0;
  if (lockedUntil > now) {
    const mins = Math.ceil((lockedUntil - now) / 60000);
    throw new Unauthorized(
      `Too many wrong PINs. Try again in ${mins} min or ask the owner to reset.`,
    );
  }
  if (!row.pin_hash) {
    throw new BadRequest('No PIN set — use email/password to sign in');
  }

  const ok = await bcrypt.compare(pin, row.pin_hash);

  if (ok) {
    // Success — clear any accumulated failure state.
    await query(
      `UPDATE business_users
          SET pin_fail_count = 0, pin_first_fail_at = NULL, pin_locked_until = NULL
        WHERE business_id = $1 AND user_id = $2`,
      [businessId, userId],
    );
    return row;
  }

  // Failure — increment the persistent counter (with sliding-window reset)
  // and lock when the cap is hit. Done in one atomic SQL statement so
  // concurrent workers can't race past the cap.
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
    [businessId, userId, String(PIN_WINDOW_MS), MAX_PIN_ATTEMPTS, String(PIN_LOCKOUT_MS)],
  );
  const st = upd.rows[0] || {};
  if (st.pin_locked_until) {
    throw new Unauthorized('Too many wrong PINs. Locked for 15 min or ask the owner to reset.');
  }
  const remaining = MAX_PIN_ATTEMPTS - (st.pin_fail_count || 0);
  if (remaining <= 2) {
    throw new BadRequest(
      `Invalid PIN — ${remaining} ${remaining === 1 ? 'try' : 'tries'} left before lockout.`,
    );
  }
  throw new BadRequest('Invalid PIN');
}

/**
 * Push 14e — "Comply now" auto-prune. Deactivates excess non-owner active
 * staff so the active count matches the plan's staff cap. Keeps the
 * EARLIEST joined (ORDER BY joined_at ASC) — the ones most likely to be
 * the actual long-term hires — and deactivates the newest.
 *
 * Idempotent: a business already at-or-under cap gets back 0 with no
 * changes. Owner is never touched.
 *
 * Returns: { cap, keptCount, deactivatedUserIds, deactivated }.
 */
async function complyStaffLimit(businessId) {
  // Look up the cap from the active subscription's plan.limits.staff.
  // -1 / undefined => unlimited, no-op.
  const subSvc = require('./subscriptionService');
  const sub = await subSvc.get(businessId);
  const cap = sub?.plan?.limits?.staff;
  if (cap === undefined || cap === null || cap < 0) {
    return { cap: cap ?? -1, keptCount: null, deactivatedUserIds: [], deactivated: 0 };
  }

  // Pull active non-owner staff, oldest first. The N earliest stay; the
  // rest get deactivated.
  const r = await query(
    `SELECT user_id
       FROM business_users
      WHERE business_id = $1
        AND is_active = TRUE
        AND role <> 'business_owner'
      ORDER BY joined_at ASC NULLS LAST, user_id ASC`,
    [businessId],
  );
  const all = r.rows.map((row) => row.user_id);
  if (all.length <= cap) {
    return { cap, keptCount: all.length, deactivatedUserIds: [], deactivated: 0 };
  }
  const toDeactivate = all.slice(cap);
  await query(
    `UPDATE business_users SET is_active = FALSE
      WHERE business_id = $1 AND user_id = ANY($2::uuid[])`,
    [businessId, toDeactivate],
  );
  for (const uid of toDeactivate) _invalidateMembership(businessId, uid);
  return {
    cap,
    keptCount: cap,
    deactivatedUserIds: toDeactivate,
    deactivated: toDeactivate.length,
  };
}

module.exports = {
  // Existing email-invite flow
  listStaff,
  listInvitations,
  invite,
  revokeInvite,
  acceptInvite,
  updateRole,
  removeStaff,
  // Push 14a — direct PIN flow
  STAFF_ROLES,
  TIER_STAFF_CAPS,
  listStaffWithPin,
  createStaffWithPin,
  updateStaffWithPin,
  verifyPin,
  // Push 14b — public picker (no auth)
  listForPicker,
  // 2026-08-26 — phone-first staff login (no owner pre-login on device)
  resolveStaffByPhone,
  // Push 14c — permissions
  PERMISSION_KEYS,
  DEFAULT_PERMS_BY_ROLE,
  // Push 14e — auto-comply with plan limit
  complyStaffLimit,
};
