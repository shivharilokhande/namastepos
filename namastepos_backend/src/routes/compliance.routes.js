// NamastePOS backend - /v1/compliance/* — public DPDP endpoints.
//
// No auth required. These are reachable by anyone who needs to:
//   - Look up the published grievance officer contact
//   - File a grievance (mandatory under DPDP s.13)
//   - Record cookie-banner / guest consent
//
// Mounted at /v1/compliance in app.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/complianceController');
const { verifyAccessToken } = require('../utils/jwt');

const router = express.Router();

// NP-119 (2026-09-03): these POSTs are public AND CSRF-exempt (app.js skips
// CSRF for /compliance), so the only thing between an abuser and unbounded
// grievance/consent rows was the global 600/min limiter. Strict per-IP
// budget — 5/min is plenty for a human filing a grievance or a cookie
// banner recording consent. Same express-rate-limit pattern as
// guest.routes.js / auth.routes.js.
const publicWriteLimiter = rateLimit({
  windowMs: 60_000, max: 5,            // 5 writes/min per IP
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' },
});

// Founder bug (2026-08-25): the dashboard Privacy page files grievances while
// signed in, but this router is auth-free, so req.user was always undefined
// and the controller/service treated the owner as an anonymous complainant —
// which then demanded an email/phone the UI never collects ("Validation
// failed"). Decode the Bearer token when one is present so the grievance is
// linked to the user + business; NEVER reject, the endpoint must stay public
// for third-party privacy portals (DPDP s.13).
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const p = verifyAccessToken(header.slice('Bearer '.length).trim());
      // Skip super-admin tokens: their `sid` is not a users.id, and a
      // grievance row FK-references users — admins filing on someone's
      // behalf must supply explicit complainant contact details instead.
      if (!p.isSuperAdmin) {
        req.user = {
          id: p.uid || p.sub,
          businessId: p.bid,
          role: p.role,
          email: p.email,
        };
      }
    } catch (_) { /* invalid/expired token → treat as anonymous filer */ }
  }
  return next();
}

router.get ('/grievance-officer', c.publicGrievanceOfficer);
router.post('/grievance',         publicWriteLimiter, optionalAuth, ...c.publicFileGrievance);
router.post('/consent',           publicWriteLimiter, ...c.publicRecordConsent);
router.post('/guest-consent',     publicWriteLimiter, ...c.guestRecordConsent);

module.exports = router;
