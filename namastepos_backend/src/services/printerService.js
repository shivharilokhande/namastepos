// Printer driver + KDS + ESC/POS render (Sprint 5 / FF-801, FF-802, FF-603)

const { query } = require('../config/db');
const { NotFound } = require('../utils/errors');

// ── Printer CRUD ─────────────────────────────────────────────────────────
async function listPrinters(businessId) {
  const r = await query(
    `SELECT p.*, ks.name AS station_name
       FROM printers p
  LEFT JOIN kot_stations ks ON ks.id = p.station_id
      WHERE p.business_id = $1 AND p.is_active = TRUE
      ORDER BY p.kind, p.name`,
    [businessId]
  );
  return r.rows;
}

async function upsertPrinter(businessId, body) {
  const { id, name, kind, connection, address, paperWidthMm, stationId, isDefault } = body;
  if (id) {
    const r = await query(
      `UPDATE printers SET name = $1, kind = $2, connection = $3,
             address = $4, paper_width_mm = $5, station_id = $6, is_default = $7
        WHERE id = $8 AND business_id = $9 RETURNING *`,
      [name, kind, connection, address, paperWidthMm || 80, stationId || null,
       isDefault === true, id, businessId]
    );
    if (r.rowCount === 0) throw new NotFound('Printer not found');
    return r.rows[0];
  }
  const r = await query(
    `INSERT INTO printers
       (business_id, name, kind, connection, address, paper_width_mm,
        station_id, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [businessId, name, kind, connection, address || null,
     paperWidthMm || 80, stationId || null, isDefault === true]
  );
  return r.rows[0];
}

async function deletePrinter(businessId, id) {
  await query(
    `UPDATE printers SET is_active = FALSE
      WHERE business_id = $1 AND id = $2`,
    [businessId, id]
  );
}

// ── Print queue ──────────────────────────────────────────────────────────
async function queuePrintJob({ businessId, printerId, orderId, kotTicketId, kind, payloadText }) {
  const r = await query(
    `INSERT INTO print_jobs
       (business_id, printer_id, order_id, kot_ticket_id, kind, payload_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [businessId, printerId || null, orderId || null, kotTicketId || null, kind, payloadText]
  );
  return r.rows[0].id;
}

async function dequeueNext(businessId) {
  // Print agent on the cashier's machine polls this; takes one job at a time.
  const r = await query(
    `UPDATE print_jobs SET status = 'printing', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM print_jobs
          WHERE business_id = $1 AND status = 'queued'
          ORDER BY created_at LIMIT 1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [businessId]
  );
  return r.rows[0] || null;
}

async function markJobDone(businessId, jobId, ok, errorMessage) {
  await query(
    `UPDATE print_jobs
        SET status = $1, error_message = $2,
            completed_at = CASE WHEN $1 = 'done' THEN NOW() ELSE completed_at END
      WHERE business_id = $3 AND id = $4`,
    [ok ? 'done' : 'failed', errorMessage || null, businessId, jobId]
  );
}

// ── ESC/POS receipt rendering ────────────────────────────────────────────
function renderReceiptText({ template, order, items, isDuplicate = false }) {
  const w = template?.paperWidthMm === 58 ? 32 : 48;   // chars per line
  const line = (l = '-') => l.repeat(w);
  const center = (s) => {
    const pad = Math.max(0, Math.floor((w - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const right = (s) => ' '.repeat(Math.max(0, w - s.length)) + s;
  const pair = (l, r) => {
    const space = Math.max(1, w - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };

  const out = [];
  if (isDuplicate) out.push(center('*** DUPLICATE ***'));
  for (const h of (template?.headerLines || [])) out.push(center(h));
  if (template?.gstin)   out.push(center(`GSTIN: ${template.gstin}`));
  if (template?.fssaiNo) out.push(center(`FSSAI: ${template.fssaiNo}`));
  out.push(line('='));
  out.push(`Order #${order.orderNo}  ${order.source}`);
  out.push(new Date(order.createdAt).toLocaleString());
  if (order.tableNo) out.push(`Table: ${order.tableNo}`);
  if (order.customerPhone) out.push(`Phone: ${order.customerPhone}`);
  out.push(line('-'));
  for (const it of items) {
    out.push(pair(`${it.qty} × ${it.name}`.slice(0, w-8), `${(it.price * it.qty).toFixed(2)}`));
    if (it.variantLabel) out.push(`   · ${it.variantLabel}`);
    if (Array.isArray(it.modifierLines)) {
      for (const m of it.modifierLines) out.push(`   + ${m.name}`);
    }
  }
  out.push(line('-'));
  out.push(pair('Subtotal', order.subtotal.toFixed(2)));
  if (order.serviceChargeInr > 0) out.push(pair('Service', '+ ' + order.serviceChargeInr.toFixed(2)));
  if (template?.showTaxBreakdown && order.cgst > 0) {
    out.push(pair('CGST', '+ ' + order.cgst.toFixed(2)));
    out.push(pair('SGST', '+ ' + order.sgst.toFixed(2)));
  } else if (order.tax > 0) {
    out.push(pair('Tax',  '+ ' + order.tax.toFixed(2)));
  }
  if (order.discount > 0) out.push(pair('Discount', '- ' + order.discount.toFixed(2)));
  if (order.roundOffInr) out.push(pair('Round off', (order.roundOffInr > 0 ? '+ ' : '- ') + Math.abs(order.roundOffInr).toFixed(2)));
  out.push(line('='));
  out.push(pair('TOTAL', order.total.toFixed(2)));
  out.push(`Payment: ${order.paymentMethod}`);
  if (template?.showToken && order.tokenNo) {
    out.push('');
    out.push(center(`TOKEN #${order.tokenNo}`));
  }
  if (template?.footerText) {
    out.push(line('-'));
    out.push(center(template.footerText));
  }
  return out.join('\n');
}

module.exports = {
  listPrinters, upsertPrinter, deletePrinter,
  queuePrintJob, dequeueNext, markJobDone,
  renderReceiptText,
};
