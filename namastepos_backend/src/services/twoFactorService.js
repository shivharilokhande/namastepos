// NamastePOS backend — TOTP 2FA for super admins (QA-8 P1 Lakshmi #7)
//
// Flow:
//   1) Admin requests enrolment → server generates a TOTP secret + 10
//      recovery codes, stores the encrypted secret + bcrypt-hashed codes,
//      returns the otpauth:// URI + recovery codes ONCE.
//   2) Admin confirms enrolment by submitting a current 6-digit code →
//      we verify → mark `totp_enrolled_at = NOW()`.
//   3) On subsequent login: after password check, if 2FA is enrolled we
//      issue a one-time challenge_id (15-min TTL) instead of an access
//      token. Client POSTs challenge_id + code → we verify → issue token.
//
// Crypto:
//   - Secret stored AES-256-GCM encrypted with JWT_SECRET as KEK (good
//     enough for SaaS; a dedicated KMS would be the prod-hardening step).
//   - TOTP RFC 6238 with 30-s step, ±1 window.

const crypto = require('crypto');
const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const env = require('../config/env');
const { BadRequest, Unauthorized, NotFound } = require('../utils/errors');

const STEP_S = 30;
const DIGITS = 6;

// ── Crypto helpers ────────────────────────────────────────────────────────
function _kek() {
  return crypto.createHash('sha256').update(env.JWT_SECRET).digest();
}
function _encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _kek(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function _decrypt(enc) {
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ct = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _kek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function _base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += alphabet[parseInt(bits.substr(i, 5), 2)];
  }
  return out;
}
function _base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of cleaned) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

function _totp(secret, t = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(t / STEP_S);
  const cbuf = Buffer.alloc(8);
  cbuf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(cbuf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code = (
    ((mac[off] & 0x7f) << 24) |
    ((mac[off + 1] & 0xff) << 16) |
    ((mac[off + 2] & 0xff) << 8)  |
    (mac[off + 3] & 0xff)
  ) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

function _verifyTotp(secret, code) {
  const now = Math.floor(Date.now() / 1000);
  // ±1 window for clock drift
  for (const offset of [-STEP_S, 0, STEP_S]) {
    if (_totp(secret, now + offset) === code) return true;
  }
  return false;
}

// ── Enrolment ─────────────────────────────────────────────────────────────
async function startEnrolment(adminId, adminEmail) {
  const secret = crypto.randomBytes(20);
  const b32 = _base32Encode(secret);
  const enc = _encrypt(b32);

  // Generate 10 recovery codes (each 10 chars, base32-ish)
  const recoveryCodes = [];
  const recoveryHashes = [];
  for (let i = 0; i < 10; i += 1) {
    const code = _base32Encode(crypto.randomBytes(7)).slice(0, 10);
    recoveryCodes.push(code);
    recoveryHashes.push(await bcrypt.hash(code, 10));
  }

  // Save provisional — flips to enrolled when the user confirms a TOTP code
  await query(
    `UPDATE admin_users
        SET totp_secret_enc = $1,
            recovery_codes  = $2,
            totp_enrolled_at = NULL
      WHERE id = $3`,
    [enc, recoveryHashes, adminId]
  );

  const issuer = encodeURIComponent('NamastePOS');
  const label  = encodeURIComponent(adminEmail);
  const otpauth = `otpauth://totp/${issuer}:${label}?secret=${b32}&issuer=${issuer}&digits=${DIGITS}&period=${STEP_S}`;
  return { otpauth, secret: b32, recoveryCodes };
}

async function confirmEnrolment(adminId, code) {
  const r = await query(
    `SELECT totp_secret_enc FROM admin_users WHERE id = $1`, [adminId]
  );
  if (r.rowCount === 0 || !r.rows[0].totp_secret_enc) {
    throw new BadRequest('No enrolment in progress — request enrolment first');
  }
  const secret = _base32Decode(_decrypt(r.rows[0].totp_secret_enc));
  if (!_verifyTotp(secret, code)) throw new Unauthorized('Invalid TOTP code');

  await query(
    `UPDATE admin_users SET totp_enrolled_at = NOW() WHERE id = $1`,
    [adminId]
  );
  return { enrolled: true };
}

// ── Login challenge ───────────────────────────────────────────────────────
async function isEnrolled(adminId) {
  const r = await query(
    `SELECT totp_enrolled_at FROM admin_users WHERE id = $1`, [adminId]
  );
  return r.rowCount > 0 && r.rows[0].totp_enrolled_at !== null;
}

async function startChallenge(adminId) {
  const r = await query(
    `INSERT INTO admin_2fa_pending (admin_id, expires_at)
     VALUES ($1, NOW() + INTERVAL '15 minutes') RETURNING challenge_id`,
    [adminId]
  );
  return { challengeId: r.rows[0].challenge_id };
}

async function verifyChallenge(challengeId, code) {
  const ch = await query(
    `SELECT p.admin_id, a.totp_secret_enc, a.recovery_codes
       FROM admin_2fa_pending p
       JOIN admin_users a ON a.id = p.admin_id
      WHERE p.challenge_id = $1 AND p.expires_at > NOW()`,
    [challengeId]
  );
  if (ch.rowCount === 0) throw new Unauthorized('Challenge expired or invalid');
  const row = ch.rows[0];

  // Try TOTP first
  const secret = _base32Decode(_decrypt(row.totp_secret_enc));
  let ok = _verifyTotp(secret, code);

  // Then try recovery codes (one-time use)
  if (!ok && Array.isArray(row.recovery_codes)) {
    for (let i = 0; i < row.recovery_codes.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(code, row.recovery_codes[i])) {
        ok = true;
        const remaining = row.recovery_codes.slice();
        remaining.splice(i, 1);
        await query(
          `UPDATE admin_users SET recovery_codes = $1 WHERE id = $2`,
          [remaining, row.admin_id]
        );
        break;
      }
    }
  }
  if (!ok) throw new Unauthorized('Invalid TOTP code');

  // Burn the challenge
  await query(`DELETE FROM admin_2fa_pending WHERE challenge_id = $1`, [challengeId]);
  return { adminId: row.admin_id };
}

async function disable(adminId) {
  await query(
    `UPDATE admin_users
        SET totp_secret_enc = NULL, totp_enrolled_at = NULL, recovery_codes = NULL
      WHERE id = $1`,
    [adminId]
  );
}

module.exports = {
  startEnrolment, confirmEnrolment,
  isEnrolled, startChallenge, verifyChallenge,
  disable,
};
