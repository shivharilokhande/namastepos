// NamastePOS backend — Report + Invoice export renderers. Push 15d.
//
// Three formats per report:
//   - PDF   (pdfkit)    — printable, signed/stamped style
//   - XLSX  (exceljs)   — accountant-editable workbook
//   - CSV   (text)      — Tally / Zoho / spreadsheet import
//
// Two artifacts:
//   - Income statement (Schedule III-style P&L)
//   - GST Tax invoice  (Rule 46 compliant)
//
// Each exporter takes the JSON payload from incomeStatementService /
// taxInvoiceService and writes to the express `res` stream.

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// ── Helpers ─────────────────────────────────────────────────────────────

function _money(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return fmt.format(n);
}
function _csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // S7 (security 2026-08-23): CSV formula injection. Cells beginning with
  // = + - @ (or tab/CR) are executed as formulas by Excel/Sheets/LibreOffice.
  // Attacker-controlled fields (customer name/phone, expense description,
  // invoice recipient, etc.) flow into these exports. Neutralise by prefixing
  // a single quote so the spreadsheet treats the cell as literal text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ════════════════════════════════════════════════════════════════════════
//  INCOME STATEMENT
// ════════════════════════════════════════════════════════════════════════

function streamIncomeStatementCsv(res, p) {
  const filename = `pnl_${p.meta.period.startDate}_${p.meta.period.endDate}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const lines = [];
  lines.push(`Statement of Profit & Loss`);
  lines.push(`Name,${_csvEscape(p.meta.business.name)}`);
  if (p.meta.business.gstin) lines.push(`GSTIN,${_csvEscape(p.meta.business.gstin)}`);
  if (p.meta.business.address) lines.push(`Address,${_csvEscape(p.meta.business.address)}`);
  lines.push(`Period,${p.meta.period.startDate} to ${p.meta.period.endDate}`);
  lines.push(`Generated at,${p.meta.generatedAt}`);
  lines.push('');
  lines.push('Particulars,Amount (INR)');
  lines.push('I. Revenue from operations,');
  for (const r of p.revenue.fromOperations) {
    lines.push(`${_csvEscape('  ' + r.label)},${_money(r.grossValue)}`);
  }
  lines.push(`Gross revenue,${_money(p.revenue.grossRevenue)}`);
  lines.push(`Less: GST collected (pass-through liability),${_money(p.indirectTaxesCollected.total)}`);
  lines.push(`II. Net revenue,${_money(p.revenue.netRevenue)}`);
  lines.push('');
  lines.push('III. Cost of goods sold (COGS),');
  lines.push(`${_csvEscape('  Ingredients')},${_money(p.cogs.ingredients)}`);
  lines.push(`${_csvEscape('  Wastage')},${_money(p.cogs.wastage)}`);
  lines.push(`Total COGS,${_money(p.cogs.total)}`);
  lines.push('');
  lines.push(`IV. Gross profit (II - III),${_money(p.grossProfit)}`);
  lines.push('');
  lines.push('V. Operating expenses,');
  for (const e of p.operatingExpenses) {
    lines.push(`${_csvEscape('  ' + e.label)},${_money(e.amount)}`);
  }
  lines.push(`Total operating expenses,${_money(p.totalOperatingExpenses)}`);
  lines.push('');
  lines.push(`VI. EBITDA (IV - V),${_money(p.ebitda)}`);
  lines.push(`VII. Depreciation,${_money(p.depreciation)}`);
  lines.push(`VIII. Finance costs,${_money(p.financeCosts)}`);
  lines.push(`IX. Tax expense,${_money(p.taxExpense)}`);
  lines.push('');
  lines.push(`X. Net Profit / (Loss),${_money(p.netProfit)}`);
  lines.push(`Net margin %,${p.netMargin}`);
  lines.push('');
  lines.push('--- GST collected (memorandum) ---');
  lines.push(`CGST,${_money(p.indirectTaxesCollected.cgst)}`);
  lines.push(`SGST,${_money(p.indirectTaxesCollected.sgst)}`);
  lines.push(`IGST,${_money(p.indirectTaxesCollected.igst)}`);
  lines.push(`Total GST,${_money(p.indirectTaxesCollected.total)}`);

  res.end(lines.join('\n'));
}

async function streamIncomeStatementXlsx(res, p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NamastePOS';
  wb.created = new Date();

  const ws = wb.addWorksheet('P&L Statement');
  ws.columns = [
    { header: '', key: 'label', width: 50 },
    { header: 'Amount (INR)', key: 'amt', width: 18, style: { numFmt: '#,##,##0.00' } },
  ];

  // Header block
  ws.addRow(['Statement of Profit & Loss']);
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.addRow([p.meta.business.name]);
  if (p.meta.business.gstin) ws.addRow([`GSTIN: ${p.meta.business.gstin}`]);
  if (p.meta.business.address) ws.addRow([p.meta.business.address]);
  ws.addRow([`Period: ${p.meta.period.startDate} to ${p.meta.period.endDate}`]);
  ws.addRow([`Generated: ${new Date(p.meta.generatedAt).toLocaleString('en-IN')}`]);
  ws.addRow([]);

  const head = (title) => {
    const r = ws.addRow([title]);
    r.font = { bold: true };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  };
  const row = (label, amt, opts = {}) => {
    const r = ws.addRow({ label, amt });
    if (opts.bold) r.font = { bold: true };
    if (opts.indent) r.getCell('label').alignment = { indent: 2 };
    if (opts.divider) r.getCell('amt').border = { top: { style: 'thin' } };
  };

  head('I. Revenue from operations');
  for (const r of p.revenue.fromOperations) row(r.label, r.grossValue, { indent: true });
  row('Gross revenue', p.revenue.grossRevenue, { bold: true });
  row('Less: GST collected (pass-through liability)', p.indirectTaxesCollected.total);
  row('II. Net revenue', p.revenue.netRevenue, { bold: true, divider: true });
  ws.addRow([]);

  head('III. Cost of goods sold');
  row('Ingredients', p.cogs.ingredients, { indent: true });
  row('Wastage', p.cogs.wastage, { indent: true });
  row('Total COGS', p.cogs.total, { bold: true });
  ws.addRow([]);

  row('IV. Gross profit (II - III)', p.grossProfit, { bold: true });
  ws.addRow([]);

  head('V. Operating expenses');
  for (const e of p.operatingExpenses) row(e.label, e.amount, { indent: true });
  row('Total operating expenses', p.totalOperatingExpenses, { bold: true });
  ws.addRow([]);

  row('VI. EBITDA (IV - V)', p.ebitda, { bold: true });
  row('VII. Depreciation', p.depreciation);
  row('VIII. Finance costs', p.financeCosts);
  row('IX. Tax expense', p.taxExpense);
  ws.addRow([]);
  row('X. NET PROFIT / (LOSS)', p.netProfit, { bold: true, divider: true });
  row('Net margin %', p.netMargin);

  // GST memo sheet
  const gst = wb.addWorksheet('GST collected (memo)');
  gst.columns = [
    { header: 'Component', key: 'k', width: 24 },
    { header: 'Amount (INR)', key: 'v', width: 18, style: { numFmt: '#,##,##0.00' } },
  ];
  gst.getRow(1).font = { bold: true };
  gst.addRow({ k: 'CGST', v: p.indirectTaxesCollected.cgst });
  gst.addRow({ k: 'SGST', v: p.indirectTaxesCollected.sgst });
  gst.addRow({ k: 'IGST', v: p.indirectTaxesCollected.igst });
  const totalRow = gst.addRow({ k: 'Total GST collected', v: p.indirectTaxesCollected.total });
  totalRow.font = { bold: true };

  // Daily series sheet
  if (p.series && p.series.length > 0) {
    const day = wb.addWorksheet('Daily series');
    day.columns = [
      { header: 'Date', key: 'd', width: 14 },
      { header: 'Revenue', key: 'r', width: 16, style: { numFmt: '#,##,##0.00' } },
      { header: 'Expenses', key: 'e', width: 16, style: { numFmt: '#,##,##0.00' } },
      { header: 'Net', key: 'n', width: 16, style: { numFmt: '#,##,##0.00' } },
    ];
    day.getRow(1).font = { bold: true };
    for (const s of p.series) {
      day.addRow({ d: s.date, r: s.revenue, e: s.expenses, n: s.revenue - s.expenses });
    }
  }

  const filename = `pnl_${p.meta.period.startDate}_${p.meta.period.endDate}.xlsx`;
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

function streamIncomeStatementPdf(res, p) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const filename = `pnl_${p.meta.period.startDate}_${p.meta.period.endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  // Letterhead
  doc.font('Helvetica-Bold').fontSize(14).text(p.meta.business.name, { align: 'center' });
  doc.font('Helvetica').fontSize(9);
  if (p.meta.business.address) doc.text(p.meta.business.address, { align: 'center' });
  const line2 = [];
  if (p.meta.business.gstin) line2.push(`GSTIN: ${p.meta.business.gstin}`);
  if (p.meta.business.phone) line2.push(`Phone: ${p.meta.business.phone}`);
  if (p.meta.business.email) line2.push(p.meta.business.email);
  if (line2.length) doc.text(line2.join('  •  '), { align: 'center' });
  doc.moveDown(0.4);

  // Title
  doc.font('Helvetica-Bold').fontSize(13).text(
    'Statement of Profit & Loss', { align: 'center' });
  doc.font('Helvetica').fontSize(9).text(
    `(For the period ${p.meta.period.startDate} to ${p.meta.period.endDate})`,
    { align: 'center' });
  doc.moveDown(0.5);

  // Helpers for the two-col P&L table
  const startX = 50;
  const labelX = startX;
  const amountX = 480;
  const rowH = 14;

  function rule() {
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.2);
  }
  function r(label, amount, opts = {}) {
    const y = doc.y;
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9);
    doc.text((opts.indent ? '   ' : '') + label, labelX, y, { width: 410 });
    if (amount !== undefined && amount !== null) {
      const formatted = _money(amount);
      doc.text(formatted, amountX, y, { width: 80, align: 'right' });
    }
    doc.y = y + rowH;
  }
  function section(title) {
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(10);
    const y = doc.y;
    doc.rect(50, y - 2, 495, 14).fillAndStroke('#EEEEEE', '#CCCCCC');
    doc.fillColor('black').text(title, 56, y);
    doc.y = y + rowH;
    doc.font('Helvetica').fontSize(9);
  }

  // Header row
  doc.font('Helvetica-Bold').fontSize(10);
  r('PARTICULARS', undefined, { bold: true });
  doc.font('Helvetica-Bold').fontSize(10).text('AMOUNT (INR)', amountX, doc.y - rowH, { width: 80, align: 'right' });
  rule();

  section('I. Revenue from operations');
  for (const x of p.revenue.fromOperations) r(x.label, x.grossValue, { indent: true });
  r('Gross revenue', p.revenue.grossRevenue, { bold: true });
  r('Less: GST collected (pass-through liability)', p.indirectTaxesCollected.total);
  r('II. Net revenue', p.revenue.netRevenue, { bold: true });
  rule();

  section('III. Cost of goods sold (COGS)');
  r('Ingredients', p.cogs.ingredients, { indent: true });
  r('Wastage', p.cogs.wastage, { indent: true });
  r('Total COGS', p.cogs.total, { bold: true });
  rule();

  r('IV. Gross profit (II - III)', p.grossProfit, { bold: true });
  rule();

  section('V. Operating expenses');
  for (const e of p.operatingExpenses) r(e.label, e.amount, { indent: true });
  r('Total operating expenses', p.totalOperatingExpenses, { bold: true });
  rule();

  r('VI. EBITDA (IV - V)', p.ebitda, { bold: true });
  r('VII. Depreciation', p.depreciation);
  r('VIII. Finance costs', p.financeCosts);
  r('IX. Tax expense', p.taxExpense);
  rule();
  doc.moveDown(0.2);
  r('X. NET PROFIT / (LOSS)', p.netProfit, { bold: true, size: 11 });
  r('Net margin %', p.netMargin, { bold: true });
  rule();

  // GST memorandum
  doc.moveDown(0.6);
  section('GST collected — memorandum');
  r('CGST', p.indirectTaxesCollected.cgst);
  r('SGST', p.indirectTaxesCollected.sgst);
  r('IGST', p.indirectTaxesCollected.igst);
  r('Total GST collected', p.indirectTaxesCollected.total, { bold: true });

  // Footer
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#666666');
  doc.text(
    `Generated on ${new Date(p.meta.generatedAt).toLocaleString('en-IN')} by NamastePOS. ` +
    `This statement is prepared on an accrual basis from sales (orders) and expenses recorded in the system. ` +
    `Figures in INR. Subject to audit.`,
    50, doc.y, { width: 495, align: 'justify' }
  );
  doc.moveDown(2);
  doc.fillColor('black').fontSize(9);
  const signY = doc.y;
  doc.text('_________________________', 50, signY);
  doc.text('Authorised signatory', 50, signY + 14);
  doc.text('_________________________', 360, signY);
  doc.text('Auditor / Accountant', 360, signY + 14);

  doc.end();
}

