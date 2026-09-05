// NamastePOS — IRP (e-invoice / e-way bill) CREDENTIAL GATE
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ══════════════════════════════════════════════════════════════════════════
// Two services used to manufacture government document numbers that no
// government system had ever seen:
//
//   * accountingExportService.generateIrn() computed a real NIC IRN —
//     SHA256(gstin + doc_no + doc_date + fy), the correct algorithm — and
//     stored it with status 'generated' and an ack_no of `ACK-<epoch>`.
//     It never called the IRP. The output is 64 hex characters and is
//     indistinguishable from an IRN the IRP actually signed.
//   * ewayBillService.generate() hashed the row id into a 12-character
//     value formatted exactly like NIC's 12-digit EWB number.
//
// IRP_BASE_URL / IRP_USERNAME / IRP_PASSWORD are NOT set in production, so
// every one of those numbers is fabricated. A restaurant that files a return
// against a fabricated IRN has a tax problem, not a software problem — and
// Advanced is sold at Rs 999 partly on "e-invoice", so the owner has every
// reason to believe the number is real.
//
// PRECEDENT — otpService._sendViaMsg91 (P0 fix, 2026-08-24). The dev-log OTP
// fallback did the same shape of damage: with no MSG91_AUTHKEY it quietly
// took the dev path and returned success. The fix was NOT to make the dev
// path safer; it was to make production REFUSE:
//
//     if (env.isProd()) {
//       logger.error('[otp] MSG91_AUTHKEY missing ... refusing to issue OTP');
//       throw new Error('OTP delivery is not configured');
//     }
//
// This module is that same hard gate for the IRP. In production with no IRP
// credentials we log and throw; nothing is written. Outside production the
// stub survives (dev and demos need it) but everything it produces is
// branded DEMO — the document number itself, the stored row and every API
// response — so a demo number can never be copy-pasted into a filing.
//
// TO GO LIVE: implementing the NIC call is not enough. Set the three env
// vars, implement the live branch in each caller, and only then may
// irpConfigured() return true for a request that writes a real number.

const env = require('../config/env');
const logger = require('../config/logger');
const { HttpError } = require('../utils/errors');

/** The three env vars that gate every real IRP/NIC call. */
const IRP_ENV_VARS = ['IRP_BASE_URL', 'IRP_USERNAME', 'IRP_PASSWORD'];

// The DEMO brand. It is deliberately not hex, not 64 characters, and not 12
// digits — an IRN is 64 hex chars and an EWB number is 12 digits, so neither
// of these can be typed into a GST portal or a return by accident.
const STUB_IRN_PREFIX = 'DEMO-NOT-A-VALID-IRN-';
const STUB_EWB_PREFIX = 'DEMO-NOT-A-VALID-EWB-';

/** Human-readable reason attached to every stub row and API response. */
const STUB_NOTICE = 'DEMO ONLY — not filed with the government IRP. '
  + 'This number does not exist on any GST portal and must never be used in a return.';

/** True only when all three IRP credentials are present. */
function irpConfigured() {
  return IRP_ENV_VARS.every((k) => Boolean(env[k]));
}

/** Which of the three are missing — for the log line and the error detail. */
function missingIrpEnv() {
  return IRP_ENV_VARS.filter((k) => !env[k]);
}

/**
 * The gate. Call this BEFORE writing anything.
 *
 * In production without IRP credentials it logs an error and throws, exactly
 * like otpService._sendViaMsg91 — a fabricated tax document is worse than a
 * failed request. Outside production it returns and the caller may emit a
 * DEMO-branded stub.
 *
 * @param {string} what  'e-invoice IRN' | 'e-way bill' — used in the message.
 */
function assertStubAllowed(what) {
  if (!env.isProd()) return;
  const missing = missingIrpEnv().join(', ');
  logger.error(
    `[irp] ${missing} missing in production — refusing to fabricate a ${what}. `
    + 'The stub would be indistinguishable from a government-issued number.',
  );
  throw new HttpError(
    503,
    `${what} is not configured. NamastePOS is not connected to a GSP/IRP, `
    + 'so nothing can be filed with the government. Nothing was generated.',
    'IRP_NOT_CONFIGURED',
    { missingEnv: missingIrpEnv() },
  );
}

/** DEMO-branded IRN built from the real NIC hash, so it stays deterministic. */
function stubIrn(nicHash) {
  return `${STUB_IRN_PREFIX}${String(nicHash).slice(0, 32)}`;
}

/** DEMO-branded e-way bill number. */
function stubEwbNo(hash) {
  return `${STUB_EWB_PREFIX}${String(hash).slice(0, 12).toUpperCase()}`;
}

/**
 * Is a STORED value a stub? Used for rows written before migration 093 added
 * the is_stub column, and as a belt-and-braces check in serializers.
 */
function looksLikeStub(value) {
  const s = String(value || '');
  return s.startsWith(STUB_IRN_PREFIX) || s.startsWith(STUB_EWB_PREFIX);
}

/** The `raw_response` / `raw_payload` blob every stub row carries. */
function stubPayload(extra = {}) {
  return {
    stub: true,
    demo: true,
    filedWithIrp: false,
    notice: STUB_NOTICE,
    missingEnv: missingIrpEnv(),
    ...extra,
  };
}

module.exports = {
  IRP_ENV_VARS,
  STUB_IRN_PREFIX,
  STUB_EWB_PREFIX,
  STUB_NOTICE,
  irpConfigured,
  missingIrpEnv,
  assertStubAllowed,
  stubIrn,
  stubEwbNo,
  looksLikeStub,
  stubPayload,
};
