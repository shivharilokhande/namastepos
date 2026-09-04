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
//   - Secret stored AES-256-GCM encrypted with a dedicated KEK derived from
//     TOTP_ENC_KEY (a real KMS would be the next hardening step).
//   - TOTP RFC 6238 with 30-s step, ±1 window.

const crypto = require('crypto');
const bcrypt = require('../utils/bcrypt');
const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { BadRequest, Unauthorized, NotFound } = require('../utils/errors');

const STEP_S = 30;
const DIGITS = 6;

// ── Crypto helpers ────────────────────────────────────────────────────────
//
// SECURITY REVIEW 2026-09-04 (item 3) — the KEK used to be
// sha256(JWT_SECRET). That coupled two unrelated key lifecycles:
//   • Rotating JWT_SECRET (routine, occasionally urgent — a leaked secret, a
//     staff departure) silently and PERMANENTLY bricked every admin's 2FA:
//     totp_secret_enc could no longer be decrypted, so `verifyChallenge`
//     threw on every admin login and there was no self-service recovery.
//     With org-wide 2FA enforcement on, that is a full lockout of the admin
//     console.
//   • One leaked value compromised both session signing and the 2FA seeds.
//
// Fix: a dedicated `TOTP_ENC_KEY`, with a VERSION-PREFIXED ciphertext so old
// and new rows coexist.
//
//   stored format          key used                       written by
//   ─────────────────────  ─────────────────────────────  ───────────────
//   "<base64>"  (legacy)   sha256(JWT_SECRET)             pre-2026-09-04
//   "v2:<base64>"          sha256(TOTP_ENC_KEY)           now
//
// Why a version prefix rather than "try both keys": a prefix says exactly
// which key a row needs, so a genuine wrong-key/corruption failure surfaces as
// a failure instead of being silently swallowed by the fallback attempt — and
// it gives ops a one-line query to confirm the migration is complete
// (`SELECT count(*) FROM admin_users WHERE totp_secret_enc NOT LIKE 'v2:%'`).
// Legacy rows are re-encrypted lazily on the next successful use of the code
// (confirmEnrolment / verifyChallenge / disable), so a working admin migrates
// themselves at their next sign-in; nothing has to be backfilled by hand.
//
// If TOTP_ENC_KEY is unset both derivations collapse to the JWT_SECRET one, so
// behaviour is byte-for-byte today's — we only warn.
const V2_PREFIX = 'v2:';

let _warned = false;
function _totpKeySource() {
  if (env.TOTP_ENC_KEY) return env.TOTP_ENC_KEY;
  if (!_warned) {
    _warned = true;
    logger.warn(
      '[2fa] TOTP_ENC_KEY is not set — falling back to deriving the admin 2FA '
      + 'encryption key from JWT_SECRET. Rotating JWT_SECRET will PERMANENTLY '
      + 'break every admin\'s 2FA. Set TOTP_ENC_KEY (openssl rand -base64 32) '
      + 'and existing secrets will re-encrypt themselves on next use.',
    );
  }
  return env.JWT_SECRET;
}

/** Current KEK — TOTP_ENC_KEY when configured, else the legacy one. */
function _kek() {
  return crypto.createHash('sha256').update(_totpKeySource()).digest();
}
/** The pre-2026-09-04 KEK, kept only to read rows written before the split. */
function _legacyKek() {
  return crypto.createHash('sha256').update(env.JWT_SECRET).digest();
}

