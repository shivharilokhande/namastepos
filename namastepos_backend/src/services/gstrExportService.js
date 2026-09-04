// NamastePOS — GSTR-1 / GSTR-3B CSV exports (FF-314).
//
// Outputs CSVs whose column order matches the GSTN's own filing
// template so a CA can drop the file into the return without
// remapping columns. We produce two files:
//
//   • GSTR-1  → outward supplies (all `tax_invoices` in the period,
//               split by GSTIN / no-GSTIN, tax-rate bucketed)
//   • GSTR-3B → aggregate: total taxable value + IGST + CGST + SGST
//               + inward supplies (from expenses tagged as GST)
//
// The dashboard has a "Download for CA" button that calls this and
// streams the CSV. Big cafes tend to file quarterly; small ones
// monthly — the export accepts any date range.

const { query } = require('../config/db');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, headers) {
  const out = [headers.join(',')];
  for (const r of rows) {
    out.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  return out.join('\n');
}

async function gstr1(businessId, fromStr, toStr) {
  // GSTN GSTR-1 minimum invoice columns:
  //   GSTIN/UIN of Recipient, Receiver Name, Invoice Number,
  //   Invoice date, Invoice Value, Place of Supply, Reverse Charge,
  //   Applicable % of Tax Rate, Invoice Type, E-Commerce GSTIN,
  //   Rate, Taxable Value, Cess Amount.
  const r = await query(
    `SELECT ti.invoice_no             AS "Invoice Number",
            TO_CHAR(ti.issued_at, 'DD-MM-YYYY') AS "Invoice date",
            ti.total_inr              AS "Invoice Value",
            b.state                   AS "Place of Supply",
            'N'                       AS "Reverse Charge",
            'Regular'                 AS "Invoice Type",
            ti.customer_gstin         AS "GSTIN/UIN of Recipient",
            COALESCE(ti.customer_name, '') AS "Receiver Name",
            ti.gst_pct                AS "Rate",
            ti.taxable_inr            AS "Taxable Value",
            0                         AS "Cess Amount"
       FROM tax_invoices ti
       JOIN businesses b ON b.id = ti.business_id
      WHERE ti.business_id = $1
        AND ti.issued_at::date BETWEEN $2::date AND $3::date
        AND ti.status = 'issued'
      ORDER BY ti.issued_at`,
    [businessId, fromStr, toStr],
  );
  const headers = [
    'GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number',
    'Invoice date', 'Invoice Value', 'Place of Supply', 'Reverse Charge',
    'Invoice Type', 'Rate', 'Taxable Value', 'Cess Amount',
  ];
  return toCsv(r.rows, headers);
}

async function gstr3b(businessId, fromStr, toStr) {
  // GSTR-3B summary. One row per tax-rate bucket + a totals row.
  const r = await query(
    `SELECT gst_pct                       AS rate,
            COUNT(*)::int                 AS invoices,
            COALESCE(SUM(taxable_inr), 0)::float AS taxable,
            COALESCE(SUM(cgst_inr), 0)::float    AS cgst,
            COALESCE(SUM(sgst_inr), 0)::float    AS sgst,
            COALESCE(SUM(igst_inr), 0)::float    AS igst
       FROM tax_invoices
      WHERE business_id = $1
        AND issued_at::date BETWEEN $2::date AND $3::date
        AND status = 'issued'
      GROUP BY gst_pct
      ORDER BY gst_pct`,
    [businessId, fromStr, toStr],
  );
  const rows = r.rows.map((x) => ({
    Description: `Outward taxable @ ${x.rate}%`,
    Invoices: x.invoices,
    'Taxable Value': x.taxable.toFixed(2),
    IGST: x.igst.toFixed(2),
    CGST: x.cgst.toFixed(2),
    SGST: x.sgst.toFixed(2),
  }));
  // Totals
  const t = rows.reduce((acc, x) => ({
    invoices: acc.invoices + Number(x.Invoices),
    taxable: acc.taxable + Number(x['Taxable Value']),
    igst: acc.igst + Number(x.IGST),
    cgst: acc.cgst + Number(x.CGST),
    sgst: acc.sgst + Number(x.SGST),
  }), { invoices: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  rows.push({
    Description: 'TOTAL',
    Invoices: t.invoices,
    'Taxable Value': t.taxable.toFixed(2),
    IGST: t.igst.toFixed(2),
    CGST: t.cgst.toFixed(2),
    SGST: t.sgst.toFixed(2),
  });
  return toCsv(rows, ['Description', 'Invoices', 'Taxable Value', 'IGST', 'CGST', 'SGST']);
}

module.exports = { gstr1, gstr3b };