// ════════════════════════════════════════════════════════════════════════
//  TAX INVOICE
// ════════════════════════════════════════════════════════════════════════

function streamTaxInvoicePdf(res, inv) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const filename = `tax_invoice_${inv.invoiceNo.replace(/[\/\\]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  // Top border
  doc.rect(36, 36, 523, 30).stroke();
  doc.font('Helvetica-Bold').fontSize(14).text('TAX INVOICE', 36, 44, {
    width: 523, align: 'center',
  });
  doc.fontSize(8).font('Helvetica').text(
    '(Per Rule 46 of CGST Rules, 2017)', 36, 60, { width: 523, align: 'center' });

  // Supplier block (left) + invoice meta (right)
  let y = 76;
  doc.rect(36, y, 523, 110).stroke();
  // Supplier
  doc.font('Helvetica-Bold').fontSize(10).text(inv.supplier.name, 44, y + 6);
  doc.font('Helvetica').fontSize(9);
  if (inv.supplier.address) doc.text(inv.supplier.address, 44, y + 22, { width: 280 });
  if (inv.supplier.gstin)   doc.text(`GSTIN: ${inv.supplier.gstin}`, 44, y + 56);
  if (inv.supplier.stateCode) doc.text(`State code: ${inv.supplier.stateCode}`, 44, y + 70);
  // Meta
  const rx = 340;
  doc.fontSize(9);
  doc.text(`Invoice No: `, rx, y + 6).font('Helvetica-Bold').text(inv.invoiceNo, rx + 70, y + 6);
  doc.font('Helvetica').text(`Date: `, rx, y + 22).font('Helvetica-Bold')
     .text(new Date(inv.invoiceDate).toLocaleString('en-IN'), rx + 70, y + 22);
  doc.font('Helvetica').text(`Place of supply: `, rx, y + 38).text(inv.placeOfSupply, rx + 100, y + 38);
  doc.text(`Reverse charge: `, rx, y + 52).text(inv.reverseCharge ? 'Yes' : 'No', rx + 100, y + 52);
  doc.text(`Payment: `, rx, y + 66).text(`${inv.paymentMethod || '-'} (${inv.paymentStatus})`, rx + 100, y + 66);
  doc.text(`FY: `, rx, y + 80).text(inv.fy, rx + 100, y + 80);

  // Recipient
  y = 190;
  doc.rect(36, y, 523, 70).stroke();
  doc.font('Helvetica-Bold').fontSize(10).text('Recipient (Bill to / Ship to)', 44, y + 6);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Name: ${inv.recipient.name || '-'}`, 44, y + 22);
  doc.text(`Phone: ${inv.recipient.phone || '-'}`, 44, y + 36);
  if (inv.recipient.gstin)   doc.text(`GSTIN: ${inv.recipient.gstin}`, 280, y + 22);
  if (inv.recipient.stateCode) doc.text(`State code: ${inv.recipient.stateCode}`, 280, y + 36);
  if (inv.recipient.address) doc.text(`Address: ${inv.recipient.address}`, 44, y + 50, { width: 480 });

  // Items table
  y = 268;
  const cols = [
    { x: 36,  w: 24,  title: '#' },
    { x: 60,  w: 170, title: 'Item' },
    { x: 230, w: 50,  title: 'HSN' },
    { x: 280, w: 30,  title: 'Qty' },
    { x: 310, w: 60,  title: 'Rate' },
    { x: 370, w: 60,  title: 'Taxable' },
    { x: 430, w: 32,  title: 'GST %' },
    { x: 462, w: 50,  title: 'GST Amt' },
    { x: 512, w: 47,  title: 'Total' },
  ];
  // Header row
  doc.rect(36, y, 523, 18).fillAndStroke('#EEEEEE', '#000000');
  doc.fillColor('black').font('Helvetica-Bold').fontSize(8);
  for (const c of cols) doc.text(c.title, c.x + 2, y + 4, { width: c.w - 4, align: 'left' });
  y += 18;
  doc.font('Helvetica').fontSize(8);

  inv.items.forEach((it, idx) => {
    const rowY = y;
    doc.rect(36, rowY, 523, 16).stroke();
    const data = [
      String(idx + 1),
      it.name,
      it.hsn,
      String(it.qty),
      _money((it.unitPricePaise || 0) / 100),
      _money((it.lineTaxablePaise || 0) / 100),
      `${it.gstPct || 0}%`,
      _money(((it.gstAmountPaise || 0)) / 100),
      _money((it.lineTotalPaise || 0) / 100),
    ];
    for (let i = 0; i < cols.length; i++) {
      doc.text(data[i], cols[i].x + 2, rowY + 4, {
        width: cols[i].w - 4,
        align: (i >= 3 && i !== 6) ? 'right' : 'left',
        ellipsis: true,
        height: 12,
      });
    }
    y += 16;
  });

  // Totals block
  doc.moveDown(0.5);
  y = doc.y;
  const tx = 360;
  const tw = 199;
  doc.rect(tx, y, tw, 130).stroke();
  function totRow(label, amt, bold = false) {
    if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.fontSize(9);
    doc.text(label, tx + 6, y + 6, { width: tw / 2 - 6 });
    doc.text(_money(amt), tx + tw / 2, y + 6, { width: tw / 2 - 6, align: 'right' });
    y += 14;
  }
  totRow('Subtotal (taxable)', inv.subtotalInr);
  totRow('Discount', -inv.discountInr);
  if (inv.isInterstate) {
    totRow('IGST', inv.igstInr);
  } else {
    totRow('CGST', inv.cgstInr);
    totRow('SGST', inv.sgstInr);
  }
  totRow('Service charge', inv.serviceChargeInr);
  totRow('Round-off', inv.roundOffInr);
  totRow('Total', inv.totalInr, true);

  // Amount in words below totals
  doc.font('Helvetica').fontSize(9).text(
    `Amount in words: ${inv.amountInWords}`, 36, y + 10, { width: 320 });

  // HSN summary
  y += 50;
  doc.font('Helvetica-Bold').fontSize(9).text('HSN-wise summary', 36, y);
  y += 14;
  doc.rect(36, y, 523, 16).fillAndStroke('#EEEEEE', '#000000');
  doc.fillColor('black').font('Helvetica-Bold').fontSize(8);
  doc.text('HSN', 40, y + 4, { width: 80 });
  doc.text('Taxable', 130, y + 4, { width: 70, align: 'right' });
  doc.text('CGST', 210, y + 4, { width: 60, align: 'right' });
  doc.text('SGST', 280, y + 4, { width: 60, align: 'right' });
  doc.text('IGST', 350, y + 4, { width: 60, align: 'right' });
  doc.text('Total', 420, y + 4, { width: 130, align: 'right' });
  y += 16;
  doc.font('Helvetica').fontSize(8);
  for (const h of (inv.hsnSummary || [])) {
    doc.rect(36, y, 523, 14).stroke();
    doc.text(h.hsn, 40, y + 3, { width: 80 });
    doc.text(_money(h.taxable / 100), 130, y + 3, { width: 70, align: 'right' });
    doc.text(_money(h.cgst / 100), 210, y + 3, { width: 60, align: 'right' });
    doc.text(_money(h.sgst / 100), 280, y + 3, { width: 60, align: 'right' });
    doc.text(_money(h.igst / 100), 350, y + 3, { width: 60, align: 'right' });
    doc.text(_money(h.total / 100), 420, y + 3, { width: 130, align: 'right' });
    y += 14;
  }

  // Footer / signature
  y = Math.max(y + 30, 720);
  doc.font('Helvetica').fontSize(8).fillColor('#666666');
  doc.text(
    'Declaration: We declare that this invoice shows the actual price of the goods/services described ' +
    'and that all particulars are true and correct.',
    36, y, { width: 523 });
  y += 30;
  doc.fillColor('black').fontSize(9);
  doc.text('_________________________', 380, y);
  doc.text(`For ${inv.supplier.name}`, 380, y + 14);
  doc.text('Authorised signatory', 380, y + 28);

  doc.end();
}

