// Tally + Zoho Books + e-invoice (Sprint 7 / FF-1101, FF-1102, FF-1103)

const crypto = require('crypto');
const { query } = require('../config/db');
const { BadRequest, HttpError } = require('../utils/errors');
const irp = require('./irpGateway');

// ── Tally XML export ─────────────────────────────────────────────────────
function _tallyXmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tallyExport(businessId, { startDate, endDate }) {
  const orders = await query(
    `SELECT o.*, c.name AS customer_name
       FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.business_id = $1
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + INTERVAL '1 day')
        AND o.status <> 'cancelled'
      ORDER BY o.created_at`,
    [businessId, startDate, endDate],
  );
  // Generate Tally <ENVELOPE><VOUCHER> XML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n';
  xml += '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n';
  xml += '<BODY><IMPORTDATA>\n';
  xml += '<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>\n';
  xml += '<REQUESTDATA>\n';
  for (const o of orders.rows) {
    xml += '<TALLYMESSAGE>\n  <VOUCHER VCHTYPE="Sales" ACTION="Create">\n';
    xml += `    <DATE>${new Date(o.created_at).toISOString().slice(0, 10).replace(/-/g, '')}</DATE>\n`;
    xml += `    <VOUCHERNUMBER>${o.order_no}</VOUCHERNUMBER>\n`;
    xml += `    <PARTYLEDGERNAME>${_tallyXmlEscape(o.customer_name || 'Walk-in')}</PARTYLEDGERNAME>\n`;
    xml += `    <AMOUNT>${o.total}</AMOUNT>\n`;
    xml += `    <NARRATION>NamastePOS order #${o.order_no}</NARRATION>\n`;
    xml += '  </VOUCHER>\n</TALLYMESSAGE>\n';
  }
  xml += '</REQUESTDATA></IMPORTDATA></BODY>\n</ENVELOPE>';

  await query(
    `INSERT INTO accounting_exports
       (business_id, format, date_from, date_to, row_count, status, exported_at)
     VALUES ($1, 'tally_xml', $2, $3, $4, 'done', NOW())`,
    [businessId, startDate, endDate, orders.rowCount],
  );
  return { xml, count: orders.rowCount };
}

// ── Zoho Books CSV export ────────────────────────────────────────────────
async function zohoCsv(businessId, { startDate, endDate }) {
  const orders = await query(
    `SELECT o.order_no, o.created_at, c.name, o.subtotal, o.tax, o.total, o.payment_method
       FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.business_id = $1
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + INTERVAL '1 day')
        AND o.status <> 'cancelled'`,
    [businessId, startDate, endDate],
  );
  const header = 'Date,Invoice No,Customer,Subtotal,Tax,Total,Payment\n';
  const rows = orders.rows.map((o) => [
    new Date(o.created_at).toISOString().slice(0, 10),
    o.order_no, (o.name || 'Walk-in').replace(/,/g, ' '),
    o.subtotal, o.tax, o.total, o.payment_method,
  ].join(',')).join('\n');
  await query(
    `INSERT INTO accounting_exports
       (business_id, format, date_from, date_to, row_count, status, exported_at)
     VALUES ($1, 'zoho_csv', $2, $3, $4, 'done', NOW())`,
    [businessId, startDate, endDate, orders.rowCount],
  );
  return header + rows;
}

// ── E-invoice (NIC IRP) ──────────────────────────────────────────────────
//
// HONESTY GATE (2026-09-05). This function used to compute the correct NIC
// IRN — SHA256(supplier_gstin + doc_no + doc_date + fy) — store it with
// status 'generated' and an ack_no of `ACK-<epoch>`, and never call the IRP.
// The result was 64 hex characters: indistinguishable from a real IRN, and
// an owner who files a return against it has a tax problem, not a software
// problem. IRP_BASE_URL / IRP_USERNAME / IRP_PASSWORD are not set in
// production, so every IRN produced so far is fabricated (see migration 093,
// which marks the existing rows rather than touching their values).
//
// The rule now, copied from otpService._sendViaMsg91 (P0, 2026-08-24 — the
// dev-log OTP fallback that must never run in prod): PRODUCTION REFUSES.
// Outside production the stub survives for dev and demos, but it is branded
// DEMO in the IRN itself, in the row, and in the API response.
//
// TO GO LIVE: set the three env vars AND implement the live IRP POST below.
// Setting the credentials alone now makes this endpoint fail loudly rather
// than silently fall back to the stub — that is deliberate.
async function generateIrn(businessId, orderId) {
  const o = await query(
    'SELECT * FROM orders WHERE business_id = $1 AND id = $2',
    [businessId, orderId],
  );
  if (o.rowCount === 0) throw new BadRequest('Order not found');

  // Gate BEFORE anything is written: a refused request must leave no row.
  if (irp.irpConfigured()) {
    throw new HttpError(
      501,
      'Live NIC IRP e-invoice call is not implemented. IRP credentials are set '
      + 'but the GSP request is not built — refusing rather than storing a locally '
      + 'generated IRN under live credentials.',
      'IRP_NOT_IMPLEMENTED',
    );
  }
  irp.assertStubAllowed('e-invoice IRN');

  // The NIC algorithm still runs — it keeps the demo deterministic and keeps
  // the real implementation one branch away — but the stored value is branded
  // so it can never be mistaken for, or pasted in place of, a filed IRN.
  const biz = await query('SELECT gstin FROM businesses WHERE id = $1', [businessId]);
  const gstin = biz.rows[0]?.gstin || '';
  const order = o.rows[0];
  const docDate = new Date(order.created_at).toISOString().slice(0, 10);
  const fy = (() => {
    const d = new Date(order.created_at);
    const year = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
    return `${year}-${(year + 1).toString().slice(2)}`;
  })();
  const nicHash = crypto.createHash('sha256')
    .update(`${gstin}${order.order_no}${docDate}${fy}`)
    .digest('hex');
  const irn = irp.stubIrn(nicHash);

  const r = await query(
    `INSERT INTO einvoice_irns
       (business_id, order_id, irn, ack_no, ack_date, status, is_stub, raw_response)
     VALUES ($1, $2, $3, $4, NOW(), 'demo', TRUE, $5)
     ON CONFLICT (irn) DO UPDATE SET ack_date = NOW()
     RETURNING *`,
    [businessId, orderId, irn, 'DEMO-NOT-ACKNOWLEDGED',
      JSON.stringify(irp.stubPayload({ nicHash }))],
  );
  return _serializeIrn(r.rows[0]);
}

