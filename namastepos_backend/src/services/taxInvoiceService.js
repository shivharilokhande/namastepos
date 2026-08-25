// NamastePOS backend — Tax Invoice (Rule 46) service. Push 15c.
//
// Issues one GST tax invoice per order with all mandatory fields per
// Rule 46 of the CGST Rules 2017. The invoice freezes the supplier
// snapshot, line items, GST split and HSN summary at the moment of
// issue, so subsequent edits to the menu or business profile don't
// retroactively alter what was billed.
//
// Numbering: sequential per business per financial year (Apr-Mar) as
// required for GST audit. Format: `INV/<FY>/<NNNNN>` — e.g.
// "INV/2526/00042".
//
// The dashboard + mobile call `issueFromOrder(businessId, orderId)`
// after an order is collected. `getById` + `list` are read paths.

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

// ── Helpers ──────────────────────────────────────────────────────────────

/** India FY runs Apr-1 → Mar-31. Returns short form '2526' for 2025-26. */
function _financialYear(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-11
  const fyStart = (m >= 3) ? y : y - 1;
  const fyEnd = fyStart + 1;
  return {
    label: `${fyStart}-${String(fyEnd).slice(-2)}`,   // '2025-26'
    short: `${String(fyStart).slice(-2)}${String(fyEnd).slice(-2)}`,   // '2526'
  };
}

/** Convert a paise integer to a rupees+paise words string (best-effort). */
function _amountInWords(paise) {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const words = _intToWords(rupees);
  const tail = p > 0 ? ` and ${_intToWords(p)} Paise` : '';
  return `Rupees ${words}${tail} only`;
}

function _intToWords(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
             'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
             'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  if (n === 0) return 'Zero';
  function hundred(x) {
    let s = '';
    if (x >= 100) { s += a[Math.floor(x / 100)] + ' Hundred '; x %= 100; }
    if (x >= 20) { s += b[Math.floor(x / 10)] + ' '; x %= 10; }
    if (x > 0) s += a[x] + ' ';
    return s.trim();
  }
  if (n < 1000) return hundred(n);
  let result = '';
  if (n >= 10000000) { result += hundred(Math.floor(n / 10000000)) + ' Crore '; n %= 10000000; }
  if (n >= 100000) { result += hundred(Math.floor(n / 100000)) + ' Lakh '; n %= 100000; }
  if (n >= 1000) { result += hundred(Math.floor(n / 1000)) + ' Thousand '; n %= 1000; }
  if (n > 0) result += hundred(n);
  return result.trim();
}

/** State code parsed from a GSTIN — first 2 chars. Falls back to null. */
function _stateFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

/**
 * Build the line items + HSN summary from the order's order_items.
 * The order_items table already has gst_pct + gst_amount per line; we
 * freeze that here so the printed invoice is reproducible.
 */