// ════════════════════════════════════════════════════════════════════════
//  DETAIL REGISTERS (Push 15h) — Income / Expense / Invoice
// ════════════════════════════════════════════════════════════════════════
//
// Each register has 3 exporters: CSV, XLSX, PDF. They all read from a
// single payload shape so on-screen and exported numbers always agree.

// ── helpers ─────────────────────────────────────────────────────────────
function _letterheadLines(meta) {
  const lines = [];
  if (meta?.business?.name) lines.push(meta.business.name);
  if (meta?.business?.address) lines.push(meta.business.address);
  const tail = [];
  if (meta?.business?.gstin) tail.push(`GSTIN: ${meta.business.gstin}`);
  if (meta?.business?.phone) tail.push(`Phone: ${meta.business.phone}`);
  if (meta?.business?.email) tail.push(meta.business.email);
  if (tail.length) lines.push(tail.join('  •  '));
  return lines;
}

function _pdfHeader(doc, meta, title) {
  doc.font('Helvetica-Bold').fontSize(13).text(
    meta.business?.name || '—', { align: 'center' });
  doc.font('Helvetica').fontSize(8.5);
  if (meta.business?.address) doc.text(meta.business.address, { align: 'center' });
  const tail = [];
  if (meta.business?.gstin) tail.push(`GSTIN: ${meta.business.gstin}`);
  if (meta.business?.phone) tail.push(`Phone: ${meta.business.phone}`);
  if (tail.length) doc.text(tail.join('  •  '), { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(12).text(title, { align: 'center' });
  doc.font('Helvetica').fontSize(8.5).text(
    `For the period ${meta.period.startDate} to ${meta.period.endDate}`,
    { align: 'center' }
  );
  doc.moveDown(0.5);
}

function _pdfFooter(doc, meta) {
  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text(
    `Generated on ${new Date(meta.generatedAt).toLocaleString('en-IN')} by NamastePOS. ` +
    `Figures in INR. Subject to audit.`,
    { width: doc.page.width - 72, align: 'justify' }
  );
  doc.fillColor('black');
}

// CSV row helper
function _csvLine(cells) { return cells.map(_csvEscape).join(','); }

// ── INCOME REGISTER ─────────────────────────────────────────────────────
function streamIncomeRegisterCsv(res, p) {
  const filename = `income_register_${p.meta.period.startDate}_${p.meta.period.endDate}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const lines = [];
  lines.push(`Income Register`);
  for (const l of _letterheadLines(p.meta)) lines.push(_csvLine([l]));
  lines.push(`Period,${p.meta.period.startDate} to ${p.meta.period.endDate}`);
  lines.push(`Generated at,${p.meta.generatedAt}`);
  lines.push('');
  lines.push(_csvLine([
    'Date', 'Time', 'Order #', 'Source', 'Customer', 'Phone',
    'Taxable (INR)', 'CGST', 'SGST', 'IGST', 'Service charge', 'Discount',
    'Total (INR)', 'Payment', 'Status',
  ]));
  for (const r of p.rows) {
    const d = new Date(r.createdAt);
    lines.push(_csvLine([
      d.toISOString().slice(0, 10),
      d.toISOString().slice(11, 19),
      r.orderNo || '',
      r.source || '',
      r.customerName || '',
      r.customerPhone || '',
      _money(r.taxableValue),
      _money(r.cgst), _money(r.sgst), _money(r.igst),
      _money(r.serviceCharge), _money(r.discount),
      _money(r.total),
      r.paymentMethod || '',
      r.status || '',
    ]));
  }
  lines.push('');
  lines.push(_csvLine([
    'TOTALS', '', '', '', '', '',
    _money(p.totals.taxableValue), _money(p.totals.cgst), _money(p.totals.sgst),
    _money(p.totals.igst), _money(p.totals.serviceCharge), _money(p.totals.discount),
    _money(p.totals.total), `${p.totals.orderCount} orders`, '',
  ]));
  res.end(lines.join('\n'));
}

async function streamIncomeRegisterXlsx(res, p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NamastePOS'; wb.created = new Date();
  const ws = wb.addWorksheet('Income Register');
  ws.columns = [
    { header: 'Date',       key: 'date',  width: 12 },
    { header: 'Time',       key: 'time',  width: 10 },
    { header: 'Order #',    key: 'no',    width: 12 },
    { header: 'Source',     key: 'src',   width: 12 },
    { header: 'Customer',   key: 'cust',  width: 22 },
    { header: 'Phone',      key: 'ph',    width: 14 },
    { header: 'Taxable',    key: 'tax',   width: 12, style: { numFmt: '#,##,##0.00' } },
    { header: 'CGST',       key: 'cgst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'SGST',       key: 'sgst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'IGST',       key: 'igst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'Service',    key: 'svc',   width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'Discount',   key: 'disc',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'Total',      key: 'tot',   width: 13, style: { numFmt: '#,##,##0.00' } },
    { header: 'Payment',    key: 'pay',   width: 12 },
    { header: 'Status',     key: 'st',    width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  for (const r of p.rows) {
    const d = new Date(r.createdAt);
    ws.addRow({
      date: d.toISOString().slice(0, 10),
      time: d.toISOString().slice(11, 19),
      no: r.orderNo, src: r.source, cust: r.customerName, ph: r.customerPhone,
      tax: r.taxableValue, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
      svc: r.serviceCharge, disc: r.discount, tot: r.total,
      pay: r.paymentMethod, st: r.status,
    });
  }
  const totalRow = ws.addRow({
    date: 'TOTALS', cust: `${p.totals.orderCount} orders`,
    tax: p.totals.taxableValue, cgst: p.totals.cgst, sgst: p.totals.sgst,
    igst: p.totals.igst, svc: p.totals.serviceCharge, disc: p.totals.discount,
    tot: p.totals.total,
  });
  totalRow.font = { bold: true };
  const filename = `income_register_${p.meta.period.startDate}_${p.meta.period.endDate}.xlsx`;
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res); res.end();
}

function streamIncomeRegisterPdf(res, p) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const filename = `income_register_${p.meta.period.startDate}_${p.meta.period.endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  _pdfHeader(doc, p.meta, 'INCOME REGISTER');

  const headers = ['Date', 'Order #', 'Source', 'Customer', 'Taxable', 'CGST', 'SGST', 'IGST', 'Svc', 'Disc', 'Total', 'Pay'];
  const widths  = [56,     50,        50,       110,        58,        42,    42,    42,    36,    36,    62,    44];
  const right = [false, false, false, false, true, true, true, true, true, true, true, false];

  function row(cells, opts = {}) {
    const y = doc.y;
    const rowH = 14;
    if (opts.bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.fontSize(7.5);
    if (opts.bg) doc.rect(30, y - 1, doc.page.width - 60, rowH).fill(opts.bg).fillColor('black');
    let x = 30;
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i] ?? '', x + 3, y + 2, {
        width: widths[i] - 6,
        align: right[i] ? 'right' : 'left',
        ellipsis: true,
        height: 12,
      });
      x += widths[i];
    }
    doc.y = y + rowH;
    doc.fillColor('black');
  }

  row(headers, { bold: true, bg: '#EEEEEE' });
  for (const r of p.rows) {
    if (doc.y > doc.page.height - 60) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
      row(headers, { bold: true, bg: '#EEEEEE' });
    }
    const d = new Date(r.createdAt);
    row([
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      String(r.orderNo || ''),
      r.source || '', (r.customerName || '—'),
      _money(r.taxableValue),
      _money(r.cgst), _money(r.sgst), _money(r.igst),
      _money(r.serviceCharge), _money(r.discount),
      _money(r.total), r.paymentMethod || '—',
    ]);
  }
  row(['TOTALS', `${p.totals.orderCount}`, '', '',
       _money(p.totals.taxableValue), _money(p.totals.cgst), _money(p.totals.sgst),
       _money(p.totals.igst), _money(p.totals.serviceCharge), _money(p.totals.discount),
       _money(p.totals.total), ''], { bold: true, bg: '#FFE0B2' });

  _pdfFooter(doc, p.meta);
  doc.end();
}