function _encryptWith(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function _decryptWith(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Always writes the current (v2) format. */
function _encrypt(plain) {
  return V2_PREFIX + _encryptWith(_kek(), plain);
}

/**
 * Decrypt either format.
 * Returns { plain, legacy } — `legacy: true` means the row is still on the
 * JWT_SECRET-derived key and should be re-encrypted (see _maybeReEncrypt).
 */
function _decryptAny(enc) {
  if (typeof enc === 'string' && enc.startsWith(V2_PREFIX)) {
    return { plain: _decryptWith(_kek(), enc.slice(V2_PREFIX.length)), legacy: false };
  }
  return { plain: _decryptWith(_legacyKek(), enc), legacy: true };
}

/**
 * Encrypt in the PRE-split format (JWT_SECRET-derived key, no prefix).
 * Exported for tests only — it is how we seed a row that looks like it was
 * written before 2026-09-04 so the legacy read path stays covered.
 */
function _encryptLegacy(plain) {
  return _encryptWith(_legacyKek(), plain);
}

/**
 * Lazy key migration. Called only AFTER the submitted code verified, i.e. we
 * know the plaintext is the admin's live secret. Best-effort: a failed
 * re-encrypt must never fail the admin's login — they simply migrate next
 * time. Skipped entirely when TOTP_ENC_KEY is unset (nothing to migrate to).
 */
async function _maybeReEncrypt(adminId, plainB32, wasLegacy) {
  if (!wasLegacy || !env.TOTP_ENC_KEY || !adminId) return;
  try {
    await query(
      'UPDATE admin_users SET totp_secret_enc = $1 WHERE id = $2',
      [_encrypt(plainB32), adminId],
    );
    logger.info(`[2fa] re-encrypted admin ${adminId} TOTP secret under TOTP_ENC_KEY`);
  } catch (e) {
    logger.warn(`[2fa] re-encrypt failed for admin ${adminId}: ${e.message}`);
  }
}

function _base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; let
    out = '';
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
    ((mac[off] & 0x7f) << 24)
    | ((mac[off + 1] & 0xff) << 16)
    | ((mac[off + 2] & 0xff) << 8)
    | (mac[off + 3] & 0xff)
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
  // Security fix (2026-08-25): starting an enrolment used to unconditionally
  // overwrite totp_secret_enc AND null out totp_enrolled_at. For an admin who
  // was ALREADY enrolled that instantly stripped their live 2FA (login stopped
  // requiring a code) before any new secret was confirmed. Guard it: never
  // clobber an active enrolment. To rotate, the admin must first disable (which
  // now requires a valid current code) and then enrol afresh. This keeps the
  // existing enrolment fully intact until a new one is confirmed.
  const cur = await query('SELECT totp_enrolled_at FROM admin_users WHERE id = $1', [adminId]);
  if (cur.rowCount > 0 && cur.rows[0].totp_enrolled_at) {
    throw new BadRequest('2FA is already enabled — disable it first to re-enrol');
  }

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

  // Save provisional — flips to enrolled when the user confirms a TOTP code.
  // totp_enrolled_at stays NULL here (only reached when NOT already enrolled),
  // so isEnrolled() / login remain unaffected until confirmEnrolment().
  await query(
    `UPDATE admin_users
        SET totp_secret_enc = $1,
            recovery_codes  = $2,
            totp_enrolled_at = NULL
      WHERE id = $3`,
    [enc, recoveryHashes, adminId],
  );

  const issuer = encodeURIComponent('NamastePOS');
  const label = encodeURIComponent(adminEmail);
  const otpauth = `otpauth://totp/${issuer}:${label}?secret=${b32}&issuer=${issuer}&digits=${DIGITS}&period=${STEP_S}`;
  return { otpauth, secret: b32, recoveryCodes };
}

async function confirmEnrolment(adminId, code) {
  const r = await query('SELECT totp_secret_enc FROM admin_users WHERE id = $1', [adminId]);
  if (r.rowCount === 0 || !r.rows[0].totp_secret_enc) {
    throw new BadRequest('No enrolment in progress — request enrolment first');
  }
  const { plain: b32, legacy } = _decryptAny(r.rows[0].totp_secret_enc);
  const secret = _base32Decode(b32);
  if (!_verifyTotp(secret, code)) throw new Unauthorized('Invalid TOTP code');

  await query(
    'UPDATE admin_users SET totp_enrolled_at = NOW() WHERE id = $1',
    [adminId],
  );
  await _maybeReEncrypt(adminId, b32, legacy);
  return { enrolled: true };
}

// ── Login challenge ───────────────────────────────────────────────────────
async function isEnrolled(adminId) {
  const r = await query('SELECT totp_enrolled_at FROM admin_users WHERE id = $1', [adminId]);
  return r.rowCount > 0 && r.rows[0].totp_enrolled_at !== null;
}

async function startChallenge(adminId) {
  const r = await query(
    `INSERT INTO admin_2fa_pending (admin_id, expires_at)
     VALUES ($1, NOW() + INTERVAL '15 minutes') RETURNING challenge_id`,
    [adminId],
  );
  return { challengeId: r.rows[0].challenge_id };
}

// Attempt cap (2026-08-25): brute-forcing a 6-digit TOTP against a 15-min
// challenge is otherwise unbounded, so the challenge is burned after
// MAX_ATTEMPTS failures.
//
// 2026-09-04 (security review, item 1): this counter used to live in a
// process-local Map, on the stated assumption that "a single backend process
// handles admin auth". That assumption is exactly what the review was about:
//   • on >1 instance the cap became per-process, so N instances gave an
//     attacker N × 5 guesses — and Render can scale the service without
//     anybody touching this file;
//   • an instance restart mid-challenge reset the counter to zero;
//   • abandoned logins leaked an entry each, forever.
// The counter now lives on `admin_2fa_pending.attempts` (migration 086) and is
// claimed with a single guarded UPDATE — the same TOCTOU-free pattern
// otpService.verifyOtp uses — so the cap is global, survives restarts, and
// disappears with the row.
const MAX_ATTEMPTS = 5;

/**
 * Check a submitted code against an admin's live 2FA credentials.
 * Tries TOTP first, then one-time recovery codes (burning a used one).
 * Returns true on success. Shared by verifyChallenge() and disable().
 */
async function _checkCode(row, code) {
  const { plain: b32, legacy } = _decryptAny(row.totp_secret_enc);
  const secret = _base32Decode(b32);
  if (_verifyTotp(secret, code)) {
    // Verified against the live secret → safe to migrate it to the dedicated
    // key. Best-effort; never blocks the login.
    await _maybeReEncrypt(row.admin_id, b32, legacy);
    return true;
  }

  if (Array.isArray(row.recovery_codes)) {
    for (let i = 0; i < row.recovery_codes.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(code, row.recovery_codes[i])) {
        const remaining = row.recovery_codes.slice();
        remaining.splice(i, 1);
        await query(
          'UPDATE admin_users SET recovery_codes = $1 WHERE id = $2',
          [remaining, row.admin_id],
        );
        return true;
      }
    }
  }
  return false;
}

