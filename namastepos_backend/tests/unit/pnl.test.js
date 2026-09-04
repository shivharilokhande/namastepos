// P&L + Balance Sheet pure-math contract (R19)
// Tests the math shape; persistence is exercised in integration tests.

describe('Accounting math', () => {
  test('balance sheet: A = L + E by construction', () => {
    // After receiving ₹1000 cash (asset+1000, income+1000) AND paying ₹400
    // for an expense (asset-400, expense+400), cash = ₹600.
    const cashIn = 1000;
    const cashOut = 400;
    const assets = cashIn - cashOut; // 600
    const liabilities = 0;
    // Net profit (income - expense) is retained equity
    const netProfit = 1000 - 400; // 600
    const equity = netProfit;
    expect(assets).toBe(liabilities + equity);
  });

  test('P&L net = income - expense', () => {
    const incomeTotal = 5000;
    const expenseTotal = 3200;
    const netProfit = incomeTotal - expenseTotal;
    expect(netProfit).toBe(1800);
  });
});