// ── EXPENSE REGISTER ────────────────────────────────────────────────────
function streamExpenseRegisterCsv(res, p) {
  const filename = `expense_register_${p.meta.period.startDate}_${p.meta.period.endDate}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const lines = [];
  lines.push(`Expense Register`);
  for (const l of _letterheadLines(p.meta)) lines.push(_csvLine([l]));
  lines.push(`Period,${p.meta.period.startDate} to ${p.meta.period.endDate}`);
  lines.push('');
  lines.push(_csvLine(['Date', 'Category', 'Description', 'Amount (INR)', 'Receipt']));
  for (const r of p.rows) {
    const d = r.date instanceof Date ? r.date : new Date(r.date);
    lines.push(_csvLine([
      d.toISOString ? d.toISOString().slice(0, 10) : String(r.date),
      r.category, r.description || '', _money(r.amount), r.receiptUrl || '',
    ]));
  }
  lines.push('');
  lines.push(_csvLine(['TOTAL', '', `${p.totals.entryCount} entries`, _money(p.totals.total), '']));
  lines.push('');
  lines.push('Category summary');
  lines.push(_csvLine(['Category', 'Amount (INR)']));
  for (const s of p.summary) lines.push(_csvLine([s.category, _money(s.amount)]));
  res.end(lines.join('\n'));
}

async function streamExpenseRegisterXlsx(res, p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NamastePOS'; wb.created = new Date();
  const ws = wb.addWorksheet('Expenses');
  ws.columns = [
    { header: 'Date',         key: 'date', width: 12 },
    { header: 'Category',     key: 'cat',  width: 16 },
    { header: 'Description',  key: 'desc', width: 40 },
    { header: 'Amount (INR)', key: 'amt',  width: 14, style: { numFmt: '#,##,##0.00' } },
    { header: 'Receipt',      key: 'rcpt', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of p.rows) {
    const d = r.date instanceof Date ? r.date : new Date(r.date);
    ws.addRow({
      date: d.toISOString ? d.toISOString().slice(0, 10) : String(r.date),
      cat: r.category, desc: r.description, amt: r.amount, rcpt: r.receiptUrl,
    });
  }
  const totalRow = ws.addRow({ date: 'TOTAL', desc: `${p.totals.entryCount} entries`, amt: p.totals.total });
  totalRow.font = { bold: true };

  // Category summary sheet
  const sum = wb.addWorksheet('Category summary');
  sum.columns = [
    { header: 'Category',     key: 'c', width: 18 },
    { header: 'Amount (INR)', key: 'a', width: 14, style: { numFmt: '#,##,##0.00' } },
  ];
  sum.getRow(1).font = { bold: true };
  for (const s of p.summary) sum.addRow({ c: s.category, a: s.amount });
  const tot = sum.addRow({ c: 'TOTAL', a: p.totals.total });
  tot.font = { bold: true };

  const filename = `expense_register_${p.meta.period.startDate}_${p.meta.period.endDate}.xlsx`;
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res); res.end();
}

function streamExpenseRegisterPdf(res, p) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const filename = `expense_register_${p.meta.period.startDate}_${p.meta.period.endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  _pdfHeader(doc, p.meta, 'EXPENSE REGISTER');

  const headers = ['Date', 'Category', 'Description', 'Amount (INR)'];
  const widths  = [70,     90,         260,           90];
  const right = [false, false, false, true];

  function row(cells, opts = {}) {
    const y = doc.y; const rowH = 14;
    if (opts.bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.fontSize(9);
    if (opts.bg) { doc.rect(42, y - 1, doc.page.width - 84, rowH).fill(opts.bg).fillColor('black'); }
    let x = 42;
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i] ?? '', x + 3, y + 2, {
        width: widths[i] - 6,
        align: right[i] ? 'right' : 'left',
        ellipsis: true, height: 12,
      });
      x += widths[i];
    }
    doc.y = y + rowH;
    doc.fillColor('black');
  }

  row(headers, { bold: true, bg: '#EEEEEE' });
  for (const r of p.rows) {
    if (doc.y > doc.page.height - 60) {
      doc.addPage({ size: 'A4', margin: 42 });
      row(headers, { bold: true, bg: '#EEEEEE' });
    }
    const d = r.date instanceof Date ? r.date : new Date(r.date);
    row([
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      r.category,
      r.description || '—',
      _money(r.amount),
    ]);
  }
  row(['TOTAL', `${p.totals.entryCount} entries`, '', _money(p.totals.total)], { bold: true, bg: '#FFE0B2' });

  // Category summary
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(11).text('Category summary');
  doc.moveDown(0.3);
  for (const s of p.summary) {
    row([s.category, '', '', _money(s.amount)]);
  }

  _pdfFooter(doc, p.meta);
  doc.end();
}

