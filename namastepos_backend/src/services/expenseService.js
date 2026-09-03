// NamastePOS backend - expense service

const { query } = require('../config/db');
const { NotFound } = require('../utils/errors');

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    category: row.category,
    amount: parseFloat(row.amount),
    description: row.description,
    date: row.date,
    receiptUrl: row.receipt_url,
    createdAt: row.created_at,
  };
}

async function create(businessId, body) {
  const { category = 'other', amount, description = null, date, receiptUrl = null } = body;
  const r = await query(
    `INSERT INTO expenses (business_id, category, amount, description, date, receipt_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [businessId, category, amount, description, date, receiptUrl]
  );
  return serialize(r.rows[0]);
}

// NP-128 (2026-09-03): the list had no LIMIT — a busy outlet's full expense
// history came back on every visit. Same LIMIT/OFFSET + COUNT(*) OVER()
// pattern as orderService.list: `.total` rides on the returned array so the
// controller can expose it without a second COUNT round-trip. Uses the
// existing idx_expenses_business_date (business_id, date) partial index.
async function list(businessId, { startDate, endDate, category, limit, offset = 0 } = {}) {
  // NP-128 review fix (HIGH): fielded mobile builds call this with NO limit
  // and SUM the rows for monthly P&L — a silent default LIMIT understates
  // expenses and OVERSTATES profit. Pagination therefore applies ONLY when
  // the client explicitly asks for it; legacy no-param calls get the full
  // window exactly as before. Tighten to a hard default only after the
  // mobile app paginates (Sprint 4 mobile-parity note).
  const where = ['business_id = $1', 'deleted_at IS NULL'];
  const values = [businessId];
  let idx = 2;
  if (startDate) { where.push(`date >= $${idx++}`); values.push(startDate); }
  if (endDate)   { where.push(`date <= $${idx++}`); values.push(endDate); }
  if (category)  { where.push(`category = $${idx++}`); values.push(category); }
  const paged = limit !== undefined && limit !== null;
  const pageSql = paged ? ` LIMIT $${idx++} OFFSET $${idx}` : '';
  const r = await query(
    `SELECT *, COUNT(*) OVER ()::int AS _total FROM expenses WHERE ${where.join(' AND ')}
     ORDER BY date DESC, created_at DESC${pageSql}`,
    paged ? [...values, limit, offset] : values
  );
  const rows = r.rows.map(serialize);
  rows.total = r.rows[0]?._total || 0;
  return rows;
}

async function softDelete(businessId, expenseId) {
  const r = await query(
    `UPDATE expenses SET deleted_at = NOW()
     WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [businessId, expenseId]
  );
  if (r.rowCount === 0) throw new NotFound('Expense not found');
  return { id: r.rows[0].id };
}

module.exports = { create, list, softDelete };
