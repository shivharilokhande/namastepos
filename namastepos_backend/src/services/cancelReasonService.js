// NamastePOS — Cancel-reason picker (Sprint 1 / FF-503).

const { query } = require('../config/db');
const { BadRequest, Conflict } = require('../utils/errors');

function serialize(r) {
  return {
    id: r.id, code: r.code, label: r.label,
    displayOrder: r.display_order, isActive: r.is_active,
  };
}

async function list(businessId, { includeInactive = false } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId];
  if (!includeInactive) where.push('is_active = TRUE');
  const r = await query(
    `SELECT * FROM cancel_reasons WHERE ${where.join(' AND ')}
      ORDER BY display_order, label`,
    values
  );
  return r.rows.map(serialize);
}

async function create(businessId, body) {
  if (!body.code || !body.label) throw new BadRequest('code + label required');
  try {
    const r = await query(
      `INSERT INTO cancel_reasons (business_id, code, label, display_order)
       VALUES ($1, $2, $3, COALESCE($4, 100)) RETURNING *`,
      [businessId, body.code.toLowerCase(), body.label, body.displayOrder]
    );
    return serialize(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Code already exists');
    throw err;
  }
}

async function update(businessId, id, body) {
  const allowed = {
    label: 'label', displayOrder: 'display_order', isActive: 'is_active',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (body[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(body[k]); }
  }
  if (!sets.length) return null;
  values.push(businessId, id);
  await query(
    `UPDATE cancel_reasons SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx}`,
    values
  );
  return list(businessId);
}

async function validateCode(businessId, code) {
  const r = await query(
    `SELECT 1 FROM cancel_reasons
      WHERE business_id = $1 AND code = $2 AND is_active = TRUE LIMIT 1`,
    [businessId, code]
  );
  return r.rowCount > 0;
}

module.exports = { list, create, update, validateCode, serialize };