// ── INVOICE REGISTER ────────────────────────────────────────────────────
function streamInvoiceRegisterCsv(res, p) {
  const filename = `invoice_register_${p.meta.period.startDate}_${p.meta.period.endDate}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const lines = [];
  lines.push(`Tax Invoice Register`);
  for (const l of _letterheadLines(p.meta)) lines.push(_csvLine([l]));
  lines.push(`Period,${p.meta.period.startDate} to ${p.meta.period.endDate}`);
  lines.push('');
  lines.push(_csvLine([
    'Invoice No', 'Date', 'Recipient', 'GSTIN', 'Place of supply',
    'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Payment', 'Status',
  ]));
  for (const r of p.rows) {
    const d = new Date(r.invoiceDate);
    lines.push(_csvLine([
      r.invoiceNo,
      d.toISOString().replace('T', ' ').slice(0, 16),
      r.recipientName || '',
      r.recipientGstin || '',
      r.placeOfSupply || '',
      _money(r.taxableValue),
      _money(r.cgst), _money(r.sgst), _money(r.igst),
      _money(r.total),
      r.paymentMethod || '',
      r.status,
    ]));
  }
  lines.push('');
  lines.push(_csvLine([
    'TOTALS (issued only)', `${p.totals.invoiceCount}`, '', '', '',
    _money(p.totals.taxableValue), _money(p.totals.cgst), _money(p.totals.sgst),
    _money(p.totals.igst), _money(p.totals.total), '', '',
  ]));
  if (p.totals.cancelledCount > 0) {
    lines.push(_csvLine([`Cancelled: ${p.totals.cancelledCount}`]));
  }
  res.end(lines.join('\n'));
}

async function streamInvoiceRegisterXlsx(res, p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NamastePOS'; wb.created = new Date();
  const ws = wb.addWorksheet('Invoice Register');
  ws.columns = [
    { header: 'Invoice No',     key: 'no',    width: 18 },
    { header: 'Date',           key: 'date',  width: 18 },
    { header: 'Recipient',      key: 'rcp',   width: 22 },
    { header: 'GSTIN',          key: 'gstin', width: 18 },
    { header: 'Place of supply',key: 'pos',   width: 8 },
    { header: 'Taxable',        key: 'tax',   width: 12, style: { numFmt: '#,##,##0.00' } },
    { header: 'CGST',           key: 'cgst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'SGST',           key: 'sgst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'IGST',           key: 'igst',  width: 10, style: { numFmt: '#,##,##0.00' } },
    { header: 'Total',          key: 'tot',   width: 13, style: { numFmt: '#,##,##0.00' } },
    { header: 'Payment',        key: 'pay',   width: 10 },
    { header: 'Status',         key: 'st',    width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  for (const r of p.rows) {
    const d = new Date(r.invoiceDate);
    ws.addRow({
      no: r.invoiceNo,
      date: d.toISOString().replace('T', ' ').slice(0, 16),
      rcp: r.recipientName, gstin: r.recipientGstin, pos: r.placeOfSupply,
      tax: r.taxableValue, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
      tot: r.total, pay: r.paymentMethod, st: r.status,
    });
  }
  const totalRow = ws.addRow({
    no: 'TOTALS (issued only)', date: `${p.totals.invoiceCount} invoices`,
    tax: p.totals.taxableValue, cgst: p.totals.cgst, sgst: p.totals.sgst,
    igst: p.totals.igst, tot: p.totals.total,
  });
  totalRow.font = { bold: true };
  const filename = `invoice_register_${p.meta.period.startDate}_${p.meta.period.endDate}.xlsx`;
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res); res.end();
}

function streamInvoiceRegisterPdf(res, p) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const filename = `invoice_register_${p.meta.period.startDate}_${p.meta.period.endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  _pdfHeader(doc, p.meta, 'TAX INVOICE REGISTER');

  const headers = ['Invoice No', 'Date', 'Recipient', 'GSTIN', 'PoS', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Status'];
  const widths  = [88,           80,    132,         88,      28,    62,        42,    42,    42,    66,    52];
  const right = [false, false, false, false, false, true, true, true, true, true, false];

  function row(cells, opts = {}) {
    const y = doc.y; const rowH = 14;
    if (opts.bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.fontSize(7.5);
    if (opts.bg) { doc.rect(30, y - 1, doc.page.width - 60, rowH).fill(opts.bg).fillColor('black'); }
    let x = 30;
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i] ?? '', x + 3, y + 2, {
        width: widths[i] - 6, align: right[i] ? 'right' : 'left',
        ellipsis: true, height: 12,
      });
      x += widths[i];
    }
    doc.y = y + rowH;
    doc.fillColor('black');
  }

  row(headers, { bold: true, bg: '#EEEEEE' });
  for (const r of p.rows) {
    if (doc.y > doc.page.height - 60) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
      row(headers, { bold: true, bg: '#EEEEEE' });
    }
    const d = new Date(r.invoiceDate);
    row([
      r.invoiceNo,
      d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
      r.recipientName || '—',
      r.recipientGstin || '—',
      r.placeOfSupply || '—',
      _money(r.taxableValue),
      _money(r.cgst), _money(r.sgst), _money(r.igst),
      _money(r.total),
      r.status,
    ]);
  }
  row([
    `TOTALS (${p.totals.invoiceCount} issued)`, '', '', '', '',
    _money(p.totals.taxableValue),
    _money(p.totals.cgst), _money(p.totals.sgst), _money(p.totals.igst),
    _money(p.totals.total), p.totals.cancelledCount ? `${p.totals.cancelledCount} cancelled` : '',
  ], { bold: true, bg: '#FFE0B2' });

  _pdfFooter(doc, p.meta);
  doc.end();
}

module.exports = {
  streamIncomeStatementCsv,
  streamIncomeStatementXlsx,
  streamIncomeStatementPdf,
  streamTaxInvoicePdf,
  // Push 15h — register exports
  streamIncomeRegisterCsv, streamIncomeRegisterXlsx, streamIncomeRegisterPdf,
  streamExpenseRegisterCsv, streamExpenseRegisterXlsx, streamExpenseRegisterPdf,
  streamInvoiceRegisterCsv, streamInvoiceRegisterXlsx, streamInvoiceRegisterPdf,
};
