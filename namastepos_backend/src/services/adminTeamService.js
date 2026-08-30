// NamastePOS backend - admin team management (multi-admin)

const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const env = require('../config/env');
const {
  issueAccessToken, generateRefreshToken, hashRefreshToken,
} = require('../utils/jwt');
const { Unauthorized, NotFound, Conflict, BadRequest, Forbidden } = require('../utils/errors');

const SALT = 10;

function serialize(a) {
  return {
    id: a.id, email: a.email, displayName: a.display_name,
    role: a.role, isActive: a.is_active,
    lastLoginAt: a.last_login_at, createdAt: a.created_at,
  };
}

// Bootstrap a super_admin from env vars if no admins exist
async function ensureBootstrap() {
  const r = await query(`SELECT COUNT(*)::int AS c FROM admin_users WHERE is_active = TRUE`);
  if (r.rows[0].c > 0) return;
  if (!env.SUPER_ADMIN_PASSWORD || !env.SUPER_ADMIN_EMAIL) return;
  const hash = await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, SALT);
  await query(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, 'Founding Admin', 'super_admin') ON CONFLICT DO NOTHING`,
    [env.SUPER_ADMIN_EMAIL, hash]
  );
}

async function login(email, password) {
  await ensureBootstrap();
  const r = await query(
    `SELECT * FROM admin_users WHERE email = $1 AND is_active = TRUE LIMIT 1`,
    [email]
  );
  if (r.rowCount === 0) throw new Unauthorized('Invalid credentials');
  const admin = r.rows[0];
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) throw new Unauthorized('Invalid credentials');

  // QA-8 P1 (Lakshmi #7): if the admin has 2FA enrolled, issue a challenge
  // instead of an access token. Client must POST /auth/2fa/verify with the
  // challenge_id + 6-digit TOTP code to get the actual token.
  if (admin.totp_enrolled_at) {
    const twoFactor = require('./twoFactorService');
    const { challengeId } = await twoFactor.startChallenge(admin.id);
    return { requires2fa: true, challengeId };
  }

  // Org-wide 2FA enforcement (2026-08-28): when the platform requires 2FA for
  // all admins but this admin hasn't enrolled yet, we can't lock them out (they
  // need to be signed in to enrol). Instead we mint an ENROL-ONLY token — the
  // `enrol2fa` claim makes the admin routes reject every action except viewing
  // self + completing enrolment (see admin.routes gate). Once they confirm a
  // TOTP code, the confirm endpoint swaps it for a full token.
  const enforce = await require('./settingsService').get('security.enforce_admin_2fa');
  if (enforce) {
    await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [admin.id]);
    const token = issueAccessToken({
      sub: admin.id, sid: admin.id, isSuperAdmin: true,
      email: admin.email, role: admin.role, enrol2fa: true,
    });
    return { token, admin: serialize(admin), mustEnrol2fa: true };
  }

  await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [admin.id]);
  const token = issueAccessToken({
    sub: admin.id, sid: admin.id, isSuperAdmin: true,
    email: admin.email, role: admin.role,
  });
  return { token, admin: serialize(admin) };
}

// QA-8 P1: complete a 2FA-gated login
async function complete2faLogin(challengeId, code) {
  const twoFactor = require('./twoFactorService');
  const { adminId } = await twoFactor.verifyChallenge(challengeId, code);
  const r = await query(
    `SELECT * FROM admin_users WHERE id = $1 AND is_active = TRUE`, [adminId]
  );
  if (r.rowCount === 0) throw new Unauthorized('Admin not found');
  const admin = r.rows[0];
  await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [admin.id]);
  const token = issueAccessToken({
    sub: admin.id, sid: admin.id, isSuperAdmin: true,
    email: admin.email, role: admin.role,
  });
  return { token, admin: serialize(admin) };
}

async function list() {
  const r = await query(`SELECT * FROM admin_users ORDER BY created_at ASC`);
  return r.rows.map(serialize);
}

async function create({ email, password, displayName, role = 'support', invitedBy }) {
  if (!email || !password) throw new BadRequest('email and password required');
  // Hardening (2026-08-30): platform admins hold full control of every tenant,
  // so require a stronger password than the 6-char minimum (business owners
  // already use 8). Enforced on create/reset only — login is unaffected, so no
  // existing admin is locked out.
  if (password.length < 12) throw new BadRequest('Admin password must be at least 12 characters');
  const hash = await bcrypt.hash(password, SALT);
  try {
    const r = await query(
      `INSERT INTO admin_users (email, password_hash, display_name, role, invited_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, hash, displayName, role, invitedBy]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Email already in use');
    throw err;
  }
}

function isFounder(row) {
  return !!env.FOUNDER_ADMIN_EMAIL
    && (row.email || '').toLowerCase() === env.FOUNDER_ADMIN_EMAIL;
}

async function update(id, patch, actorId = null) {
  // Founder protection (2026-08-24): the founder account (FOUNDER_ADMIN_EMAIL,
  // defaults to SUPER_ADMIN_EMAIL) is the recovery root of the platform.
  //   - Nobody can deactivate the founder — not even the founder himself.
  //   - Nobody can demote the founder from super_admin.
  //   - Only the founder can change the founder's password.
  // Additionally, no admin may deactivate their OWN account (lockout guard);
  // the founder can still deactivate any other admin, including other
  // super_admins.
  const targetQ = await query(`SELECT * FROM admin_users WHERE id = $1`, [id]);
  if (targetQ.rowCount === 0) throw new NotFound('Admin not found');
  const target = targetQ.rows[0];

  if (isFounder(target)) {
    if (patch.is_active === false) {
      throw new Forbidden('The founder account cannot be deactivated');
    }
    if (patch.role !== undefined && patch.role !== 'super_admin') {
      throw new Forbidden('The founder account cannot be demoted');
    }
    if (patch.password && actorId !== null && String(actorId) !== String(target.id)) {
      throw new Forbidden("Only the founder can change the founder's password");
    }
  }
  if (patch.is_active === false && actorId !== null && String(actorId) === String(id)) {
    throw new Forbidden('You cannot deactivate your own account');
  }

  const fields = ['display_name', 'role', 'is_active'];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  if (patch.password) {
    const hash = await bcrypt.hash(patch.password, SALT);
    sets.push(`password_hash = $${idx++}`); values.push(hash);
  }
  if (sets.length === 0) {
    const r = await query(`SELECT * FROM admin_users WHERE id = $1`, [id]);
    return serialize(r.rows[0]);
  }
  values.push(id);
  const r = await query(
    `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Admin not found');
  return serialize(r.rows[0]);
}

async function deactivate(id, actorId = null) {
  return update(id, { is_active: false }, actorId);
}

async function me(id) {
  const r = await query(`SELECT * FROM admin_users WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new NotFound('Admin not found');
  return serialize(r.rows[0]);
}

module.exports = {
  ensureBootstrap, login, complete2faLogin, list, create, update, deactivate, me, serialize,
};
