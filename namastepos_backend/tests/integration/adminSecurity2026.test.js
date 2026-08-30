// Coverage for the 2026-08-28 admin security/compliance features:
//   - CSRF: ff_admin cookie is NOT treated as a CSRF session cookie
//     (SameSite=Strict is the control); ff_refresh still is.
//   - Org-wide 2FA enforcement: login mints an enrol-only token + mustEnrol2fa
//     when the platform setting is on and the admin hasn't enrolled.
//   - Retention: safe defaults (0 = disabled), preview + sweep are no-ops when
//     disabled and never delete anything.

const { resetDb, closePool } = require('../setup');
const csrf = require('../../src/middleware/csrf');
const { verifyAccessToken } = require('../../src/utils/jwt');
const settings = require('../../src/services/settingsService');
const adminTeam = require('../../src/services/adminTeamService');
const retention = require('../../src/services/retentionService');

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closePool(); });

// Tiny helper to run an Express-style middleware and capture the next() arg.
function runMw(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err || null));
  });
}

describe('CSRF: ff_admin cookie exemption', () => {
  test('cookie-mode admin mutation (ff_admin, no bearer, no token) is NOT blocked for CSRF', async () => {
    const req = { method: 'POST', headers: {}, cookies: { ff_admin: 'jwt-here' } };
    const err = await runMw(csrf.verify, req);
    expect(err).toBeNull(); // SameSite=Strict handles CSRF; no double-submit required
  });

  test('ff_refresh cookie session still requires a CSRF token', async () => {
    const req = { method: 'POST', headers: {}, cookies: { ff_refresh: 'rt' } };
    const err = await runMw(csrf.verify, req);
    expect(err).toBeTruthy();
    expect(err.status || err.statusCode).toBe(403);
  });

  test('Bearer requests are always exempt', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer x' }, cookies: { ff_admin: 'jwt' } };
    const err = await runMw(csrf.verify, req);
    expect(err).toBeNull();
  });

  test('safe methods are exempt', async () => {
    const req = { method: 'GET', headers: {}, cookies: { ff_admin: 'jwt' } };
    const err = await runMw(csrf.verify, req);
    expect(err).toBeNull();
  });
});

describe('Org-wide 2FA enforcement at login', () => {
  const email = 'enforce-2fa@namastepos.in';
  const password = 'secret123-strong'; // ≥12 chars (admin password minimum)

  beforeAll(async () => {
    await adminTeam.create({ email, password, displayName: 'Enforce Test', role: 'support' });
  });

  test('enforcement OFF → normal full token, no mustEnrol2fa', async () => {
    await settings.set('security.enforce_admin_2fa', false);
    const r = await adminTeam.login(email, password);
    expect(r.token).toBeTruthy();
    expect(r.mustEnrol2fa).toBeFalsy();
    const decoded = verifyAccessToken(r.token);
    expect(decoded.isSuperAdmin).toBe(true);
    expect(decoded.enrol2fa).toBeFalsy();
  });

  test('enforcement ON + not enrolled → enrol-only token + mustEnrol2fa', async () => {
    await settings.set('security.enforce_admin_2fa', true);
    const r = await adminTeam.login(email, password);
    expect(r.mustEnrol2fa).toBe(true);
    expect(r.token).toBeTruthy();
    const decoded = verifyAccessToken(r.token);
    expect(decoded.isSuperAdmin).toBe(true);
    expect(decoded.enrol2fa).toBe(true);
    await settings.set('security.enforce_admin_2fa', false); // reset
  });
});

describe('Retention safety defaults', () => {
  test('getConfig defaults every window to 0 (disabled)', async () => {
    const cfg = await retention.getConfig();
    expect(cfg.deletedBusinessDays).toBe(0);
    expect(cfg.auditLogDays).toBe(0);
    expect(cfg.cookieConsentDays).toBe(0);
  });

  test('preview is a no-op (all zero) when disabled', async () => {
    const p = await retention.preview();
    expect(p.businessesEligible).toBe(0);
    expect(p.auditRowsEligible).toBe(0);
    expect(p.consentRowsEligible).toBe(0);
  });

  test('sweep deletes nothing when disabled', async () => {
    const r = await retention.sweep();
    expect(r.businessesPurged).toBe(0);
    expect(r.auditRowsPruned).toBe(0);
    expect(r.consentRowsPruned).toBe(0);
  });

  test('saveConfig clamps negatives to 0', async () => {
    const cfg = await retention.saveConfig({ auditLogDays: -5, cookieConsentDays: 30 });
    expect(cfg.auditLogDays).toBe(0);
    expect(cfg.cookieConsentDays).toBe(30);
    await retention.saveConfig({ cookieConsentDays: 0 }); // reset
  });
});
