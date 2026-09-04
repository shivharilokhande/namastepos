// Retail vertical — barcodes, batches, vendors, PO/GRN, price lists,
// ledgers, cheques, quotations, warehouses (Sprints 9-10 / R-101 → R-210)

const { query, withTransaction } = require('../config/db');
const { NotFound, Conflict } = require('../utils/errors');

// ── Items ────────────────────────────────────────────────────────────────
async function listItems(businessId, { search, category } = {}) {
  const where = ['business_id = $1', 'is_active = TRUE'];
  const values = [businessId]; let idx = 2;
  if (search) { where.push(`(name ILIKE $${idx} OR EXISTS (SELECT 1 FROM retail_barcodes b WHERE b.retail_item_id = retail_items.id AND b.barcode = $${idx + 1}))`); values.push(`%${search}%`, search); idx += 2; }
  if (category) { where.push(`category = $${idx++}`); values.push(category); }
  const r = await query(
    `SELECT * FROM retail_items WHERE ${where.join(' AND ')} ORDER BY name`,
    values,
  );
  return r.rows;
}

async function createItem(businessId, body) {
  const r = await query(
    `INSERT INTO retail_items
       (business_id, name, category, unit, hsn_code, gst_pct,
        mrp_paise, default_price_paise, cost_paise, stock, reorder_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [businessId, body.name, body.category, body.unit || 'piece',
      body.hsnCode, body.gstPct || 18, body.mrpPaise,
      Math.round((body.priceInr || 0) * 100),
      body.costPaise, body.stock || 0, body.reorderLevel || 0],
  );
  return r.rows[0];
}

async function addBarcode(businessId, retailItemId, barcode, isPrimary = false) {
  try {
    await query(
      `INSERT INTO retail_barcodes (business_id, retail_item_id, barcode, is_primary)
       VALUES ($1, $2, $3, $4)`,
      [businessId, retailItemId, barcode, isPrimary],
    );
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Barcode already exists');
    throw err;
  }
}

async function findByBarcode(businessId, barcode) {
  const r = await query(
    `SELECT ri.* FROM retail_items ri
       JOIN retail_barcodes b ON b.retail_item_id = ri.id
      WHERE ri.business_id = $1 AND b.barcode = $2 LIMIT 1`,
    [businessId, barcode],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

// ── Bulk import (Excel/CSV) ──────────────────────────────────────────────
async function bulkImport(businessId, rows) {
  let created = 0; const errors = [];
  for (const row of rows) {
    try {
      await createItem(businessId, {
        name: row.name,
        category: row.category,
        unit: row.unit,
        hsnCode: row.hsn_code,
        gstPct: row.gst_pct,
        priceInr: row.price_inr,
        stock: row.stock,
      });
      created += 1;
    } catch (err) {
      errors.push({ row: row.name, error: err.message });
    }
  }
  return { created, errors };
}

// ── Vendors ─────────────────────────────────────────────────────────────
async function listVendors(businessId) {
  const r = await query(
    `SELECT * FROM vendors WHERE business_id = $1 AND is_active = TRUE
      ORDER BY name`,
    [businessId],
  );
  return r.rows;
}

async function createVendor(businessId, body) {
  const r = await query(
    `INSERT INTO vendors
       (business_id, name, contact_person, phone, email, address,
        gstin, payment_terms_days, credit_limit_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [businessId, body.name, body.contactPerson, body.phone, body.email,
      body.address, body.gstin, body.paymentTermsDays || 0,
      body.creditLimitInr ? Math.round(body.creditLimitInr * 100) : 0],
  );
  return r.rows[0];
}

// ── Purchase orders + GRN ───────────────────────────────────────────────
async function createPO(businessId, body, userId) {
  return withTransaction(async (client) => {
    const poNo = body.poNo || `PO-${Date.now()}`;
    const po = await client.query(
      `INSERT INTO purchase_orders
         (business_id, po_no, vendor_id, expected_on, notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [businessId, poNo, body.vendorId, body.expectedOn || null, body.notes, userId],
    );
    let total = 0;
    for (const l of body.lines || []) {
      const lineTotal = Math.round(l.qty * l.unitPriceInr * 100);
      total += lineTotal;
      await client.query(
        `INSERT INTO purchase_order_lines
           (po_id, retail_item_id, ingredient_id, description,
            qty_ordered, unit_price_paise, gst_pct, line_total_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [po.rows[0].id, l.retailItemId || null, l.ingredientId || null,
          l.description, l.qty, Math.round(l.unitPriceInr * 100),
          l.gstPct || 0, lineTotal],
      );
    }
    await client.query(
      'UPDATE purchase_orders SET total_paise = $1 WHERE id = $2',
      [total, po.rows[0].id],
    );
    return po.rows[0];
  });
}

async function receivePO(businessId, poId, body, userId) {
  return withTransaction(async (client) => {
    // S6 (security 2026-08-23): confirm the PO actually belongs to the caller's
    // business BEFORE writing anything. Previously poId + line.poLineId were
    // trusted from the request with no tenant scope, so a caller could receive
    // against another tenant's purchase order and corrupt their records.
    const po = await client.query(
      'SELECT id FROM purchase_orders WHERE id = $1 AND business_id = $2 LIMIT 1',
      [poId, businessId],
    );
    if (po.rowCount === 0) {
      const { NotFound } = require('../utils/errors');
      throw new NotFound('Purchase order not found');
    }
    const grnNo = body.grnNo || `GRN-${Date.now()}`;
    const grn = await client.query(
      `INSERT INTO goods_receipts
         (business_id, po_id, grn_no, received_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [businessId, poId, grnNo, userId || null, body.notes || null],
    );
    for (const line of body.lines || []) {
      // S6: every line must belong to THIS PO (which we just confirmed is the
      // caller's). Reject foreign/mismatched line ids instead of blindly writing.
      const own = await client.query(
        `SELECT retail_item_id FROM purchase_order_lines
          WHERE id = $1 AND po_id = $2 LIMIT 1`,
        [line.poLineId, poId],
      );
      if (own.rowCount === 0) {
        const { BadRequest } = require('../utils/errors');
        throw new BadRequest('Purchase-order line does not belong to this PO');
      }
      await client.query(
        `INSERT INTO goods_receipt_lines (grn_id, po_line_id, qty, batch_no, expires_on)
         VALUES ($1, $2, $3, $4, $5)`,
        [grn.rows[0].id, line.poLineId, line.qty, line.batchNo || null, line.expiresOn || null],
      );
      await client.query(
        `UPDATE purchase_order_lines
            SET qty_received = qty_received + $1
          WHERE id = $2 AND po_id = $3`,
        [line.qty, line.poLineId, poId],
      );
      // Pull retail_item_id from the (already tenant-verified) line.
      const ln = own;
      if (ln.rows[0]?.retail_item_id) {
        await client.query(
          `UPDATE retail_items SET stock = stock + $1
            WHERE business_id = $2 AND id = $3`,
          [line.qty, businessId, ln.rows[0].retail_item_id],
        );
        if (line.batchNo) {
          await client.query(
            `INSERT INTO retail_batches
               (business_id, retail_item_id, batch_no, qty, qty_remaining, expires_on)
             VALUES ($1, $2, $3, $4, $4, $5)
             ON CONFLICT (retail_item_id, batch_no) DO UPDATE
               SET qty = retail_batches.qty + EXCLUDED.qty,
                   qty_remaining = retail_batches.qty_remaining + EXCLUDED.qty`,
            [businessId, ln.rows[0].retail_item_id, line.batchNo, line.qty, line.expiresOn || null],
          );
        }
      }
    }
    // Update PO status
    const status = body.partial ? 'partial' : 'received';
    await client.query(
      'UPDATE purchase_orders SET status = $1 WHERE id = $2 AND business_id = $3',
      [status, poId, businessId],
    );
    return grn.rows[0];
  });
}

// ── Ledger ───────────────────────────────────────────────────────────────
async function postLedger(businessId, body) {
  // Calculates running balance via SUM(debit-credit) up to and including this row
  return withTransaction(async (client) => {
    const prior = await client.query(
      `SELECT COALESCE(SUM(debit_paise - credit_paise), 0)::int AS bal
         FROM ledger_entries
        WHERE business_id = $1 AND party_kind = $2 AND party_id = $3`,
      [businessId, body.partyKind, body.partyId],
    );
    const balanceAfter = prior.rows[0].bal + (body.debitPaise || 0) - (body.creditPaise || 0);
    const r = await client.query(
      `INSERT INTO ledger_entries
         (business_id, party_kind, party_id, entry_date, kind, ref_no,
          debit_paise, credit_paise, balance_after_paise, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [businessId, body.partyKind, body.partyId,
        body.entryDate || new Date(), body.kind, body.refNo || null,
        body.debitPaise || 0, body.creditPaise || 0, balanceAfter, body.note || null],
    );
    return r.rows[0];
  });
}

async function partyLedger(businessId, partyKind, partyId) {
  const r = await query(
    `SELECT * FROM ledger_entries
      WHERE business_id = $1 AND party_kind = $2 AND party_id = $3
      ORDER BY entry_date, created_at`,
    [businessId, partyKind, partyId],
  );
  return r.rows;
}

// ── Cheques ──────────────────────────────────────────────────────────────
async function recordCheque(businessId, body) {
  const r = await query(
    `INSERT INTO cheques
       (business_id, direction, party_kind, party_id, cheque_no,
        bank_name, amount_paise, cheque_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [businessId, body.direction, body.partyKind || null, body.partyId || null,
      body.chequeNo, body.bankName, Math.round(body.amountInr * 100),
      body.chequeDate, body.notes || null],
  );
  return r.rows[0];
}

async function updateChequeStatus(businessId, id, status, clearedOn = null) {
  const r = await query(
    `UPDATE cheques SET status = $1, cleared_on = $2
      WHERE business_id = $3 AND id = $4 RETURNING *`,
    [status, clearedOn, businessId, id],
  );
  if (r.rowCount === 0) throw new NotFound('Cheque not found');
  return r.rows[0];
}

// ── Price lists ─────────────────────────────────────────────────────────
async function createPriceList(businessId, name, isDefault = false) {
  const r = await query(
    'INSERT INTO price_lists (business_id, name, is_default) VALUES ($1, $2, $3) RETURNING *',
    [businessId, name, isDefault],
  );
  return r.rows[0];
}

async function setPriceListLine(priceListId, retailItemId, priceInr) {
  await query(
    `INSERT INTO price_list_lines (price_list_id, retail_item_id, price_paise)
     VALUES ($1, $2, $3)
     ON CONFLICT (price_list_id, retail_item_id) DO UPDATE
       SET price_paise = EXCLUDED.price_paise`,
    [priceListId, retailItemId, Math.round(priceInr * 100)],
  );
}

// ── Quotations ──────────────────────────────────────────────────────────
async function createQuotation(businessId, body) {
  // Auto-apply TDS/TCS once the base total is known. Rules are configured
  // per-business (e.g., TCS 0.1% > ₹50L turnover under sec 206C(1H)). We
  // append computed amounts as virtual lines and bake them into the total.
  const tdsTcs = require('./tdsTcsService');
  const rules = await tdsTcs.listRules(businessId);

  return withTransaction(async (client) => {
    const quoteNo = body.quoteNo || `Q-${Date.now()}`;
    let total = 0;
    const q = await client.query(
      `INSERT INTO quotations
         (business_id, quote_no, customer_id, customer_name, expires_on)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [businessId, quoteNo, body.customerId || null,
        body.customerName, body.expiresOn || null],
    );
    for (const l of body.lines || []) {
      const lineTotal = Math.round(l.qty * l.unitPriceInr * 100);
      total += lineTotal;
      await client.query(
        `INSERT INTO quotation_lines
           (quotation_id, retail_item_id, description, qty,
            unit_price_paise, gst_pct, line_total_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [q.rows[0].id, l.retailItemId || null, l.description,
          l.qty, Math.round(l.unitPriceInr * 100), l.gstPct || 0, lineTotal],
      );
    }

    // Compute TDS (deducted at source — buyer-side) and TCS (collected at
    // source — seller-side). For an invoice from us → buyer we typically
    // collect TCS; TDS is informational unless the customer asks to deduct.
    const baseInr = total / 100;
    const tcsLines = tdsTcs.compute({ kind: 'TCS', baseInr, rules });
    const tdsLines = tdsTcs.compute({ kind: 'TDS', baseInr, rules });
    let tcsPaise = 0; let
      tdsPaise = 0;
    for (const t of tcsLines) {
      tcsPaise += Math.round(t.amountInr * 100);
      await client.query(
        `INSERT INTO quotation_lines
           (quotation_id, description, qty, unit_price_paise, gst_pct, line_total_paise)
         VALUES ($1, $2, 1, $3, 0, $3)`,
        [q.rows[0].id, `TCS @ ${t.rate}% (${t.code})`, Math.round(t.amountInr * 100)],
      );
    }
    for (const t of tdsLines) {
      tdsPaise += Math.round(t.amountInr * 100);
    }

    const finalTotal = total + tcsPaise - tdsPaise;
    await client.query(
      'UPDATE quotations SET total_paise = $1 WHERE id = $2',
      [finalTotal, q.rows[0].id],
    );
    return { ...q.rows[0], total_paise: finalTotal, tcs_paise: tcsPaise, tds_paise: tdsPaise };
  });
}

// ── Warehouses ──────────────────────────────────────────────────────────
async function createWarehouse(businessId, body) {
  const r = await query(
    `INSERT INTO warehouses (business_id, code, name, address, is_default)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [businessId, body.code, body.name, body.address || null, body.isDefault === true],
  );
  return r.rows[0];
}

async function transferWarehouse(businessId, body) {
  const r = await query(
    `INSERT INTO warehouse_transfers
       (business_id, from_warehouse_id, to_warehouse_id, retail_item_id, qty)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [businessId, body.fromWarehouseId, body.toWarehouseId, body.retailItemId, body.qty],
  );
  return r.rows[0];
}

module.exports = {
  listItems,
  createItem,
  addBarcode,
  findByBarcode,
  bulkImport,
  listVendors,
  createVendor,
  createPO,
  receivePO,
  postLedger,
  partyLedger,
  recordCheque,
  updateChequeStatus,
  createPriceList,
  setPriceListLine,
  createQuotation,
  createWarehouse,
  transferWarehouse,
};
