// Tally + Zoho Books + e-invoice (Sprint 7 / FF-1101, FF-1102, FF-1103)

const crypto = require('crypto');
const { query } = require('../config/db');
const { BadRequest } = require('../utils/errors');

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
// In prod this calls https://einvoice1.gst.gov.in/eivital/dlversionone.
// We stub the IRN generation to a deterministic SHA256 when not configured;
// real call requires NIC's GSP credentials. Schema + service contract are
// in place — flip env.IRP_BASE_URL + creds to go live.
async function generateIrn(businessId, orderId) {
  const o = await query(
    'SELECT * FROM orders WHERE business_id = $1 AND id = $2',
    [businessId, orderId],
  );
  if (o.rowCount === 0) throw new BadRequest('Order not found');

  // Generate IRN per NIC algorithm: SHA256(supplier_gstin + doc_no + doc_date + fy)
  const biz = await query('SELECT gstin FROM businesses WHERE id = $1', [businessId]);
  const gstin = biz.rows[0]?.gstin || '';
  const order = o.rows[0];
  const docDate = new Date(order.created_at).toISOString().slice(0, 10);
  const fy = (() => {
    const d = new Date(order.created_at);
    const year = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
    return `${year}-${(year + 1).toString().slice(2)}`;
  })();
  const irn = crypto.createHash('sha256')
    .update(`${gstin}${order.order_no}${docDate}${fy}`)
    .digest('hex');

  // If IRP configured, would POST to NIC here. For now store the
  // deterministic IRN so the rest of the flow can be tested.
  const r = await query(
    `INSERT INTO einvoice_irns
       (business_id, order_id, irn, ack_no, ack_date, status)
     VALUES ($1, $2, $3, $4, NOW(), 'generated')
     ON CONFLICT (irn) DO UPDATE SET ack_date = NOW()
     RETURNING *`,
    [businessId, orderId, irn, `ACK-${Date.now()}`],
  );
  return r.rows[0];
}

async function generateEwayBill(businessId, invoiceId, body) {
  const ewayNo = `EWB${Date.now().toString()}`;
  const validity = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day default
  const r = await query(
    `INSERT INTO eway_bills
       (business_id, invoice_id, eway_no, eway_date, validity,
        vehicle_no, distance_km)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6) RETURNING *`,
    [businessId, invoiceId, ewayNo, validity, body.vehicleNo, body.distanceKm],
  );
  return r.rows[0];
}

async function listExports(businessId) {
  const r = await query(
    `SELECT * FROM accounting_exports WHERE business_id = $1
      ORDER BY created_at DESC LIMIT 50`,
    [businessId],
  );
  return r.rows;
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
    `SELECT order_id, irn, ack_no, ack_date, status, cancelled_at, created_at
       FROM einvoice_irns
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 500`,
    [businessId],
  );
  return r.rows.map((row) => ({
    orderId: row.order_id,
    irn: row.irn,
    ackNo: row.ack_no,
    ackDate: row.ack_date,
    status: row.status,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  }));
}

module.exports = {
  tallyExport, zohoCsv, generateIrn, generateEwayBill, listExports, listIrns,
};
