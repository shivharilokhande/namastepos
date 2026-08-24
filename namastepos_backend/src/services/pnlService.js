// P&L + Balance Sheet + Trial Balance (R19) — double-entry from journal_entries.

const { query, withTransaction } = require('../config/db');

// ── Chart of accounts seed ───────────────────────────────────────────────
const DEFAULT_COA = [
  { code: '1100', name: 'Cash on hand',          kind: 'asset' },
  { code: '1110', name: 'Bank',                  kind: 'asset' },
  { code: '1200', name: 'Accounts receivable',   kind: 'asset' },
  { code: '1400', name: 'Inventory',             kind: 'asset' },
  { code: '2100', name: 'Accounts payable',      kind: 'liability' },
  { code: '2200', name: 'GST payable',           kind: 'liability' },
  { code: '3000', name: 'Owner equity',          kind: 'equity' },
  { code: '4000', name: 'Sales revenue',         kind: 'income' },
  { code: '4100', name: 'Service charge',        kind: 'income' },
  { code: '5000', name: 'COGS',                  kind: 'expense' },
  { code: '5100', name: 'Rent',                  kind: 'expense' },
  { code: '5200', name: 'Utilities',             kind: 'expense' },
  { code: '5300', name: 'Salaries',              kind: 'expense' },
  { code: '5400', name: 'Marketing',             kind: 'expense' },
  { code: '5900', name: 'Wastage',               kind: 'expense' },
  { code: '5999', name: 'Other expense',         kind: 'expense' },
];

async function seedCoa(businessId) {
  for (const a of DEFAULT_COA) {
    await query(
      `INSERT INTO accounts (business_id, code, name, kind)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [businessId, a.code, a.name, a.kind]
    );
  }
}

// ── Auto-journalize an order (call after order is collected) ─────────────
async function journalizeOrder(businessId, orderId) {
  return withTransaction(async (client) => {
    const o = await client.query(
      `SELECT subtotal, tax, service_charge_paise, discount, total, payment_method
         FROM orders WHERE business_id = $1 AND id = $2`,
      [businessId, orderId]
    );
    if (o.rowCount === 0) return;
    const order = o.rows[0];
    const totalPaise = Math.round(parseFloat(order.total) * 100);
    const taxPaise = Math.round(parseFloat(order.tax) * 100);
    const servicePaise = order.service_charge_paise || 0;
    const salesPaise = totalPaise - taxPaise - servicePaise;

    const je = await client.query(
      `INSERT INTO journal_entries (business_id, entry_date, ref_kind, ref_id, description)
       VALUES ($1, CURRENT_DATE, 'order', $2, $3) RETURNING id`,
      [businessId, orderId, `Order collected`]
    );
    const jeId = je.rows[0].id;

    const cashAccount = order.payment_method === 'cash' ? '1100' : '1110';
    // Debit: cash; Credit: sales + service + GST
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_code, debit_paise, credit_paise) VALUES
       ($1, $2, $3, 0),
       ($1, '4000', 0, $4),
       ($1, '4100', 0, $5),
       ($1, '2200', 0, $6)`,
      [jeId, cashAccount, totalPaise, salesPaise, servicePaise, taxPaise]
    );
  });
}

// ── Aggregations ─────────────────────────────────────────────────────────
async function trialBalance(businessId, asOfDate) {
  const r = await query(
    `SELECT a.code, a.name, a.kind,
            COALESCE(SUM(jl.debit_paise), 0)::bigint AS debit,
            COALESCE(SUM(jl.credit_paise), 0)::bigint AS credit
       FROM accounts a
  LEFT JOIN journal_lines jl ON jl.account_code = a.code
  LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE a.business_id = $1
        AND (je.business_id IS NULL OR je.business_id = $1)
        AND (je.entry_date IS NULL OR je.entry_date <= $2::date)
      GROUP BY a.code, a.name, a.kind
      ORDER BY a.code`,
    [businessId, asOfDate || new Date().toISOString().slice(0, 10)]
  );
  let totalDebit = 0, totalCredit = 0;
  const lines = r.rows.map((x) => {
    const balance = x.kind === 'asset' || x.kind === 'expense'
      ? Number(x.debit) - Number(x.credit)
      : Number(x.credit) - Number(x.debit);
    totalDebit += Number(x.debit);
    totalCredit += Number(x.credit);
    return { ...x, balance_inr: balance / 100 };
  });
  return { lines, totalDebitInr: totalDebit / 100, totalCreditInr: totalCredit / 100 };
}

async function profitAndLoss(businessId, { startDate, endDate }) {
  const r = await query(
    `SELECT a.code, a.name, a.kind,
            COALESCE(SUM(jl.debit_paise - jl.credit_paise), 0)::bigint AS net_paise
       FROM accounts a
  LEFT JOIN journal_lines jl ON jl.account_code = a.code
  LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE a.business_id = $1
        AND a.kind IN ('income','expense')
        AND (je.entry_date IS NULL OR (je.entry_date BETWEEN $2::date AND $3::date))
      GROUP BY a.code, a.name, a.kind
      ORDER BY a.code`,
    [businessId, startDate, endDate]
  );
  const income = r.rows.filter((x) => x.kind === 'income')
    .map((x) => ({ ...x, amount_inr: -Number(x.net_paise) / 100 }));
  const expense = r.rows.filter((x) => x.kind === 'expense')
    .map((x) => ({ ...x, amount_inr: Number(x.net_paise) / 100 }));
  const totalIncome = income.reduce((s, x) => s + x.amount_inr, 0);
  const totalExpense = expense.reduce((s, x) => s + x.amount_inr, 0);
  return {
    income, expense,
    totalIncomeInr: totalIncome,
    totalExpenseInr: totalExpense,
    netProfitInr: totalIncome - totalExpense,
  };
}

async function balanceSheet(businessId, asOfDate) {
  const tb = await trialBalance(businessId, asOfDate);
  const groups = { asset: [], liability: [], equity: [] };
  for (const l of tb.lines) {
    if (groups[l.kind]) groups[l.kind].push(l);
  }
  return {
    assets: groups.asset,
    liabilities: groups.liability,
    equity: groups.equity,
    totalAssets: groups.asset.reduce((s, x) => s + x.balance_inr, 0),
    totalLiabilities: groups.liability.reduce((s, x) => s + x.balance_inr, 0),
    totalEquity: groups.equity.reduce((s, x) => s + x.balance_inr, 0),
  };
}

module.exports = {
  seedCoa, journalizeOrder, trialBalance, profitAndLoss, balanceSheet,
  DEFAULT_COA,
};
