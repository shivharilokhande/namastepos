// NamastePOS backend - GST / Indian tax compliance
//
// Generates the data required for:
//   - GSTR-1  (outward supplies — what we sold)
//   - GSTR-3B (summary — total taxable + IGST + CGST + SGST)
// In CSV form, ready to upload to the GSTN portal or hand to a CA.

const { query } = require('../config/db');
const settings = require('./settingsService');

function paiseToInr(p) { return p ? (p / 100) : 0; }

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows, headers) {
  const out = [headers.join(',')];
  for (const r of rows) {
    out.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  return out.join('\n');
}

/**
 * Fetches all paid invoices for the month. For each, breaks out:
 *   - GSTIN (customer's, if provided)
 *   - HSN code
 *   - Taxable value (subtotal)
 *   - IGST / CGST / SGST based on customer's place of supply vs platform's
 *   - Invoice total
 */
async function gstrSummary(month) {
  // month is 'YYYY-MM'
  const platformGstin = (await settings.get('platform.gstin')) || '';
  // First two chars of GSTIN = state code. If they match, it's intra-state (CGST+SGST).
  const platformState = platformGstin.slice(0, 2);

  const r = await query(
    `SELECT i.*, b.name AS business_name, b.gstin AS customer_gstin, b.city
       FROM invoices i
       JOIN businesses b ON b.id = i.business_id
      WHERE i.status = 'paid'
        AND i.paid_at >= ($1 || '-01')::date
        AND i.paid_at <  (($1 || '-01')::date + INTERVAL '1 month')
      ORDER BY i.paid_at ASC`,
    [month]
  );

  const rows = r.rows.map((inv) => {
    const subtotal = inv.subtotal_paise ?? Math.round(inv.amount_paise / 1.18);
    const tax     = inv.tax_paise ?? (inv.amount_paise - subtotal);
    const custState = (inv.customer_gstin || '').slice(0, 2);
    const intraState = custState && custState === platformState;
    const igst = intraState ? 0 : tax;
    const cgst = intraState ? tax / 2 : 0;
    const sgst = intraState ? tax / 2 : 0;
    return {
      invoice_number: inv.number || inv.id.slice(0, 8),
      invoice_date: inv.paid_at?.toISOString?.().slice(0, 10) || '',
      business: inv.business_name,
      customer_gstin: inv.customer_gstin || '',
      place_of_supply: inv.place_of_supply || inv.city || '',
      hsn_code: inv.hsn_code || '998314',
      subtotal_inr: paiseToInr(subtotal),
      tax_rate_pct: parseFloat(inv.tax_rate_pct || 18),
      igst_inr: paiseToInr(igst),
      cgst_inr: paiseToInr(cgst),
      sgst_inr: paiseToInr(sgst),
      total_inr: paiseToInr(inv.amount_paise),
    };
  });

  const totals = rows.reduce((acc, r) => ({
    invoices: acc.invoices + 1,
    subtotal: acc.subtotal + r.subtotal_inr,
    igst: acc.igst + r.igst_inr,
    cgst: acc.cgst + r.cgst_inr,
    sgst: acc.sgst + r.sgst_inr,
    total: acc.total + r.total_inr,
  }), { invoices: 0, subtotal: 0, igst: 0, cgst: 0, sgst: 0, total: 0 });

  return { month, platformGstin, rows, totals };
}

function gstr1Csv(summary) {
  return rowsToCsv(summary.rows, [
    'invoice_number', 'invoice_date', 'business', 'customer_gstin',
    'place_of_supply', 'hsn_code', 'subtotal_inr', 'tax_rate_pct',
    'igst_inr', 'cgst_inr', 'sgst_inr', 'total_inr',
  ]);
}

function gstr3bSummary(summary) {
  return {
    month: summary.month,
    platformGstin: summary.platformGstin,
    totalInvoices: summary.totals.invoices,
    totalTaxableValueInr: summary.totals.subtotal,
    totalIgstInr: summary.totals.igst,
    totalCgstInr: summary.totals.cgst,
    totalSgstInr: summary.totals.sgst,
    grandTotalInr: summary.totals.total,
  };
}

/**
 * Push 19d — HSN-wise summary required for GSTR-1 filing.
 * Aggregates the per-invoice rows by HSN code into one summary line.
 * GSTR-1 portal expects this in Table 12.
 */
function hsnSummary(summary) {
  const byHsn = new Map();
  for (const r of summary.rows) {
    const e = byHsn.get(r.hsn_code) || {
      hsn_code: r.hsn_code,
      uqc: 'NOS',         // unit qty code — services default
      total_quantity: 0,  // we don't track item-level qty at invoice level
      taxable_value: 0,
      igst: 0, cgst: 0, sgst: 0,
      total: 0,
      rate_pct: r.tax_rate_pct,
    };
    e.taxable_value += r.subtotal_inr;
    e.igst  += r.igst_inr;
    e.cgst  += r.cgst_inr;
    e.sgst  += r.sgst_inr;
    e.total += r.total_inr;
    byHsn.set(r.hsn_code, e);
  }
  return [...byHsn.values()].sort((a, b) => b.total - a.total);
}

/**
 * Push 19d — B2B (customer has GSTIN) vs B2C (no GSTIN) split.
 * GSTR-1 Tables 4 (B2B), 7 (B2C small ≤ ₹2.5L), 5 (B2C large > ₹2.5L
 * interstate).
 */
function b2bB2cSplit(summary) {
  const b2b = []; const b2c = [];
  for (const r of summary.rows) {
    if (r.customer_gstin) b2b.push(r);
    else b2c.push(r);
  }
  const sum = (rows) => rows.reduce((s, r) => s + r.total_inr, 0);
  const tax = (rows) => rows.reduce((s, r) => s + r.igst_inr + r.cgst_inr + r.sgst_inr, 0);
  return {
    b2b: {
      invoices: b2b.length,
      taxable: b2b.reduce((s, r) => s + r.subtotal_inr, 0),
      tax: tax(b2b),
      total: sum(b2b),
      rows: b2b,
    },
    b2c: {
      invoices: b2c.length,
      taxable: b2c.reduce((s, r) => s + r.subtotal_inr, 0),
      tax: tax(b2c),
      total: sum(b2c),
      rows: b2c,
    },
  };
}

module.exports = {
  gstrSummary, gstr1Csv, gstr3bSummary,
  hsnSummary, b2bB2cSplit,
};
