// NamastePOS backend — GST-compliant SUBSCRIPTION invoice PDF.
//
// This is the invoice NamastePOS (the SaaS) issues to a business owner when
// they pay for their plan. It is a proper Indian tax invoice: seller (us) +
// buyer (the business) GSTIN, SAC code, taxable value, and CGST/SGST or IGST
// split derived the same way as gstService (supplier state vs recipient
// state). Generated on demand with pdfkit and streamed to the response, so we
// no longer depend on Razorpay hosting a PDF (the old "No PDF yet" error).

const PDFDocument = require('pdfkit');
const { query } = require('../config/db');
const settings = require('./settingsService');
const { NotFound } = require('../utils/errors');

function inr(paise) {
  const n = (Number(paise) || 0) / 100;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Load the invoice + buyer business. businessId (optional) scopes the lookup
// to a tenant so a business owner can only pull their OWN invoices; the admin
// route passes null and can fetch any.
async function loadInvoice(invoiceId, businessId = null) {
  const params = [invoiceId];
  let where = 'i.id = $1';
  if (businessId) { params.push(businessId); where += ' AND i.business_id = $2'; }
  const r = await query(
    `SELECT i.*, b.name AS business_name, b.legal_name AS business_legal_name,
            b.gstin AS customer_gstin, b.address AS business_address,
            b.city AS business_city, b.state_code AS business_state_code,
            b.fssai AS business_fssai, b.phone AS business_phone
       FROM invoices i
       JOIN businesses b ON b.id = i.business_id
      WHERE ${where} LIMIT 1`,
    params,
  );
  if (r.rowCount === 0) throw new NotFound('Invoice not found');
  return r.rows[0];
}

// Compute the GST breakdown for one invoice. amount_paise is treated as the
// gross (tax-inclusive) total, mirroring gstService.
async function computeTax(inv) {
  const s = await settings.getMany([
    'platform.gstin', 'platform.legal_name', 'platform.address',
    'platform.hsn', 'platform.tax_pct', 'brand.name', 'brand.support_email',
  ]);
  const pct = Number(s['platform.tax_pct']) || 18;
  const gross = Number(inv.amount_paise) || 0;
  const subtotal = Math.round(gross / (1 + pct / 100));
  const tax = gross - subtotal;

  const sellerGstin = s['platform.gstin'] || '';
  const sellerState = sellerGstin.slice(0, 2);
  const custState = (inv.customer_gstin || '').slice(0, 2) || inv.business_state_code || '';
  // Inter-state only when we can positively tell the two states differ;
  // otherwise default to intra-state (CGST+SGST) — the common case.
  const interState = !!(sellerState && custState && custState !== sellerState);
  const igst = interState ? tax : 0;
  const cgst = interState ? 0 : Math.round(tax / 2);
  const sgst = interState ? 0 : tax - cgst;

  return {
    pct,
    gross,
    subtotal,
    tax,
    interState,
    igst,
    cgst,
    sgst,
    seller: {
      name: s['platform.legal_name'] || s['brand.name'] || 'NamastePOS Technologies Pvt. Ltd.',
      gstin: sellerGstin,
      address: s['platform.address'] || '',
      hsn: s['platform.hsn'] || '998314',
      email: s['brand.support_email'] || 'support@namastepos.in',
    },
  };
}

// Render the invoice to the given HTTP response as an inline PDF.
async function renderPdf(res, { invoiceId, businessId = null } = {}) {
  const inv = await loadInvoice(invoiceId, businessId);
  const t = await computeTax(inv);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = `${inv.number || 'invoice'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  const GREEN = '#0E7C4A';
  const INK = '#0F1F17';
  const MUTED = '#5B6B63';
  const LINE = '#E4EBE6';
  const pageW = doc.page.width - 100; // usable width inside margins
  const left = 50;

  // Header
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(22).text('NamastePOS', left, 50);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text(t.seller.name, left, 76)
    .text(t.seller.address || '', left, 88, { width: 280 });
  if (t.seller.gstin) doc.text(`GSTIN: ${t.seller.gstin}`, left, t.seller.address ? 112 : 100);
  doc.text(`Email: ${t.seller.email}`, left, (t.seller.address ? 112 : 100) + 12);

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16)
    .text('TAX INVOICE', 300, 52, { width: pageW - 250, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Invoice No: ${inv.number || inv.id.slice(0, 8)}`, 300, 78, { width: pageW - 250, align: 'right' })
    .text(`Invoice Date: ${fmtDate(inv.paid_at || inv.created_at)}`, 300, 90, { width: pageW - 250, align: 'right' })
    .text(`Status: ${(inv.status || '').toUpperCase()}`, 300, 102, { width: pageW - 250, align: 'right' });

  // Divider
  let y = 140;
  doc.moveTo(left, y).lineTo(left + pageW, y).strokeColor(LINE).lineWidth(1)
    .stroke();
  y += 16;

  // Bill To
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('BILL TO', left, y);
  y += 14;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
    .text(inv.business_legal_name || inv.business_name || 'Customer', left, y, { width: pageW });
  y += 16;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const addrParts = [inv.business_address, inv.business_city].filter(Boolean).join(', ');
  if (addrParts) { doc.text(addrParts, left, y, { width: 300 }); y += 12; }
  if (inv.customer_gstin) { doc.text(`GSTIN: ${inv.customer_gstin}`, left, y); y += 12; }
  if (inv.business_fssai) { doc.text(`FSSAI: ${inv.business_fssai}`, left, y); y += 12; }
  if (inv.business_phone) { doc.text(`Phone: ${inv.business_phone}`, left, y); y += 12; }
  const placeOfSupply = inv.business_state_code || (inv.customer_gstin || '').slice(0, 2) || '—';
  doc.text(`Place of supply: ${placeOfSupply}`, left, y); y += 20;

  // Line-item table
  const cols = { desc: left, hsn: left + 210, taxable: left + 290, tax: left + 380, amount: left + 470 };
  doc.rect(left, y, pageW, 22).fill(GREEN);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
  doc.text('Description', cols.desc + 6, y + 7);
  doc.text('SAC', cols.hsn, y + 7);
  doc.text('Taxable', cols.taxable, y + 7);
  doc.text(`GST ${t.pct}%`, cols.tax, y + 7);
  doc.text('Amount', cols.amount, y + 7, { width: left + pageW - cols.amount - 6, align: 'right' });
  y += 22;

  const period = (inv.period_start && inv.period_end)
    ? `${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}`
    : '';
  const desc = `NamastePOS software subscription${period ? `\n${period}` : ''}`;
  doc.fillColor(INK).font('Helvetica').fontSize(9);
  const rowH = period ? 34 : 24;
  doc.text(desc, cols.desc + 6, y + 7, { width: 195 });
  doc.text(t.seller.hsn, cols.hsn, y + 7);
  doc.text(inr(t.subtotal), cols.taxable, y + 7);
  doc.text(inr(t.tax), cols.tax, y + 7);
  doc.text(inr(t.gross), cols.amount, y + 7, { width: left + pageW - cols.amount - 6, align: 'right' });
  y += rowH;
  doc.moveTo(left, y).lineTo(left + pageW, y).strokeColor(LINE).lineWidth(1)
    .stroke();
  y += 14;

  // Totals block (right aligned)
  const tx = left + 300;
  const tw = pageW - 300;
  function totalRow(label, value, bold) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
      .fillColor(bold ? INK : MUTED);
    doc.text(label, tx, y, { width: tw - 110 });
    doc.text(value, tx + tw - 110, y, { width: 110, align: 'right' });
    y += bold ? 20 : 15;
  }
  totalRow('Taxable value', inr(t.subtotal));
  if (t.interState) {
    totalRow(`IGST @ ${t.pct}%`, inr(t.igst));
  } else {
    totalRow(`CGST @ ${t.pct / 2}%`, inr(t.cgst));
    totalRow(`SGST @ ${t.pct / 2}%`, inr(t.sgst));
  }
  doc.moveTo(tx, y + 2).lineTo(left + pageW, y + 2).strokeColor(LINE).stroke();
  y += 8;
  totalRow('Total', inr(t.gross), true);

  // Footer
  const fy = doc.page.height - 90;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('This is a computer-generated tax invoice and does not require a signature.', left, fy, { width: pageW, align: 'center' })
    .text(t.seller.gstin
      ? 'Tax charged under the Central/State GST Acts as applicable.'
      : 'GST will be charged once the company GSTIN is active.', left, fy + 12, { width: pageW, align: 'center' })
    .text('NamastePOS · namastepos.in', left, fy + 28, { width: pageW, align: 'center' });

  doc.end();
}

module.exports = { renderPdf, loadInvoice, computeTax };
