// NamastePOS — E-way bill generation (FF-1103).
//
// The GST e-way bill is a companion to a tax invoice when goods
// worth > ₹50k move across state lines (or intrastate depending on
// the state). For a cafe MVP this is rare — the code exists for the
// day one of our multi-outlet Advanced/Enterprise tenants needs it.
//
// NIC (National Informatics Centre) runs the actual API at
// https://api.gst.gov.in/. Credentials come from env
// (`IRP_USERNAME` / `IRP_PASSWORD`) — we reuse the same credentials
// as the e-invoice service since NIC gates both behind the same GSP.
//
// HONESTY GATE (2026-09-05). This used to emit, with no credentials, a
// deterministic 12-character hash formatted exactly like NIC's 12-digit EWB
// number and store it with status 'generated'. Nothing on the row, in the
// number, or in the API response said it was fake. An e-way bill that NIC has
// never seen is not a UI placeholder — it is a document a transporter is
// stopped over.
//
// The rule now matches otpService._sendViaMsg91 (P0, 2026-08-24: the dev-log
// OTP fallback that must never run in production): in production with no IRP
// credentials we log and THROW, and nothing is written. Outside production the
// stub survives for dev and demos, branded DEMO in the number, the row and the
// response. See src/services/irpGateway.js.

const crypto = require('crypto');
const { query } = require('../config/db');
const { BadRequest, NotFound, HttpError } = require('../utils/errors');
const irp = require('./irpGateway');

async function generate(businessId, {
  taxInvoiceId, fromPincode, toPincode, fromState, toState,
  distanceKm, vehicleNo, transporterId,
}) {
  // Sanity check the invoice belongs to this business.
  if (taxInvoiceId) {
    const inv = await query(
      'SELECT id FROM tax_invoices WHERE id = $1 AND business_id = $2',
      [taxInvoiceId, businessId],
    );
    if (inv.rowCount === 0) throw new NotFound('Tax invoice not found');
  }
  if (!fromPincode || !toPincode || !fromState || !toState) {
    throw new BadRequest('from/to pincode + state are required');
  }

  // ── The gate, BEFORE any row is reserved ────────────────────────────────
  // The old code inserted a 'draft' row first and only then decided whether
  // it could produce a number, so a refusal still left a row behind. A
  // request we refuse must leave the database exactly as it found it.
  if (irp.irpConfigured()) {
    // Live NIC EWB API is still a scaffold. With credentials present we fail
    // loudly rather than quietly falling back to the stub — the fallback is
    // precisely how a fake number reaches a real filing.
    throw new HttpError(
      501,
      'Live NIC e-way bill call is not implemented. IRP credentials are set but '
      + 'the GSP request is not built — refusing rather than issuing a local number.',
      'IRP_NOT_IMPLEMENTED',
    );
  }
  irp.assertStubAllowed('e-way bill');

  // One INSERT, not reserve-then-update. The old two-step existed to hold a
  // row while a slow NIC call ran; with no call to make it only created a way
  // for a 'draft' row to survive a failure. Generating the id here also lets
  // the number stay a deterministic function of the row it belongs to.
  const id = crypto.randomUUID();
  // Branded DEMO number: neither 12 characters nor all digits, so it cannot
  // be read as, or typed in place of, a NIC e-way bill number.
  const ewbNo = irp.stubEwbNo(crypto.createHash('sha256').update(id).digest('hex'));
  const rawPayload = irp.stubPayload({ note: 'IRP creds not configured; deterministic DEMO EWB.' });

  // eway_no AND ewb_no both get the same value: the table carries the 024
  // shape (eway_no, NOT NULL, used by the Tally/GSTR flavour) and the 046
  // shape (ewb_no, added for real by migration 093 — 046's CREATE TABLE IF
  // NOT EXISTS was a silent no-op). Writing both keeps every reader honest
  // instead of leaving one of them looking at a NULL.
  const ins = await query(
    `INSERT INTO eway_bills
       (id, business_id, tax_invoice_id, from_pincode, to_pincode,
        from_state, to_state, distance_km, vehicle_no, transporter_id,
        ewb_no, ewb_date, status, raw_payload, is_stub,
        eway_no, eway_date, validity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11::text, NOW(), 'demo', $12, TRUE,
             $11::varchar(40), CURRENT_DATE, NOW() + INTERVAL '1 day')
     RETURNING *`,
    [id, businessId, taxInvoiceId || null, fromPincode, toPincode,
      fromState, toState, distanceKm || null, vehicleNo || null, transporterId || null,
      ewbNo, rawPayload],
  );
  return _serialize(ins.rows[0]);
}

/**
 * Same contract as the IRN serializer in accountingExportService: a caller
 * must be able to tell a DEMO number from a filed one from the response
 * alone, without pattern-matching the number.
 */
function _serialize(row) {
  const isStub = row.is_stub === true || irp.looksLikeStub(row.ewb_no);
  return {
    ...row,
    isStub,
    filedWithNic: !isStub,
    notice: isStub ? irp.STUB_NOTICE : null,
  };
}

async function list(businessId, { limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM eway_bills
      WHERE business_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [businessId, limit],
  );
  return r.rows.map(_serialize);
}

async function cancel(businessId, id, reason) {
  const r = await query(
    `UPDATE eway_bills
        SET status = 'cancelled', raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $1::jsonb
      WHERE business_id = $2 AND id = $3 AND status IN ('generated', 'demo')
      RETURNING *`,
    [{ cancellationReason: reason || 'owner request' }, businessId, id],
  );
  if (r.rowCount === 0) throw new BadRequest('E-way bill not found or not cancellable');
  return _serialize(r.rows[0]);
}

module.exports = { generate, list, cancel };
