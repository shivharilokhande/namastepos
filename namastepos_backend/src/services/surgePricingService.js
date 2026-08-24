// Dynamic delivery surge pricing (F46) — time-of-day rules.

const { query } = require('../config/db');

async function currentSurge(businessId, when = new Date()) {
  // Fix (2026-08-23): rules are entered in IST wall-clock time — compute
  // "now" in IST regardless of server timezone (a UTC prod host was
  // 5h30m off, so rules never matched).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(when);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[get('weekday')] ?? when.getDay();
  const minute = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const r = await query(
    `SELECT * FROM surge_rules
      WHERE business_id = $1
        AND is_active = TRUE
        AND (day_of_week IS NULL OR day_of_week = $2)
        AND start_minute <= $3 AND end_minute >= $3
      ORDER BY multiplier DESC LIMIT 1`,
    [businessId, dow, minute]
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

async function applyToDeliveryFee(businessId, baseFeeInr) {
  const surge = await currentSurge(businessId);
  if (!surge) return { feeInr: baseFeeInr, surgeApplied: null };
  const multiplied = baseFeeInr * parseFloat(surge.multiplier);
  const final = multiplied + (surge.flat_extra_paise / 100);
  return { feeInr: +final.toFixed(2), surgeApplied: surge };
}

async function listRules(businessId) {
  const r = await query(
    `SELECT * FROM surge_rules WHERE business_id = $1 ORDER BY start_minute`,
    [businessId]
  );
  return r.rows;
}

async function createRule(businessId, body) {
  const r = await query(
    `INSERT INTO surge_rules
       (business_id, name, day_of_week, start_minute, end_minute,
        multiplier, flat_extra_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [businessId, body.name, body.dayOfWeek, body.startMinute, body.endMinute,
     body.multiplier, body.flatExtraPaise || 0]
  );
  return r.rows[0];
}

// Full CRUD (2026-08-23, founder: rules must be editable/deletable from
// app + dashboard, not create-only).
async function updateRule(businessId, ruleId, body) {
  const map = {
    name: 'name', dayOfWeek: 'day_of_week',
    startMinute: 'start_minute', endMinute: 'end_minute',
    multiplier: 'multiplier', flatExtraPaise: 'flat_extra_paise',
    isActive: 'is_active',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) { sets.push(`${col} = $${idx++}`); values.push(body[k]); }
  }
  if (sets.length === 0) return null;
  values.push(businessId, ruleId);
  const r = await query(
    `UPDATE surge_rules SET ${sets.join(', ')}
      WHERE business_id = $${idx++} AND id = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) {
    const { NotFound } = require('../utils/errors');
    throw new NotFound('Surge rule not found');
  }
  return r.rows[0];
}

async function deleteRule(businessId, ruleId) {
  const r = await query(
    `DELETE FROM surge_rules WHERE business_id = $1 AND id = $2 RETURNING id`,
    [businessId, ruleId]
  );
  if (r.rowCount === 0) {
    const { NotFound } = require('../utils/errors');
    throw new NotFound('Surge rule not found');
  }
  return { id: r.rows[0].id };
}

module.exports = {
  currentSurge, applyToDeliveryFee, listRules, createRule,
  updateRule, deleteRule,
};
