// NamastePOS backend — "platform staff may not read tenant PII" guard
//
// WHY THIS EXISTS (2026-09-03, founder-driven)
// -------------------------------------------
// `requireBusinessOwnership` (middleware/auth.js) deliberately lets a plain
// super-admin token through on the tenant API as READ-ONLY oversight. That was
// added to stop admins WRITING to tenants — but read-only is still read, and on
// routes that return the restaurant's end-customers (diners) it means any
// NamastePOS staff member holding an admin token can list diner names, phones,
// loyalty points and wallet balances for any tenant, outside the audited
// /v1/admin surface and with no ticket attached.
//
// The founder's rule: as the platform we may see what a tenant owes US and
// non-identifying volume/health metrics. We may NOT browse their diners.
//
// This middleware closes that door on the routes it is mounted on. It rejects
// the PLAIN admin token only:
//   • an impersonation session (payload.imp → req.user.impersonator) still
//     passes — that path is permission-gated (customers.impersonate),
//     audit-logged, short-lived, and read-only;
//   • ordinary tenant users are unaffected.
//
// Mount it on any tenant route whose response contains end-customer PII. Do
// not "fix" a 403 from this guard by removing the middleware — if platform
// staff need something from a tenant's data, it belongs behind a narrow,
// audit-logged /v1/admin endpoint instead (see the single-order lookup in
// customerAdminService.singleOrderForSupport for the pattern).
//
// NOTE: this is a per-route patch, not the systemic fix. The systemic fix is to
// make requireBusinessOwnership deny platform-staff reads by default and
// allow-list the few oversight routes — that lives in middleware/auth.js.

const { Forbidden } = require('../utils/errors');

function noPlatformStaff(req, _res, next) {
  if (req.user?.isSuperAdmin && !req.user?.impersonator) {
    return next(new Forbidden(
      'Platform staff cannot read a tenant\'s end-customer data. '
      + 'Use an impersonation session (audited) if the restaurant has asked you to act on their behalf.'
    ));
  }
  return next();
}

module.exports = noPlatformStaff;
