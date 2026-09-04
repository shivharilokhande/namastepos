// P&L + Balance Sheet + Trial Balance (R19).
//
// 2026-08-25 (founder bug: "P&L showing zero despite 9 orders / ₹2000+"):
// profitAndLoss() no longer aggregates journal_entries — nothing in the POS
// ever posts journals (journalizeOrder below has ZERO callers), so the P&L
// was permanently zero while Reports → Daily showed real revenue. It now
// derives from orders/expenses via incomeStatementService — the exact same
// aggregation the working mobile Income Statement screen and the dashboard
// Reports page use — so all three surfaces agree. Trial balance and balance
// sheet still read journals (they have no orders-based equivalent) and stay
// zero until a journal-posting pipeline exists.

const { query, withTransaction } = require('../config/db');
const incomeStmt = require('./incomeStatementService');

// ── Chart of accounts seed ───────────────────────────────────────────────
const DEFAULT_COA = [
  { code: '1100', name: 'Cash on hand', kind: 'asset' },
  { code: '1110', name: 'Bank', kind: 'asset' },
  { code: '1200', name: 'Accounts receivable', kind: 'asset' },
  { code: '1400', name: 'Inventory', kind: 'asset' },
  { code: '2100', name: 'Accounts payable', kind: 'liability' },
  { code: '2200', name: 'GST payable', kind: 'liability' },
  { code: '3000', name: 'Owner equity', kind: 'equity' },
  { code: '4000', name: 'Sales revenue', kind: 'income' },
  { code: '4100', name: 'Service charge', kind: 'income' },
  { code: '5000', name: 'COGS', kind: 'expense' },
  { code: '5100', name: 'Rent', kind: 'expense' },
  { code: '5200', name: 'Utilities', kind: 'expense' },
  { code: '5300', name: 'Salaries', kind: 'expense' },
  { code: '5400', name: 'Marketing', kind: 'expense' },
  { code: '5900', name: 'Wastage', kind: 'expense' },
  { code: '5999', name: 'Other expense', kind: 'expense' },
];

async function seedCoa(businessId) {
  for (const a of DEFAULT_COA) {
    await query(
      `INSERT INTO accounts (business_id, code, name, kind)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [businessId, a.code, a.name, a.kind],
    );
  }
}

// ── Auto-journalize an order ─────────────────────────────────────────────
// WHY-comment 2026-08-25: this was meant to be called after an order is
// collected but was never wired into orderService — which is exactly why
// journal_entries stayed empty and the P&L read zero. Kept for the future
// journal module; profitAndLoss() below no longer depends on it.
async function journalizeOrder(businessId, orderId) {
  return withTransaction(async (client) => {
    const o = await client.query(
      `SELECT subtotal, tax, service_charge_paise, discount, total, payment_method
         FROM orders WHERE business_id = $1 AND id = $2`,
      [businessId, orderId],
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
      [businessId, orderId, 'Order collected'],
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
      [jeId, cashAccount, totalPaise, salesPaise, servicePaise, taxPaise],
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
    [businessId, asOfDate || new Date().toISOString().slice(0, 10)],
  );
  let totalDebit = 0; let
    totalCredit = 0;
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

// Display-only account codes for expense categories (COA-style so the
// dashboard's "code · name" rows keep their familiar shape). These are NOT
// GL postings — just stable labels for the derived numbers.
const PNL_EXPENSE_CODES = {
  fuel: '5210',
  labor: '5300',
  rent: '5100',
  utilities: '5200',
  packaging: '5220',
  marketing: '5400',
  maintenance: '5230',
  refund_cogs: '5240',
  other: '5999',
};

async function profitAndLoss(businessId, { startDate, endDate }) {
  // WHY 2026-08-25: derive from the SAME orders/expenses aggregation the
  // working income statement uses (IST date bucketing, non-cancelled orders,
  // expenses table incl. wastage + refund_cogs, ingredients+wastage folded
  // into COGS) instead of the never-populated journal_entries table. This
  // makes the Accounting P&L agree with Reports → Daily and the mobile
  // Income Statement screen, which already showed the founder's ₹2000+.
  const stmt = await incomeStmt.incomeStatement(businessId, { startDate, endDate });

  // Refunds reduce P&L revenue. They are NOT netted out of orders.total
  // (refundService only inserts a refunds row + a refund_cogs expense), so
  // subtract them here. order_id IS NOT NULL keeps platform-subscription
  // refunds (order_id NULL) out of the tenant's books; failed/cancelled
  // refunds never left the till so they don't count. Same IST bucketing as
  // the revenue query. Defensive try/catch like incomeStatementService —
  // older deployments may not have migration 051's order_id column.
  let refundsInr = 0;
  try {
    const r = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS p
         FROM refunds
        WHERE business_id = $1
          AND order_id IS NOT NULL
          AND status IN ('pending', 'processed')
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date`,
      [businessId, startDate, endDate],
    );
    refundsInr = Number(r.rows[0]?.p || 0) / 100;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pnl] refunds query failed (missing order_id column?):', e?.message);
  }

  // Income: net revenue (gross order totals minus GST collected — GST is a
  // pass-through, never the restaurant's income), then refunds as a
  // contra-revenue line so the founder can see why revenue shrank.
  // 2026-08-26: itemize membership / other income as its own P&L line so net
  // revenue is transparent (it was already inside netRevenue, just folded into
  // the sales line). Sales line = net revenue minus other income; each other-
  // income row (e.g. "Membership sales") is shown separately.
  const otherIncome = stmt.revenue.otherIncome || [];
  const otherIncomeTotal = otherIncome.reduce((s, r) => s + (r.amount || 0), 0);
  const income = [
    { code: '4000', name: 'Sales revenue (net of GST)', kind: 'income', amount_inr: stmt.revenue.netRevenue - otherIncomeTotal },
  ];
  let oiCode = 4010;
  for (const oi of otherIncome) {
    income.push({ code: String(oiCode++), name: oi.label || 'Other income', kind: 'income', amount_inr: oi.amount });
  }
  if (refundsInr > 0) {
    income.push({ code: '4090', name: 'Less: customer refunds', kind: 'income', amount_inr: -refundsInr });
  }

  // Expenses: COGS first (ingredients expense + wastage_log — already
  // de-duplicated inside incomeStatementService), then each operating
  // expense category with spend. Zero-spend categories are skipped so the
  // page isn't a wall of ₹0 rows.
  const expense = [
    { code: '5000', name: 'COGS (ingredients + wastage)', kind: 'expense', amount_inr: stmt.cogs.total },
  ];
  for (const e of stmt.operatingExpenses) {
    if (e.amount > 0) {
      expense.push({
        code: PNL_EXPENSE_CODES[e.category] || '5999',
        name: e.label,
        kind: 'expense',
        amount_inr: e.amount,
      });
    }
  }

  const totalIncome = income.reduce((s, x) => s + x.amount_inr, 0);
  const totalExpense = expense.reduce((s, x) => s + x.amount_inr, 0);
  return {
    income,
    expense,
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
  seedCoa,
  journalizeOrder,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  DEFAULT_COA,
};
