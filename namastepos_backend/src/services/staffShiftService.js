// NamastePOS — Staff shifts + payroll CSV (FF-332).
//
// Clock-in / clock-out via the mobile app (staff role) or the
// dashboard (owner-side manual override for missed punches).
//
// Rate resolution:
//   1. Rate captured on shift row at clock-in (audit trail — never
//      overwritten if the owner changes the rate later)
//   2. Falls back to business_users.hourly_rate_inr
//   3. Falls back to monthly_salary_inr / 30 / 8 if hourly not set

const { query } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

async function _getEffectiveRate(businessId, userId) {
  const r = await query(
    `SELECT hourly_rate_inr, monthly_salary_inr
       FROM business_users
      WHERE business_id = $1 AND user_id = $2 LIMIT 1`,
    [businessId, userId]
  );
  const row = r.rows[0];
  if (!row) return 0;
  if (row.hourly_rate_inr) return parseFloat(row.hourly_rate_inr);
  if (row.monthly_salary_inr) return parseFloat(row.monthly_salary_inr) / 30 / 8;
  return 0;
}

async function clockIn(businessId, userId) {
  // Guard: don't double-clock. Existing open shift = return it.
  const open = await query(
    `SELECT * FROM staff_shifts
      WHERE business_id = $1 AND user_id = $2 AND clock_out_at IS NULL
      ORDER BY clock_in_at DESC LIMIT 1`,
    [businessId, userId]
  );
  if (open.rowCount > 0) return open.rows[0];
  const rate = await _getEffectiveRate(businessId, userId);
  const r = await query(
    `INSERT INTO staff_shifts
       (business_id, user_id, clock_in_at, hourly_rate_inr)
     VALUES ($1, $2, NOW(), $3) RETURNING *`,
    [businessId, userId, rate]
  );
  return r.rows[0];
}

async function clockOut(businessId, userId) {
  const open = await query(
    `SELECT * FROM staff_shifts
      WHERE business_id = $1 AND user_id = $2 AND clock_out_at IS NULL
      ORDER BY clock_in_at DESC LIMIT 1`,
    [businessId, userId]
  );
  if (open.rowCount === 0) throw new BadRequest('No open shift for this staff');
  const shift = open.rows[0];
  const r = await query(
    `UPDATE staff_shifts
        SET clock_out_at = NOW(),
            hours_worked = EXTRACT(EPOCH FROM (NOW() - clock_in_at)) / 3600.0
      WHERE id = $1 RETURNING *`,
    [shift.id]
  );
  return r.rows[0];
}

async function myOpenShift(businessId, userId) {
  const r = await query(
    `SELECT * FROM staff_shifts
      WHERE business_id = $1 AND user_id = $2 AND clock_out_at IS NULL
      ORDER BY clock_in_at DESC LIMIT 1`,
    [businessId, userId]
  );
  return r.rows[0] || null;
}

async function listForBusiness(businessId, { from, to } = {}) {
  const params = [businessId];
  const where = ['s.business_id = $1'];
  if (from) { params.push(from); where.push(`s.clock_in_at::date >= $${params.length}::date`); }
  if (to)   { params.push(to);   where.push(`s.clock_in_at::date <= $${params.length}::date`); }
  const r = await query(
    `SELECT s.*, u.display_name AS staff_name
       FROM staff_shifts s
  LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.clock_in_at DESC LIMIT 500`,
    params
  );
  return r.rows;
}

/**
 * Payroll CSV per month. One row per staff member with total hours
 * + gross pay. Ready to hand to a CA / bookkeeper.
 */
async function payrollCsv(businessId, month /* YYYY-MM */) {
  const r = await query(
    `SELECT u.display_name AS staff_name,
            u.phone,
            bu.role,
            COALESCE(SUM(s.hours_worked), 0)::float AS hours,
            AVG(s.hourly_rate_inr)::float          AS avg_rate,
            (COALESCE(SUM(s.hours_worked), 0) * AVG(s.hourly_rate_inr))::float AS gross_pay
       FROM business_users bu
       JOIN users u ON u.id = bu.user_id
  LEFT JOIN staff_shifts s ON s.user_id = bu.user_id
                          AND s.business_id = bu.business_id
                          AND DATE_TRUNC('month', s.clock_in_at)
                              = DATE_TRUNC('month', ($1::text || '-01')::date)
                          AND s.clock_out_at IS NOT NULL
      WHERE bu.business_id = $2
      GROUP BY u.id, u.display_name, u.phone, bu.role
      ORDER BY u.display_name`,
    [month, businessId]
  );
  const header = 'Name,Phone,Role,Hours worked,Hourly rate,Gross pay (₹)';
  const rows = r.rows.map((row) => [
    row.staff_name || '',
    row.phone || '',
    row.role || '',
    (row.hours || 0).toFixed(2),
    (row.avg_rate || 0).toFixed(2),
    (row.gross_pay || 0).toFixed(2),
  ].map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(','));
  return [header, ...rows].join('\n');
}

module.exports = { clockIn, clockOut, myOpenShift, listForBusiness, payrollCsv };
