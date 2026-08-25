// NamastePOS backend - auth routes (mobile + dashboard)

const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const env = require('../config/env');

const router = express.Router();

// In production, throttle to 30 owner logins/min/IP. In dev + test we
// make this a no-op so E2E tests don't trip on legitimate retries.
const loginLimiter = env.isProd()
  ? rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
  : (_req, _res, next) => next();

// S4 (security 2026-08-23): PIN login + the (necessarily unauthenticated)
// staff picker get a tighter dedicated IP limiter — the shared 30/min owner
// limiter was too loose for a 4-digit PIN surface. Per-account lockout is
// enforced separately in staffService.verifyPin (persistent).
const pinLimiter = env.isProd()
  ? rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
  : (_req, _res, next) => next();

// NOTE: /request-otp and /verify-otp are placeholders for a future
// phone-based owner sign-in flow. The OTP infrastructure is already in
// place (services/otpService.js), what's missing is the users.phone
// schema migration + the authController.otpLogin session-mint helper.
// Held for a follow-up sprint — phone sign-in isn't on the launch path.
router.post ('/google',          loginLimiter, ...c.googleLogin);
router.post ('/dev-login',       loginLimiter, ...c.devLogin);  // gated by FF_DEV_LOGIN=1
router.post ('/register',        loginLimiter, ...c.register);
router.post ('/login',           loginLimiter, ...c.passwordLogin);
router.post ('/pin-login',       pinLimiter, ...c.pinLogin);   // Push 14a
router.post ('/staff-picker',    pinLimiter, ...c.staffPicker); // Push 14b
router.post ('/staff-resolve',   pinLimiter, ...c.staffResolve); // phone-first staff login
router.post ('/refresh',         loginLimiter, ...c.refresh);
router.post ('/logout',          requireAuth,  c.logout);
router.get  ('/me',              requireAuth,  c.me);
router.post ('/change-password', requireAuth,  ...c.changePassword); // founder bug #1
router.patch('/me',              requireAuth,  ...c.patchMe);
router.post ('/switch-business', requireAuth,  ...c.switchBusiness);

module.exports = router;
