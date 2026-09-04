// FX rates + multi-currency conversion (R14)

const { query } = require('../config/db');

async function getRate(baseCcy, quoteCcy, asOf) {
  if (baseCcy === quoteCcy) return 1;
  const r = await query(
    `SELECT rate FROM fx_rates
      WHERE base_ccy = $1 AND quote_ccy = $2 AND as_of_date <= $3
      ORDER BY as_of_date DESC LIMIT 1`,
    [baseCcy, quoteCcy, asOf || new Date().toISOString().slice(0, 10)],
  );
  if (r.rowCount === 0) return null;
  return parseFloat(r.rows[0].rate);
}

async function setRate(baseCcy, quoteCcy, rate) {
  await query(
    `INSERT INTO fx_rates (base_ccy, quote_ccy, rate, as_of_date)
     VALUES ($1, $2, $3, CURRENT_DATE)
     ON CONFLICT (base_ccy, quote_ccy, as_of_date) DO UPDATE SET rate = EXCLUDED.rate`,
    [baseCcy, quoteCcy, rate],
  );
}

async function convert(amount, fromCcy, toCcy) {
  const r = await getRate(fromCcy, toCcy);
  if (r === null) return null;
  return +(amount * r).toFixed(2);
}

module.exports = { getRate, setRate, convert };
