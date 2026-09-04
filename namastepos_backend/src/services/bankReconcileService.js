// Bank reconciliation auto-match engine (R15)
// Matches imported bank lines to NamastePOS orders/invoices by amount + date proximity.

const { query, withTransaction } = require('../config/db');

async function importStatement(businessId, bankName, accountNo, rows) {
  let imported = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO bank_statements
         (business_id, bank_name, account_no, statement_date, reference,
          description, debit_paise, credit_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [businessId, bankName, accountNo, r.date, r.reference || null,
        r.description || null,
        Math.round((r.debit || 0) * 100),
        Math.round((r.credit || 0) * 100)],
    );
    imported += 1;
  }
  return { imported };
}

async function autoMatch(businessId) {
  // Match each unreconciled credit to an order with matching amount within 2 days.
  return withTransaction(async (client) => {
    const unmatched = await client.query(
      `SELECT * FROM bank_statements
        WHERE business_id = $1 AND is_reconciled = FALSE AND credit_paise > 0`,
      [businessId],
    );
    let matched = 0;
    for (const stmt of unmatched.rows) {
      const r = await client.query(
        `SELECT id FROM orders
          WHERE business_id = $1
            AND ROUND(total * 100) = $2
            AND payment_method IN ('upi','card','online')
            AND status = 'collected'
            AND ABS(EXTRACT(EPOCH FROM (created_at - $3::date))) < 86400 * 2
          ORDER BY created_at DESC LIMIT 1`,
        [businessId, stmt.credit_paise, stmt.statement_date],
      );
      if (r.rowCount > 0) {
        await client.query(
          `UPDATE bank_statements
              SET matched_to_kind = 'order',
                  matched_to_id = $1,
                  is_reconciled = TRUE
            WHERE id = $2`,
          [r.rows[0].id, stmt.id],
        );
        matched += 1;
      }
    }
    return { matched, totalUnmatched: unmatched.rowCount };
  });
}

async function listUnmatched(businessId) {
  const r = await query(
    `SELECT * FROM bank_statements
      WHERE business_id = $1 AND is_reconciled = FALSE
      ORDER BY statement_date DESC LIMIT 200`,
    [businessId],
  );
  return r.rows;
}

module.exports = { importStatement, autoMatch, listUnmatched };
