// NamastePOS backend — transaction-level detail reports (Push 15h).
//
// Three reports, each returning a flat list of transactions for a date
// range plus a totals block. Used by the Reports page's Income, Expense
// and Invoices tabs to render an on-screen register + drive PDF / XLSX
// / CSV exports (so the auditor sees the same rows that the owner sees).
//
//   incomeRegister(businessId, {startDate, endDate})
//     One row per non-cancelled order. Columns mirror what a GST auditor
//     wants for cross-checking against GSTR-1:
//       date, time, orderNo, source, customer, taxableValue, cgst, sgst,
//       igst, serviceCharge, discount, total, paymentMethod, status
//
//   expenseRegister(businessId, {startDate, endDate})
//     One row per expense entry. Columns:
//       date, category, description, amount, paymentMethod, vendor,
//       receiptUrl
//
//   invoiceRegister(businessId, {startDate, endDate, status?})
//     One row per tax_invoice. Columns:
//       invoiceNo, date, time, recipientName, recipientGstin, placeOfSupply,
//       taxable, cgst, sgst, igst, total, status

const { query } = require('../config/db');

// ── Letterhead helper (shared with the income statement) ────────────────
async function _letterhead(businessId) {
  try {
    const r = await query(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
    const b = r.rows[0] || {};
    return {
      id: b.id,
      name: b.name || '—',
      gstin: b.gstin,
      address: b.address,
      city: b.city,
      stateCode: b.state_code,
      phone: b.phone,
      email: b.email,
      logoUrl: b.logo_url,
    };
  } catch (_) {
    return { name: '—' };
  }
}

// ── Income register ─────────────────────────────────────────────────────
async function incomeRegister(businessId, { startDate, endDate }) {
  const business = await _letterhead(businessId);
  let rows = [];
  try {
    const r = await query(
      `SELECT id,
              order_no,
              COALESCE(source::text, 'unknown') AS source,
              status::text                       AS status,
              customer_name,
              customer_phone,
              COALESCE(subtotal, 0)              AS taxable,
              COALESCE(cgst, 0)                  AS cgst,
              COALESCE(sgst, 0)                  AS sgst,
              COALESCE(igst, 0)                  AS igst,
              COALESCE(service_charge_paise, 0)  AS service_paise,
              COALESCE(discount, 0)              AS discount,
              COALESCE(total, 0)                 AS total,
              payment_method,
              created_at
         FROM orders
        WHERE business_id = $1
          -- Bug fix (2026-08-30): bucket by IST date, matching every other
          -- money report. created_at is TIMESTAMPTZ stored UTC, so a bare
          -- ::date put 00:00–05:30 IST orders on the previous day and this
          -- report wouldn't foot against the Income Statement / Daily P&L.
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
          AND status <> 'cancelled'
        ORDER BY created_at DESC`,
      [businessId, startDate, endDate]
    );
    rows = r.rows.map((row) => ({
      id: row.id,
      orderNo: row.order_no,
      source: row.source,
      status: row.status,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      taxableValue: parseFloat(row.taxable),
      cgst: parseFloat(row.cgst),
      sgst: parseFloat(row.sgst),
      igst: parseFloat(row.igst),
      serviceCharge: parseFloat(row.service_paise) / 100,
      discount: parseFloat(row.discount),
      total: parseFloat(row.total),
      paymentMethod: row.payment_method,
      createdAt: row.created_at,
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeRegister] query failed:', e?.message);
  }

  const totals = rows.reduce((t, r) => ({
    orderCount:   t.orderCount + 1,
    taxableValue: t.taxableValue + r.taxableValue,
    cgst:         t.cgst + r.cgst,
    sgst:         t.sgst + r.sgst,
    igst:         t.igst + r.igst,
    serviceCharge: t.serviceCharge + r.serviceCharge,
    discount:     t.discount + r.discount,
    total:        t.total + r.total,
  }), { orderCount: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, serviceCharge: 0, discount: 0, total: 0 });

  return {
    meta: {
      business,
      period: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      currency: 'INR',
      reportType: 'income_register',
    },
    rows,
    totals,
  };
}

// ── Expense register ────────────────────────────────────────────────────
async function expenseRegister(businessId, { startDate, endDate }) {
  const business = await _letterhead(businessId);
  let rows = [];
  try {
    const r = await query(
      `SELECT id, category::text AS category, description,
              COALESCE(amount, 0) AS amount,
              date, receipt_url, created_at
         FROM expenses
        WHERE business_id = $1
          AND date >= $2::date
          AND date <= $3::date
          AND deleted_at IS NULL
        ORDER BY date DESC, created_at DESC`,
      [businessId, startDate, endDate]
    );
    rows = r.rows.map((row) => ({
      id: row.id,
      date: row.date,
      category: row.category,
      description: row.description,
      amount: parseFloat(row.amount),
      receiptUrl: row.receipt_url,
      createdAt: row.created_at,
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[expenseRegister] query failed:', e?.message);
  }

  // Aggregate by category for the summary footer
  const byCategory = {};
  let total = 0;
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + row.amount;
    total += row.amount;
  }
  const summary = Object.entries(byCategory)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    meta: {
      business,
      period: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      currency: 'INR',
      reportType: 'expense_register',
    },
    rows,
    summary,
    totals: { entryCount: rows.length, total },
  };
}

// ── Tax invoice register ────────────────────────────────────────────────
async function invoiceRegister(businessId, { startDate, endDate, status }) {
  const business = await _letterhead(businessId);
  let rows = [];
  try {
    const params = [businessId];
    const where = ['business_id = $1'];
    if (startDate) { params.push(startDate); where.push(`invoice_date::date >= $${params.length}::date`); }
    if (endDate)   { params.push(endDate);   where.push(`invoice_date::date <= $${params.length}::date`); }
    if (status)    { params.push(status);    where.push(`status = $${params.length}`); }
    const r = await query(
      `SELECT id, invoice_no, invoice_date, fy,
              recipient_name, recipient_gstin, place_of_supply,
              is_interstate, reverse_charge,
              subtotal_paise, cgst_paise, sgst_paise, igst_paise,
              total_paise, payment_method, payment_status,
              status, cancelled_at
         FROM tax_invoices
        WHERE ${where.join(' AND ')}
        ORDER BY invoice_date DESC`,
      params
    );
    rows = r.rows.map((row) => ({
      id: row.id,
      invoiceNo: row.invoice_no,
      invoiceDate: row.invoice_date,
      fy: row.fy,
      recipientName: row.recipient_name,
      recipientGstin: row.recipient_gstin,
      placeOfSupply: row.place_of_supply,
      isInterstate: row.is_interstate,
      reverseCharge: row.reverse_charge,
      taxableValue: parseFloat(row.subtotal_paise) / 100,
      cgst: parseFloat(row.cgst_paise) / 100,
      sgst: parseFloat(row.sgst_paise) / 100,
      igst: parseFloat(row.igst_paise) / 100,
      total: parseFloat(row.total_paise) / 100,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      status: row.status,
      cancelledAt: row.cancelled_at,
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[invoiceRegister] query failed (tax_invoices table missing?):', e?.message);
  }

  const issued = rows.filter((r) => r.status === 'issued');
  const totals = issued.reduce((t, r) => ({
    invoiceCount:  t.invoiceCount + 1,
    taxableValue:  t.taxableValue + r.taxableValue,
    cgst:          t.cgst + r.cgst,
    sgst:          t.sgst + r.sgst,
    igst:          t.igst + r.igst,
    total:         t.total + r.total,
  }), { invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  totals.cancelledCount = rows.length - issued.length;

  return {
    meta: {
      business,
      period: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      currency: 'INR',
      reportType: 'invoice_register',
    },
    rows,
    totals,
  };
}

module.exports = {
  incomeRegister,
  expenseRegister,
  invoiceRegister,
};
