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
// If IRP creds are unset we return a deterministic stub e-way bill
// number so the UI + downstream reports work in dev; the real
// integration replaces this function's body once the customer has
// their GSP account activated.

const { query } = require('../config/db');
const env = require('../config/env');
const { BadRequest, NotFound } = require('../utils/errors');
const crypto = require('crypto');

async function generate(businessId, {
  taxInvoiceId, fromPincode, toPincode, fromState, toState,
  distanceKm, vehicleNo, transporterId,
}) {
  // Sanity check the invoice belongs to this business.
  if (taxInvoiceId) {
    const inv = await query(
      `SELECT id FROM tax_invoices WHERE id = $1 AND business_id = $2`,
      [taxInvoiceId, businessId]
    );
    if (inv.rowCount === 0) throw new NotFound('Tax invoice not found');
  }
  if (!fromPincode || !toPincode || !fromState || !toState) {
    throw new BadRequest('from/to pincode + state are required');
  }

  // Reserve the row before hitting the (potentially slow) NIC API.
  const ins = await query(
    `INSERT INTO eway_bills
       (business_id, tax_invoice_id, from_pincode, to_pincode,
        from_state, to_state, distance_km, vehicle_no, transporter_id,
        status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
     RETURNING *`,
    [businessId, taxInvoiceId || null, fromPincode, toPincode,
     fromState, toState, distanceKm || null, vehicleNo || null, transporterId || null]
  );
  const row = ins.rows[0];

  const usingRealApi = env.IRP_BASE_URL && env.IRP_USERNAME && env.IRP_PASSWORD;
  let ewbNo, ewbDate, rawPayload;

  if (usingRealApi) {
    // Live NIC EWB API. Left as a scaffold — sign the exact schema
    // when the first Enterprise customer needs it. This block
    // intentionally throws so we don't accidentally file broken
    // requests to a live GSP endpoint in dev.
    throw new BadRequest('Live NIC e-way bill call not implemented. Enable when customer has active GSP credentials.');
  } else {
    // Deterministic stub — hash the row id, format like NIC's 12-digit
    // number. Useful for dev + demos without touching prod GSP.
    const h = crypto.createHash('sha256').update(row.id).digest('hex');
    ewbNo = h.slice(0, 12).toUpperCase().replace(/[^0-9A-F]/g, '0');
    ewbDate = new Date();
    rawPayload = { stub: true, note: 'IRP creds not configured; deterministic EWB.' };
  }

  const upd = await query(
    `UPDATE eway_bills
        SET ewb_no = $1, ewb_date = $2, status = 'generated', raw_payload = $3
      WHERE id = $4 RETURNING *`,
    [ewbNo, ewbDate, rawPayload, row.id]
  );
  return upd.rows[0];
}

async function list(businessId, { limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM eway_bills
      WHERE business_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [businessId, limit]
  );
  return r.rows;
}

async function cancel(businessId, id, reason) {
  const r = await query(
    `UPDATE eway_bills
        SET status = 'cancelled', raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $1::jsonb
      WHERE business_id = $2 AND id = $3 AND status = 'generated'
      RETURNING *`,
    [{ cancellationReason: reason || 'owner request' }, businessId, id]
  );
  if (r.rowCount === 0) throw new BadRequest('E-way bill not found or not cancellable');
  return r.rows[0];
}

module.exports = { generate, list, cancel };