function _buildItemsAndHsn(orderItemRows, isInterstate) {
  const items = [];
  const hsnMap = new Map();
  for (const row of orderItemRows) {
    const qty = parseFloat(row.qty);
    const unitPaise = Math.round(parseFloat(row.price) * 100);
    const linePaise = qty * unitPaise;
    const gstPct = parseFloat(row.gst_pct || 0);
    const gstPaise = Math.round(parseFloat(row.gst_amount || 0) * 100);
    // Split CGST/SGST equally; or assign full to IGST for interstate
    const cgstPaise = isInterstate ? 0 : Math.floor(gstPaise / 2);
    const sgstPaise = isInterstate ? 0 : gstPaise - cgstPaise;
    const igstPaise = isInterstate ? gstPaise : 0;
    const hsn = (row.hsn || '').trim() || '996331';   // 996331 = restaurant service default

    items.push({
      name: row.name,
      hsn,
      qty,
      unitPricePaise: unitPaise,
      lineTaxablePaise: linePaise,
      gstPct,
      cgstPaise,
      sgstPaise,
      igstPaise,
      gstAmountPaise: gstPaise,
      lineTotalPaise: linePaise + gstPaise,
    });

    const e = hsnMap.get(hsn) || { hsn, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    e.taxable += linePaise;
    e.cgst += cgstPaise;
    e.sgst += sgstPaise;
    e.igst += igstPaise;
    e.total += linePaise + gstPaise;
    hsnMap.set(hsn, e);
  }
  return { items, hsn_summary: [...hsnMap.values()] };
}

// ── Numbering ────────────────────────────────────────────────────────────

/** Pull the next FY-sequence number atomically. */
async function _nextSeq(client, businessId, fyShort) {
  const r = await client.query(
    `SELECT COALESCE(MAX(fy_seq), 0) AS m
       FROM tax_invoices
      WHERE business_id = $1 AND fy = $2`,
    [businessId, fyShort]
  );
  return (parseInt(r.rows[0].m, 10) || 0) + 1;
}

function _formatInvoiceNo(fyShort, seq) {
  return `INV/${fyShort}/${String(seq).padStart(5, '0')}`;
}

// ── Issue ────────────────────────────────────────────────────────────────

/**
 * Issue a tax invoice for `orderId`. Idempotent: if an invoice already
 * exists for the order, returns the existing one instead of creating a
 * second. Always inside a transaction so the FY sequence stays gap-free.
 */
async function issueFromOrder(businessId, orderId, opts = {}) {
  return withTransaction(async (client) => {
    // Existing?
    const ex = await client.query(
      `SELECT * FROM tax_invoices WHERE order_id = $1`, [orderId]);
    if (ex.rowCount > 0) return _serialize(ex.rows[0]);

    // Pull order + items + business
    const oRes = await client.query(
      `SELECT o.*, b.name AS biz_name, b.gstin AS biz_gstin, b.address AS biz_address,
              b.state_code AS biz_state, b.phone AS biz_phone
         FROM orders o
         JOIN businesses b ON b.id = o.business_id
        WHERE o.id = $1 AND o.business_id = $2`,
      [orderId, businessId]
    );
    if (oRes.rowCount === 0) throw new NotFound('Order not found');
    const o = oRes.rows[0];

    const itemsRes = await client.query(
      `SELECT oi.*, mi.hsn_code AS hsn
         FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE oi.order_id = $1
        ORDER BY oi.id`,
      [orderId]
    );
    if (itemsRes.rowCount === 0) throw new BadRequest('Order has no items');

    // Resolve place_of_supply
    const placeOfSupply = opts.placeOfSupply
      || _stateFromGstin(opts.recipientGstin)
      || o.biz_state
      || '00';
    const isInterstate = !!(o.biz_state && placeOfSupply !== o.biz_state);

    const { items, hsn_summary } = _buildItemsAndHsn(itemsRes.rows, isInterstate);

    const subtotalPaise = items.reduce((s, i) => s + i.lineTaxablePaise, 0);
    const cgstPaise     = items.reduce((s, i) => s + i.cgstPaise, 0);
    const sgstPaise     = items.reduce((s, i) => s + i.sgstPaise, 0);
    const igstPaise     = items.reduce((s, i) => s + i.igstPaise, 0);
    const servicePaise  = parseInt(o.service_charge_paise, 10) || 0;
    const discountPaise = Math.round(parseFloat(o.discount || 0) * 100);
    const beforeRound = subtotalPaise + cgstPaise + sgstPaise + igstPaise + servicePaise - discountPaise;
    const totalPaise  = Math.round(beforeRound / 100) * 100;          // round to whole rupee
    const roundOff    = totalPaise - beforeRound;

    const fy = _financialYear(new Date());
    const fyShort = fy.short;
    const seq = await _nextSeq(client, businessId, fyShort);
    const invoiceNo = _formatInvoiceNo(fyShort, seq);

    // Build the QR code payload — the gov mandate is the e-invoice IRN
    // QR, but for ungated SMBs we still ship a self-describing payload
    // for the printout. (Real IRN/QR comes from einvoice_irns.)
    const qrPayload = JSON.stringify({
      sellerGstin: o.biz_gstin || null,
      buyerGstin: opts.recipientGstin || null,
      invoice: invoiceNo,
      date: new Date().toISOString().slice(0, 10),
      totalInr: totalPaise / 100,
    });

    const insert = await client.query(
      `INSERT INTO tax_invoices (
         business_id, order_id, invoice_no, fy, fy_seq, invoice_date,
         supplier_name, supplier_gstin, supplier_address, supplier_state_code,
         recipient_name, recipient_gstin, recipient_address, recipient_state_code, recipient_phone,
         place_of_supply, is_interstate, reverse_charge,
         subtotal_paise, discount_paise, cgst_paise, sgst_paise, igst_paise,
         service_charge_paise, round_off_paise, total_paise, amount_in_words,
         items, hsn_summary,
         payment_method, payment_status, paid_at,
         qr_code_payload, issued_by_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, NOW(),
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15, $16, $17,
         $18, $19, $20, $21, $22,
         $23, $24, $25, $26,
         $27, $28,
         $29, $30, $31,
         $32, $33
       ) RETURNING *`,
      [
        businessId, orderId, invoiceNo, fyShort, seq,
        o.biz_name, o.biz_gstin, o.biz_address, o.biz_state,
        opts.recipientName || o.customer_name, opts.recipientGstin || null,
        opts.recipientAddress || null, _stateFromGstin(opts.recipientGstin) || null,
        opts.recipientPhone || o.customer_phone,
        placeOfSupply, isInterstate, !!opts.reverseCharge,
        subtotalPaise, discountPaise, cgstPaise, sgstPaise, igstPaise,
        servicePaise, roundOff, totalPaise, _amountInWords(totalPaise),
        JSON.stringify(items), JSON.stringify(hsn_summary),
        o.payment_method, o.status === 'collected' ? 'paid' : 'unpaid',
        o.status === 'collected' ? new Date() : null,
        qrPayload, opts.issuedByUserId || null,
      ]
    );
    return _serialize(insert.rows[0]);
  });
}

/**
 * Issue ONE combined tax invoice for an entire table session (bug #5,
 * 2026-08-25). A dine-in visit fires several KOTs = several orders; the
 * customer must receive a single invoice covering all of them, issued at
 * settlement (payment collected + table released) — not one per KOT.
 *
 * Anchoring: the invoice row's order_id points at the session's HEAD
 * order (smallest order_no) which makes the flow idempotent — re-calling
 * for the same session returns the existing invoice. Items/discount/
 * service-charge aggregate across every non-cancelled order in the
 * session.
 */
async function issueFromSession(businessId, sessionId, opts = {}) {
  return withTransaction(async (client) => {
    const ordersRes = await client.query(
      `SELECT o.*, b.name AS biz_name, b.gstin AS biz_gstin, b.address AS biz_address,
              b.state_code AS biz_state, b.phone AS biz_phone
         FROM orders o
         JOIN businesses b ON b.id = o.business_id
        WHERE o.table_session_id = $1 AND o.business_id = $2
          AND o.status <> 'cancelled'
        ORDER BY o.order_no ASC`,
      [sessionId, businessId]
    );
    if (ordersRes.rowCount === 0) throw new NotFound('Session has no orders');
    const head = ordersRes.rows[0];

    // Single-order sessions take the plain path — same output, less code.
    if (ordersRes.rowCount === 1) {
      return issueFromOrderInTx(client, businessId, head.id, opts);
    }

    // Idempotency via the head order.
    const ex = await client.query(
      `SELECT * FROM tax_invoices WHERE order_id = $1 AND status = 'issued'`, [head.id]);
    if (ex.rowCount > 0) return _serialize(ex.rows[0]);

    const orderIds = ordersRes.rows.map((o) => o.id);
    const itemsRes = await client.query(
      `SELECT oi.*, mi.hsn_code AS hsn
         FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE oi.order_id = ANY($1)
        ORDER BY oi.id`,
      [orderIds]
    );
    if (itemsRes.rowCount === 0) throw new BadRequest('Session has no items');

    const placeOfSupply = opts.placeOfSupply
      || _stateFromGstin(opts.recipientGstin)
      || head.biz_state
      || '00';
    const isInterstate = !!(head.biz_state && placeOfSupply !== head.biz_state);

    const { items, hsn_summary } = _buildItemsAndHsn(itemsRes.rows, isInterstate);

    const subtotalPaise = items.reduce((s, i) => s + i.lineTaxablePaise, 0);
    const cgstPaise     = items.reduce((s, i) => s + i.cgstPaise, 0);
    const sgstPaise     = items.reduce((s, i) => s + i.sgstPaise, 0);
    const igstPaise     = items.reduce((s, i) => s + i.igstPaise, 0);
    // Aggregate across every order in the session (settle-time discounts
    // land on the head order, per-KOT discounts on their own orders).
    const servicePaise  = ordersRes.rows.reduce((s, o) => s + (parseInt(o.service_charge_paise, 10) || 0), 0);
    const discountPaise = ordersRes.rows.reduce((s, o) => s + Math.round(parseFloat(o.discount || 0) * 100), 0);
    const beforeRound = subtotalPaise + cgstPaise + sgstPaise + igstPaise + servicePaise - discountPaise;
    const totalPaise  = Math.round(beforeRound / 100) * 100;
    const roundOff    = totalPaise - beforeRound;

    const fy = _financialYear(new Date());
    const seq = await _nextSeq(client, businessId, fy.short);
    const invoiceNo = _formatInvoiceNo(fy.short, seq);

    const qrPayload = JSON.stringify({
      sellerGstin: head.biz_gstin || null,
      buyerGstin: opts.recipientGstin || null,
      invoice: invoiceNo,
      date: new Date().toISOString().slice(0, 10),
      totalInr: totalPaise / 100,
    });

    // Customer identity: first order in the session that captured one.
    const named = ordersRes.rows.find((o) => o.customer_name) || head;

    const insert = await client.query(
      `INSERT INTO tax_invoices (
         business_id, order_id, invoice_no, fy, fy_seq, invoice_date,
         supplier_name, supplier_gstin, supplier_address, supplier_state_code,
         recipient_name, recipient_gstin, recipient_address, recipient_state_code, recipient_phone,
         place_of_supply, is_interstate, reverse_charge,
         subtotal_paise, discount_paise, cgst_paise, sgst_paise, igst_paise,
         service_charge_paise, round_off_paise, total_paise, amount_in_words,
         items, hsn_summary,
         payment_method, payment_status, paid_at,
         qr_code_payload, issued_by_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, NOW(),
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15, $16, $17,
         $18, $19, $20, $21, $22,
         $23, $24, $25, $26,
         $27, $28,
         $29, $30, $31,
         $32, $33
       ) RETURNING *`,
      [
        businessId, head.id, invoiceNo, fy.short, seq,
        head.biz_name, head.biz_gstin, head.biz_address, head.biz_state,
        opts.recipientName || named.customer_name, opts.recipientGstin || null,
        opts.recipientAddress || null, _stateFromGstin(opts.recipientGstin) || null,
        opts.recipientPhone || named.customer_phone,
        placeOfSupply, isInterstate, !!opts.reverseCharge,
        subtotalPaise, discountPaise, cgstPaise, sgstPaise, igstPaise,
        servicePaise, roundOff, totalPaise, _amountInWords(totalPaise),
        JSON.stringify(items), JSON.stringify(hsn_summary),
        head.payment_method, 'paid', new Date(),
        qrPayload, opts.issuedByUserId || null,
      ]
    );
    return _serialize(insert.rows[0]);
  });
}

/**
 * Same as issueFromOrder but running on an EXISTING transaction client —
 * needed because issueFromSession already holds one and nesting
 * withTransaction would deadlock on a second pool client (2026-08-25).
 */
async function issueFromOrderInTx(client, businessId, orderId, opts = {}) {
  const ex = await client.query(
    `SELECT * FROM tax_invoices WHERE order_id = $1`, [orderId]);
  if (ex.rowCount > 0) return _serialize(ex.rows[0]);
  // Delegate the heavy lifting to issueFromOrder AFTER this tx? No —
  // simplest correct approach: rerun the same INSERT flow via the
  // standalone function once our surrounding tx commits is not possible
  // here, so we inline the single-order path by treating the order as a
  // one-order "session": the aggregation below degrades to identical
  // maths for a single order.
  const oRes = await client.query(
    `SELECT o.*, b.name AS biz_name, b.gstin AS biz_gstin, b.address AS biz_address,
            b.state_code AS biz_state, b.phone AS biz_phone
       FROM orders o JOIN businesses b ON b.id = o.business_id
      WHERE o.id = $1 AND o.business_id = $2`,
    [orderId, businessId]
  );
  if (oRes.rowCount === 0) throw new NotFound('Order not found');
  const o = oRes.rows[0];
  const itemsRes = await client.query(
    `SELECT oi.*, mi.hsn_code AS hsn
       FROM order_items oi
  LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  if (itemsRes.rowCount === 0) throw new BadRequest('Order has no items');

  const placeOfSupply = opts.placeOfSupply
    || _stateFromGstin(opts.recipientGstin) || o.biz_state || '00';
  const isInterstate = !!(o.biz_state && placeOfSupply !== o.biz_state);
  const { items, hsn_summary } = _buildItemsAndHsn(itemsRes.rows, isInterstate);
  const subtotalPaise = items.reduce((s, i) => s + i.lineTaxablePaise, 0);
  const cgstPaise = items.reduce((s, i) => s + i.cgstPaise, 0);
  const sgstPaise = items.reduce((s, i) => s + i.sgstPaise, 0);
  const igstPaise = items.reduce((s, i) => s + i.igstPaise, 0);
  const servicePaise = parseInt(o.service_charge_paise, 10) || 0;
  const discountPaise = Math.round(parseFloat(o.discount || 0) * 100);
  const beforeRound = subtotalPaise + cgstPaise + sgstPaise + igstPaise + servicePaise - discountPaise;
  const totalPaise = Math.round(beforeRound / 100) * 100;
  const roundOff = totalPaise - beforeRound;
  const fy = _financialYear(new Date());
  const seq = await _nextSeq(client, businessId, fy.short);
  const invoiceNo = _formatInvoiceNo(fy.short, seq);
  const qrPayload = JSON.stringify({
    sellerGstin: o.biz_gstin || null, buyerGstin: opts.recipientGstin || null,
    invoice: invoiceNo, date: new Date().toISOString().slice(0, 10),
    totalInr: totalPaise / 100,
  });
  const insert = await client.query(
    `INSERT INTO tax_invoices (
       business_id, order_id, invoice_no, fy, fy_seq, invoice_date,
       supplier_name, supplier_gstin, supplier_address, supplier_state_code,
       recipient_name, recipient_gstin, recipient_address, recipient_state_code, recipient_phone,
       place_of_supply, is_interstate, reverse_charge,
       subtotal_paise, discount_paise, cgst_paise, sgst_paise, igst_paise,
       service_charge_paise, round_off_paise, total_paise, amount_in_words,
       items, hsn_summary,
       payment_method, payment_status, paid_at,
       qr_code_payload, issued_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
       $29, $30, $31, $32, $33
     ) RETURNING *`,
    [
      businessId, orderId, invoiceNo, fy.short, seq,
      o.biz_name, o.biz_gstin, o.biz_address, o.biz_state,
      opts.recipientName || o.customer_name, opts.recipientGstin || null,
      opts.recipientAddress || null, _stateFromGstin(opts.recipientGstin) || null,
      opts.recipientPhone || o.customer_phone,
      placeOfSupply, isInterstate, !!opts.reverseCharge,
      subtotalPaise, discountPaise, cgstPaise, sgstPaise, igstPaise,
      servicePaise, roundOff, totalPaise, _amountInWords(totalPaise),
      JSON.stringify(items), JSON.stringify(hsn_summary),
      o.payment_method, o.status === 'collected' ? 'paid' : 'unpaid',
      o.status === 'collected' ? new Date() : null,
      qrPayload, opts.issuedByUserId || null,
    ]
  );
  return _serialize(insert.rows[0]);
}

async function getById(businessId, invoiceId) {
  const r = await query(
    `SELECT * FROM tax_invoices
      WHERE business_id = $1 AND id = $2`,
    [businessId, invoiceId]
  );
  if (r.rowCount === 0) throw new NotFound('Invoice not found');
  return _serialize(r.rows[0]);
}

async function list(businessId, { startDate, endDate, status, limit = 200 } = {}) {
  const params = [businessId];
  const where = ['business_id = $1'];
  // Timezone fix (2026-08-25): invoice_date is timestamptz; a bare ::date
  // cast buckets it by the SERVER's timezone (UTC in production), so an
  // invoice issued 00:30 IST landed in the previous day's filter range and
  // "today's invoices" looked wrong/missing to the owner. Invoices are IST
  // business documents — bucket the calendar-day filter in Asia/Kolkata.
  if (startDate) { params.push(startDate); where.push(`(invoice_date AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`); }
  if (endDate)   { params.push(endDate);   where.push(`(invoice_date AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`); }
  if (status)    { params.push(status);    where.push(`status = $${params.length}`); }
  params.push(limit);
  const r = await query(
    `SELECT * FROM tax_invoices
      WHERE ${where.join(' AND ')}
      ORDER BY invoice_date DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map(_serialize);
}

async function cancel(businessId, invoiceId, reason, userId) {
  const r = await query(
    `UPDATE tax_invoices
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_reason = $3,
            updated_at = NOW()
      WHERE business_id = $1 AND id = $2 AND status = 'issued'
      RETURNING *`,
    [businessId, invoiceId, reason || null]
  );
  if (r.rowCount === 0) throw new NotFound('Invoice not found or already cancelled');
  return _serialize(r.rows[0]);
}

// ── Serialisation ────────────────────────────────────────────────────────

function _serialize(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    orderId: row.order_id,

    invoiceNo: row.invoice_no,
    fy: row.fy,
    fySeq: row.fy_seq,
    invoiceDate: row.invoice_date,

    supplier: {
      name: row.supplier_name,
      gstin: row.supplier_gstin,
      address: row.supplier_address,
      stateCode: row.supplier_state_code,
    },
    recipient: {
      name: row.recipient_name,
      gstin: row.recipient_gstin,
      address: row.recipient_address,
      stateCode: row.recipient_state_code,
      phone: row.recipient_phone,
    },
    placeOfSupply: row.place_of_supply,
    isInterstate: row.is_interstate,
    reverseCharge: row.reverse_charge,

    subtotalInr: row.subtotal_paise / 100,
    discountInr: row.discount_paise / 100,
    cgstInr: row.cgst_paise / 100,
    sgstInr: row.sgst_paise / 100,
    igstInr: row.igst_paise / 100,
    cessInr: row.cess_paise / 100,
    serviceChargeInr: row.service_charge_paise / 100,
    roundOffInr: row.round_off_paise / 100,
    totalInr: row.total_paise / 100,
    amountInWords: row.amount_in_words,

    items: row.items || [],
    hsnSummary: row.hsn_summary || [],

    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    paidAt: row.paid_at,

    irn: row.irn,
    qrCodePayload: row.qr_code_payload,

    status: row.status,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    notes: row.notes,
    issuedByUserId: row.issued_by_user_id,

    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  issueFromOrder, issueFromSession, getById, list, cancel,
  _financialYear, _formatInvoiceNo, _amountInWords,   // exported for tests
};