// The Tally/GSTR flavour of e-way bill generation. Same gate: `EWB<epoch>`
// is formatted like a NIC number and was never filed with anyone.
async function generateEwayBill(businessId, invoiceId, body) {
  if (irp.irpConfigured()) {
    throw new HttpError(
      501,
      'Live NIC e-way bill call is not implemented. Refusing to issue a local '
      + 'number under live credentials.',
      'IRP_NOT_IMPLEMENTED',
    );
  }
  irp.assertStubAllowed('e-way bill');

  // 2026-09-06 (review #15, P3): `invoiceId` was never checked against the
  // tenant — the FK points at the platform `invoices` table, so a caller could
  // attach an e-way bill to another business's (or the platform's) invoice id.
  // Scope the lookup: the id must be one of THIS business's tax invoices.
  const inv = await query(
    'SELECT id FROM tax_invoices WHERE business_id = $1 AND id = $2',
    [businessId, invoiceId],
  );
  if (inv.rowCount === 0) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');

  // Same review: the demo number was a hash of (business, invoice), so a second
  // call for the same invoice 409'd on the unique eway_no. Salt per attempt.
  const ewayNo = irp.stubEwbNo(
    crypto.createHash('sha256')
      .update(`${businessId}:${invoiceId}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`)
      .digest('hex'),
  );
  const validity = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day default
  // `eway_bills.invoice_id` (024) is an FK to the PLATFORM `invoices` table
  // (SaaS subscription bills) — a tenant tax-invoice id there is an FK
  // violation, which is how the untenanted lookup went unnoticed. The tenant
  // document belongs in `tax_invoice_id` (046/093); invoice_id stays NULL.
  const r = await query(
    `INSERT INTO eway_bills
       (business_id, tax_invoice_id, eway_no, eway_date, validity,
        vehicle_no, distance_km, is_stub, raw_response)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, TRUE, $7) RETURNING *`,
    [businessId, invoiceId, ewayNo, validity, body.vehicleNo, body.distanceKm,
      JSON.stringify(irp.stubPayload())],
  );
  return { ...r.rows[0], isStub: true, filedWithNic: false, notice: irp.STUB_NOTICE };
}

async function listExports(businessId) {
  const r = await query(
    `SELECT * FROM accounting_exports WHERE business_id = $1
      ORDER BY created_at DESC LIMIT 50`,
    [businessId],
  );
  return r.rows;
}

/**
 * One shape for every IRN the API hands out, from the write path and the read
 * path alike.
 *
 * `isStub` is the load-bearing field: the dashboard, the app and any printed
 * document must be able to tell a DEMO number from a filed one WITHOUT
 * pattern-matching the IRN string. It is true when the row says so (is_stub,
 * backfilled by migration 093 for everything written before the gate existed)
 * or when the value itself carries the DEMO brand.
 */
function _serializeIrn(row) {
  const isStub = row.is_stub === true || irp.looksLikeStub(row.irn);
  return {
    orderId: row.order_id,
    irn: row.irn,
    ackNo: row.ack_no,
    ackDate: row.ack_date,
    status: row.status,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    isStub,
    // Explicit rather than implied: a caller that ignores isStub still cannot
    // read this object as "filed with the government".
    filedWithIrp: !isStub,
    notice: isStub ? irp.STUB_NOTICE : null,
  };
}

// WHY (2026-08-25): founder — "IRN generated · 580ce2… but where do those
// invoices go?" generateIrn() writes einvoice_irns and the success toast
// was the ONLY place the IRN ever appeared: tax_invoices.irn exists but is
// never populated, and no endpoint read einvoice_irns back. This is that
// read path. One list per business, keyed by order_id, so the dashboard
// can join IRNs onto both orders and tax invoices (tax_invoices.order_id)
// with a single fetch — no per-row lookups.
async function listIrns(businessId) {
  const r = await query(
    `SELECT order_id, irn, ack_no, ack_date, status, cancelled_at, created_at,
            is_stub
       FROM einvoice_irns
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 500`,
    [businessId],
  );
  return r.rows.map(_serializeIrn);
}

module.exports = {
  tallyExport, zohoCsv, generateIrn, generateEwayBill, listExports, listIrns,
};