async function verifyChallenge(challengeId, code) {
  // CLAIM an attempt atomically before doing any comparison. The guarded
  // UPDATE only succeeds while the challenge is unexpired and under the cap,
  // so each in-flight guess consumes exactly one slot no matter how many
  // instances or concurrent requests are involved. (Same shape as
  // otpService.verifyOtp — see migration 086 for why this moved off a Map.)
  const claim = await query(
    `UPDATE admin_2fa_pending
        SET attempts = attempts + 1
      WHERE challenge_id = $1 AND expires_at > NOW() AND attempts < $2
      RETURNING admin_id, attempts`,
    [challengeId, MAX_ATTEMPTS],
  );
  if (claim.rowCount === 0) {
    // Unknown id, expired, or the cap is already spent. Burn whatever is left
    // so a spent challenge can't be probed further, and give one answer for
    // all three — the caller has to restart sign-in either way.
    await query('DELETE FROM admin_2fa_pending WHERE challenge_id = $1', [challengeId]);
    throw new Unauthorized('Challenge expired or invalid — restart sign-in');
  }

  const ch = await query(
    `SELECT a.id AS admin_id, a.totp_secret_enc, a.recovery_codes
       FROM admin_users a WHERE a.id = $1`,
    [claim.rows[0].admin_id],
  );
  if (ch.rowCount === 0) throw new Unauthorized('Challenge expired or invalid');
  const row = ch.rows[0];

  const ok = await _checkCode(row, code);
  if (!ok) {
    if (claim.rows[0].attempts >= MAX_ATTEMPTS) {
      // That was the last slot — burn the challenge so the client must
      // re-authenticate with the password to get a fresh one.
      await query('DELETE FROM admin_2fa_pending WHERE challenge_id = $1', [challengeId]);
      throw new Unauthorized('Too many attempts — restart sign-in');
    }
    throw new Unauthorized('Invalid TOTP code');
  }

  // Burn the challenge.
  await query('DELETE FROM admin_2fa_pending WHERE challenge_id = $1', [challengeId]);
  return { adminId: row.admin_id };
}

// Security fix (2026-08-25): disabling 2FA used to require nothing beyond the
// session — a hijacked admin session could silently strip 2FA. Now the caller
// must present a valid current TOTP (or a recovery code) to turn it off.
async function disable(adminId, code) {
  const r = await query(
    `SELECT id AS admin_id, totp_secret_enc, totp_enrolled_at, recovery_codes
       FROM admin_users WHERE id = $1`,
    [adminId],
  );
  if (r.rowCount === 0) throw new NotFound('Admin not found');
  const row = r.rows[0];
  if (!row.totp_enrolled_at) throw new BadRequest('2FA is not enabled');
  if (!code) throw new BadRequest('A current 2FA code is required to disable 2FA');
  const ok = await _checkCode(row, code);
  if (!ok) throw new Unauthorized('Invalid 2FA code');

  await query(
    `UPDATE admin_users
        SET totp_secret_enc = NULL, totp_enrolled_at = NULL, recovery_codes = NULL
      WHERE id = $1`,
    [adminId],
  );
}

module.exports = {
  startEnrolment,
  confirmEnrolment,
  isEnrolled,
  startChallenge,
  verifyChallenge,
  disable,
  // Exported for the key-split tests (security review 2026-09-04, item 3).
  _encrypt,
  _encryptLegacy,
  _decryptAny,
  _base32Encode,
  _base32Decode,
  _totp,
  V2_PREFIX,
};
