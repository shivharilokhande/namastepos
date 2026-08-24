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

async function list(businessId, { startDate, endDate, category } = {}) {
  const where = ['business_id = $1', 'deleted_at IS NULL'];
  const values = [businessId];
  let idx = 2;
  if (startDate) { where.push(`date >= $${idx++}`); values.push(startDate); }
  if (endDate)   { where.push(`date <= $${idx++}`); values.push(endDate); }
  if (category)  { where.push(`category = $${idx++}`); values.push(category); }
  const r = await query(
    `SELECT * FROM expenses WHERE ${where.join(' AND ')}
     ORDER BY date DESC, created_at DESC`,
    values
  );
  return r.rows.map(serialize);
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
