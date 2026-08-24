#!/usr/bin/env node
// Rotate the super-admin password to the current SUPER_ADMIN_PASSWORD env
// value, in BOTH admin tables (legacy super_admins + RBAC admin_users).
//
// Bootstrap only inserts on first login when no row exists — it never
// updates an existing hash, so rotating .env alone does nothing for an
// already-bootstrapped admin. Run this after changing the env value:
//
//   node scripts/rotate-super-admin.js
//
// Added 2026-08-24 (hardcode audit): the previous password had leaked
// into a committed test fixture and had to be rotated.

const env = require('../src/config/env');
const bcrypt = require('../src/utils/bcrypt');
const { pool, query } = require('../src/config/db');

async function main() {
  const email = env.SUPER_ADMIN_EMAIL;
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const a = await query(
    `UPDATE super_admins SET password_hash = $1 WHERE email = $2`, [hash, email]);
  const b = await query(
    `UPDATE admin_users SET password_hash = $1 WHERE email = $2`, [hash, email]);
  console.log(`super_admins updated: ${a.rowCount}, admin_users updated: ${b.rowCount}`);
  if (a.rowCount === 0 && b.rowCount === 0) {
    console.log('No existing rows — bootstrap will create the admin with the new password on next login.');
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
