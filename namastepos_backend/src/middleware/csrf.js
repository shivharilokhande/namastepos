// NamastePOS — CSRF protection for cookie-based sessions (QA-8 P1).
//
// Double-submit cookie pattern:
//   1) On login (or first GET that issues the session cookie), the server
//      sets `ff_csrf` — a httpOnly=false cookie with a random 32-byte token.
//   2) The client reads that cookie and echoes it back on every state-
//      changing request via the `X-CSRF-Token` header.
//   3) This middleware verifies header == cookie. Mismatch → 403.
//
// We deliberately bypass CSRF for:
//   • Routes that don't use cookies for auth (the Bearer-token API path).
//     Those are safe because XHR cross-origin requests can't add a custom
//     Authorization header without the user's consent.
//   • Webhook routes (signature-verified separately).

const crypto = require('crypto');
const { Forbidden } = require('../utils/errors');

const COOKIE_NAME = 'ff_csrf';
const HEADER_NAME = 'x-csrf-token';

function generate() {
  return crypto.randomBytes(32).toString('base64url');
}

function issue(req, res) {
  const existing = req.cookies?.[COOKIE_NAME];
  if (existing) return existing;
  const token = generate();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: false,    // intentionally readable by JS — double-submit pattern
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 1000,
  });
  return token;
}

function verify(req, _res, next) {
  // Safe methods skip CSRF
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // CSRF is structurally impossible for Bearer-token requests: browsers
  // can't auto-attach an Authorization header cross-origin, so a CSRF
  // attacker can't forge an authenticated request even if the user has
  // a session cookie sitting in their jar. Exempt any request that
  // carries a Bearer header BEFORE looking at cookies — this also avoids
  // a regression where a leftover `ff_refresh` cookie from an earlier
  // refresh call made every Bearer-mode dashboard request fail.
  const hasBearer = (req.headers.authorization || '').startsWith('Bearer ');
  if (hasBearer) return next();

  // No Bearer token. If there's also no session cookie, the request is
  // a pre-login or public call — nothing to protect.
  //
  // NOTE (2026-08-28): the admin `ff_admin` cookie is deliberately NOT treated
  // as a CSRF-relevant session cookie. It is set SameSite=Strict, so the
  // browser never attaches it to any cross-site request — that alone forecloses
  // CSRF. The double-submit token can't work for admin anyway: `ff_csrf` is set
  // on the API host and the admin SPA runs on a different subdomain, so its JS
  // can't read the cookie to echo it back. Requiring it here 403'd every
  // cookie-mode admin mutation ("CSRF token missing or invalid").
  const hasSessionCookie = !!req.cookies?.ff_refresh;
  if (!hasSessionCookie) return next();

  // Cookie-only authenticated request → must include the matching CSRF token.
  const cookie = req.cookies?.[COOKIE_NAME];
  const header = req.headers[HEADER_NAME];
  if (!cookie || !header || cookie !== header) {
    return next(new Forbidden('CSRF token missing or invalid'));
  }
  return next();
}

module.exports = { issue, verify, COOKIE_NAME, HEADER_NAME };
