// NamastePOS — GSTR-1 / GSTR-3B CSV exports (FF-314).
//
// Outputs CSVs whose column order matches the GSTN's own filing
// template so a CA can drop the file into the return without
// remapping columns. We produce two files:
//
//   • GSTR-1  → outward supplies (all `tax_invoices` in the period,
//               one row per invoice × tax rate, as the GSTN B2B/B2C
//               sheets expect)
//   • GSTR-3B → aggregate: total taxable value + IGST + CGST + SGST
//               per rate bucket, plus a TOTAL row
//
// The dashboard has a "Download for CA" button that calls this and
// streams the CSV. Big cafes tend to file quarterly; small ones
// monthly — the export accepts any date range.
//
// 2026-09-05 (review #2, P1): rewritten against the REAL tax_invoices
// schema (migrations 037/046). The previous queries selected columns that
// never existed (issued_at, total_inr, customer_gstin, gst_pct,
// taxable_inr, businesses.state) so both endpoints 500'd on every call.
// Money lives in *_paise integers; the recipient is recipient_*; the rate
// is per LINE (tax_invoices.items JSON — {gstPct, lineTaxablePaise,
// cgstPaise, sgstPaise, igstPaise}), so rate buckets are derived from the
// frozen line items rather than an invoice-level column. Dates are bucketed
// in IST like taxInvoiceService.list — invoices are IST business documents.

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
const inr = (paise) => (Number(paise || 0) / 100).toFixed(2);

// One row per (invoice, rate) — the frozen `items` JSON is the source of
// truth for the split; the invoice header carries the value + parties.
const RATE_ROWS_SQL = `
  SELECT ti.id, ti.invoice_no, ti.invoice_date, ti.total_paise,
         ti.place_of_supply, ti.reverse_charge,
         ti.recipient_gstin, ti.recipient_name,
         COALESCE((li->>'gstPct')::numeric, 0)              AS rate,
         SUM(COALESCE((li->>'lineTaxablePaise')::bigint, 0))::bigint AS taxable_paise,
         SUM(COALESCE((li->>'cgstPaise')::bigint, 0))::bigint        AS cgst_paise,
         SUM(COALESCE((li->>'sgstPaise')::bigint, 0))::bigint        AS sgst_paise,
         SUM(COALESCE((li->>'igstPaise')::bigint, 0))::bigint        AS igst_paise
    FROM tax_invoices ti
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ti.items) = 'array' THEN ti.items ELSE '[]'::jsonb END
    ) AS li
   WHERE ti.business_id = $1
     AND (ti.invoice_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
     AND ti.status = 'issued'
   GROUP BY ti.id, ti.invoice_no, ti.invoice_date, ti.total_paise, ti.place_of_supply,
            ti.reverse_charge, ti.recipient_gstin, ti.recipient_name, rate`;

async function gstr1(businessId, fromStr, toStr) {
  // GSTN GSTR-1 minimum invoice columns:
  //   GSTIN/UIN of Recipient, Receiver Name, Invoice Number,
  //   Invoice date, Invoice Value, Place of Supply, Reverse Charge,
  //   Invoice Type, Rate, Taxable Value, Cess Amount.
  const r = await query(
    `${RATE_ROWS_SQL}
     ORDER BY ti.invoice_date, ti.invoice_no, rate`,
    [businessId, fromStr, toStr],
  );
  const rows = r.rows.map((x) => ({
    'GSTIN/UIN of Recipient': x.recipient_gstin || '',
    'Receiver Name': x.recipient_name || '',
    'Invoice Number': x.invoice_no,
    // DD-MM-YYYY in IST, matching the invoice_date bucketing above.
    'Invoice date': new Date(x.invoice_date).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    }).replace(/\//g, '-'),
    'Invoice Value': inr(x.total_paise),
    'Place of Supply': x.place_of_supply || '',
    'Reverse Charge': x.reverse_charge ? 'Y' : 'N',
    'Invoice Type': 'Regular',
    Rate: Number(x.rate).toFixed(2).replace(/\.00$/, ''),
    'Taxable Value': inr(x.taxable_paise),
    'Cess Amount': '0.00',
  }));
  const headers = [
    'GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number',
    'Invoice date', 'Invoice Value', 'Place of Supply', 'Reverse Charge',
    'Invoice Type', 'Rate', 'Taxable Value', 'Cess Amount',
  ];
  return toCsv(rows, headers);
}

async function gstr3b(businessId, fromStr, toStr) {
  // GSTR-3B summary (table 3.1(a) outward taxable supplies). One row per
  // tax-rate bucket + a totals row. Invoices = DISTINCT invoices at that rate.
  const r = await query(
    `SELECT rate,
            COUNT(DISTINCT id)::int      AS invoices,
            SUM(taxable_paise)::bigint   AS taxable_paise,
            SUM(cgst_paise)::bigint      AS cgst_paise,
            SUM(sgst_paise)::bigint      AS sgst_paise,
            SUM(igst_paise)::bigint      AS igst_paise
       FROM (${RATE_ROWS_SQL}) per_rate
      GROUP BY rate
      ORDER BY rate`,
    [businessId, fromStr, toStr],
  );
  const rows = r.rows.map((x) => ({
    Description: `Outward taxable @ ${Number(x.rate).toFixed(2).replace(/\.00$/, '')}%`,
    Invoices: x.invoices,
    'Taxable Value': inr(x.taxable_paise),
    IGST: inr(x.igst_paise),
    CGST: inr(x.cgst_paise),
    SGST: inr(x.sgst_paise),
  }));
  // Totals — summed in paise so the TOTAL row is exact, not float dust. The
  // invoice count is DISTINCT invoices (a two-slab bill is one invoice).
  const distinct = await query(
    `SELECT COUNT(DISTINCT id)::int AS n FROM (${RATE_ROWS_SQL}) per_rate`,
    [businessId, fromStr, toStr],
  );
  const t = r.rows.reduce((acc, x) => ({
    taxable: acc.taxable + Number(x.taxable_paise),
    igst: acc.igst + Number(x.igst_paise),
    cgst: acc.cgst + Number(x.cgst_paise),
    sgst: acc.sgst + Number(x.sgst_paise),
  }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  rows.push({
    Description: 'TOTAL',
    Invoices: distinct.rows[0]?.n || 0,
    'Taxable Value': inr(t.taxable),
    IGST: inr(t.igst),
    CGST: inr(t.cgst),
    SGST: inr(t.sgst),
  });
  return toCsv(rows, ['Description', 'Invoices', 'Taxable Value', 'IGST', 'CGST', 'SGST']);
}

module.exports = { gstr1, gstr3b };
