// B2B invoice template store (2026-09-06, round-2 review D-04 / CONTRACTS §1).
//
// One row per business in `b2b_invoice_templates` (migration 030 shape +
// migration 095 columns). The dashboard's B2B template page used to write the
// RECEIPT template and 402 below Enterprise; it now has its own store, gated
// on the `b2b_invoice` feature key in routes/b2bTemplate.routes.js.
//
// Wire shape (camelCase, every field always present):
//   { letterhead, terms, signatureUrl, bankDetails, showHsn, showEway }
// Defaults are returned when the business has no row yet, so the client never
// has to special-case "first visit".

const { query } = require('../config/db');

const DEFAULTS = Object.freeze({
  letterhead: '',
  terms: '',
  signatureUrl: '',
  bankDetails: '',
  showHsn: true,
  showEway: false,
});

function _serialize(row) {
  if (!row) return { ...DEFAULTS };
  return {
    // 095 added `letterhead`/`terms`; 030 had `letterhead_url`/`terms_text`.
    // Prefer the new column, fall back to the old one so a hand-inserted
    // legacy row still renders.
    letterhead: row.letterhead ?? row.letterhead_url ?? '',
    terms: row.terms ?? row.terms_text ?? '',
    signatureUrl: row.signature_url ?? '',
    bankDetails: row.bank_details ?? '',
    showHsn: row.show_hsn ?? true,
    showEway: row.show_eway ?? false,
  };
}

async function get(businessId) {
  const r = await query(
    'SELECT * FROM b2b_invoice_templates WHERE business_id = $1',
    [businessId],
  );
  return _serialize(r.rows[0]);
}

/**
 * Upsert. Every field is optional on the wire; an omitted field keeps its
 * stored value (or the default when there is no row yet) — a partial PUT
 * must not blank the letterhead. Same posture as the receipt template.
 */
async function put(businessId, body = {}) {
  const current = await get(businessId);
  const next = {
    letterhead: body.letterhead !== undefined ? (body.letterhead ?? '') : current.letterhead,
    terms: body.terms !== undefined ? (body.terms ?? '') : current.terms,
    signatureUrl: body.signatureUrl !== undefined ? (body.signatureUrl ?? '') : current.signatureUrl,
    bankDetails: body.bankDetails !== undefined ? (body.bankDetails ?? '') : current.bankDetails,
    showHsn: body.showHsn !== undefined ? !!body.showHsn : current.showHsn,
    showEway: body.showEway !== undefined ? !!body.showEway : current.showEway,
  };
  const r = await query(
    `INSERT INTO b2b_invoice_templates
       (business_id, letterhead, terms, signature_url, bank_details, show_hsn, show_eway)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id) DO UPDATE
       SET letterhead = EXCLUDED.letterhead,
           terms = EXCLUDED.terms,
           signature_url = EXCLUDED.signature_url,
           bank_details = EXCLUDED.bank_details,
           show_hsn = EXCLUDED.show_hsn,
           show_eway = EXCLUDED.show_eway,
           updated_at = NOW()
     RETURNING *`,
    [businessId, next.letterhead, next.terms, next.signatureUrl, next.bankDetails,
      next.showHsn, next.showEway],
  );
  return _serialize(r.rows[0]);
}

module.exports = { get, put, DEFAULTS };
