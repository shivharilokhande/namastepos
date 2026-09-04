// TDS / TCS auto-calculation (R12)

const { query } = require('../config/db');

async function listRules(businessId) {
  const r = await query(
    'SELECT * FROM tds_tcs_rules WHERE business_id = $1 AND is_active = TRUE',
    [businessId],
  );
  return r.rows;
}

async function upsertRule(businessId, body) {
  await query(
    `INSERT INTO tds_tcs_rules
       (business_id, kind, code, rate_pct, threshold_paise, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [businessId, body.kind, body.code, body.ratePct,
      body.thresholdInr ? Math.round(body.thresholdInr * 100) : null,
      body.description],
  );
}

// Apply TDS/TCS to an invoice amount. Returns line items to add.
function compute({ kind, baseInr, rules }) {
  const applicable = rules.filter((r) => r.kind === kind
    && (!r.threshold_paise || baseInr * 100 >= r.threshold_paise));
  return applicable.map((r) => ({
    code: r.code,
    description: r.description,
    rate: parseFloat(r.rate_pct),
    amountInr: +(baseInr * parseFloat(r.rate_pct) / 100).toFixed(2),
  }));
}

module.exports = { listRules, upsertRule, compute };
