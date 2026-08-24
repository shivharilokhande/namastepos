// NamastePOS backend — Phone OTP service (MSG91-first).
//
// Two callers today:
//   1. Owner sign-in by phone number (Flutter app, dashboard).
//   2. Aggregator merchant linking — we mint an OTP tied to a linking
//      session so the owner can prove they own a phone number that
//      matches the Zomato/Swiggy merchant record.
//
// Design decisions:
//   • Provider: MSG91 (India, DLT-compliant, ₹0.13/SMS). Fallback to
//     dev-mode logging when MSG91_AUTHKEY is unset so local dev
//     doesn't need SMS credit.
//   • Storage: `otp_requests` table (see migration below). Row per
//     phone+purpose, code stored bcrypt-hashed, TTL 10 min, max 5
//     attempts, rate-limit 3 sends / hour / phone.
//   • Return shape: { requestId, expiresIn } on send. Verify takes
//     { requestId, code } and returns { verified: true, phone }.
//
// Alternatives evaluated:
//   • Firebase Phone Auth — free up to 10k verifications/month/project
//     but reCAPTCHA on Android is a UX tax + adds ~150 KB to the APK.
//   • Twilio Verify — $0.05/verify (~₹4) — 30× MSG91.
//   • Fast2SMS — cheaper (₹0.10) but no DLT-safe OTP-only API endpoint.
//   • 2Factor.in — ₹0.10-0.20/SMS, similar to MSG91.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { BadRequest, TooManyRequests, NotFound } = require('../utils/errors');

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_PER_HOUR = 3;

function _normalizePhone(raw) {
  if (!raw) throw new BadRequest('phone required');
  // Strip everything except digits + leading +.
  let p = String(raw).trim().replace(/[^\d+]/g, '');
  if (!p.startsWith('+')) {
    // Assume Indian if 10 digits.
    if (p.length === 10) p = `+91${p}`;
    else if (p.length === 12 && p.startsWith('91')) p = `+${p}`;
    else throw new BadRequest('Enter a valid phone number');
  }
  if (!/^\+\d{10,15}$/.test(p)) throw new BadRequest('Enter a valid phone number');
  return p;
}

function _generate6() {
  // 6-digit numeric, no leading-zero pad so 000123 doesn't happen.
  return String(100000 + crypto.randomInt(0, 900000));
}

async function _sendViaMsg91(phone, code, purpose) {
  const { MSG91_AUTHKEY, MSG91_SENDER, MSG91_OTP_TEMPLATE_ID, OTP_DEV_MODE } = env;
  if (!MSG91_AUTHKEY || OTP_DEV_MODE) {
    // P0 fix (2026-08-24): the dev-log fallback must NEVER run in
    // production — it wrote the plaintext OTP to the app log and
    // returned 200, letting anyone with log access sign in as any
    // phone number. Same hard gate as /auth/dev-login.
    if (env.isProd()) {
      logger.error('[otp] MSG91_AUTHKEY missing (or OTP_DEV_MODE set) in production — refusing to issue OTP');
      throw new Error('OTP delivery is not configured');
    }
    logger.warn(`[otp DEV] purpose=${purpose} phone=${phone} code=${code}`);
    return { provider: 'dev-log', ok: true };
  }
  // MSG91 template flow (DLT-approved template). See
  // https://docs.msg91.com/otp-templates for template registration.
  const body = JSON.stringify({
    template_id: MSG91_OTP_TEMPLATE_ID,
    mobile: phone.replace(/^\+/, ''), // MSG91 expects country-code prefixed digits, no `+`
    OTP: code,
    sender: MSG91_SENDER,
  });
  const r = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: MSG91_AUTHKEY,
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.type === 'error') {
    logger.warn(`[otp msg91] ${r.status} ${JSON.stringify(j)}`);
    throw new Error(j.message || 'SMS send failed');
  }
  return { provider: 'msg91', ok: true, requestId: j.request_id };
}

async function requestOtp({ phone, purpose = 'signin', meta = {} }) {
  const p = _normalizePhone(phone);
  // Rate-limit: at most N sends / hour / phone.
  const recent = await query(
    `SELECT COUNT(*)::int AS c FROM otp_requests
      WHERE phone = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [p]
  );
  if (recent.rows[0].c >= OTP_RATE_LIMIT_PER_HOUR) {
    throw new TooManyRequests('Too many OTP requests. Try again in an hour.');
  }
  const code = _generate6();
  const codeHash = await bcrypt.hash(code, 10);
  const ins = await query(
    `INSERT INTO otp_requests
       (phone, purpose, code_hash, expires_at, meta)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, $5::jsonb)
     RETURNING id, expires_at`,
    [p, purpose, codeHash, String(OTP_TTL_MIN), JSON.stringify(meta || {})]
  );
  try {
    await _sendViaMsg91(p, code, purpose);
  } catch (e) {
    // Roll back the row so the user isn't rate-limited by a failed send.
    await query('DELETE FROM otp_requests WHERE id = $1', [ins.rows[0].id]);
    throw new BadRequest(e.message || 'Could not send OTP right now');
  }
  return {
    requestId: ins.rows[0].id,
    expiresIn: OTP_TTL_MIN * 60,
    phone: p,
  };
}

async function verifyOtp({ requestId, code }) {
  if (!requestId || !code) throw new BadRequest('requestId and code required');
  const r = await query(
    `SELECT * FROM otp_requests WHERE id = $1 LIMIT 1`, [requestId]
  );
  if (r.rowCount === 0) throw new NotFound('OTP request not found');
  const row = r.rows[0];
  if (row.verified_at) throw new BadRequest('OTP already used');
  if (new Date(row.expires_at) < new Date()) throw new BadRequest('OTP expired — request a new one');
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    throw new TooManyRequests('Too many wrong attempts. Request a new OTP.');
  }
  const ok = await bcrypt.compare(String(code).trim(), row.code_hash);
  if (!ok) {
    await query(
      'UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1',
      [requestId]
    );
    const remaining = OTP_MAX_ATTEMPTS - (row.attempts + 1);
    throw new BadRequest(
      remaining > 0 ? `Wrong OTP — ${remaining} tries left` : 'Wrong OTP — request a new one'
    );
  }
  await query(
    'UPDATE otp_requests SET verified_at = NOW() WHERE id = $1',
    [requestId]
  );
  return { verified: true, phone: row.phone, purpose: row.purpose, meta: row.meta };
}

module.exports = { requestOtp, verifyOtp, _normalizePhone };
