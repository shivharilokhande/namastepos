// NamastePOS backend - JWT issue + verify helpers

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

function issueAccessToken(payload, opts = {}) {
  // Impersonation tokens get a much shorter TTL (15 min) — see QA P0-1.
  const expiresIn = opts.expiresIn
    || (payload.imp ? '15m' : env.JWT_EXPIRES_IN);
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn,
    issuer: 'namastepos',
    algorithm: 'HS256', // S8: pin explicitly
  });
}

function verifyAccessToken(token) {
  // S8 (security 2026-08-23): pin the accepted algorithm. The library already
  // defaults to HMAC when the secret is a string, but pinning HS256 explicitly
  // forecloses any future alg-confusion (e.g. if the secret ever becomes a key
  // object) and rejects alg:none outright.
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'namastepos', algorithms: ['HS256'] });
}

/**
 * Refresh tokens are opaque random strings. We store only the SHA-256 hash
 * server-side so a database leak doesn't yield usable tokens.
 */
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenExpiry(days = env.REFRESH_TOKEN_EXPIRES_IN_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
};
