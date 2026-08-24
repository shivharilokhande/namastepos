// NamastePOS backend — Schedule III–style Income Statement (Push 15b).
//
// Builds a Profit & Loss / Income statement for a date range in a shape
// that's compatible with India's Companies Act 2013 Schedule III (Part II)
// reporting plus the income/expense detail a restaurant owner needs
// day-to-day.
//
// Sister to the existing pnlService.js which is the future journal-entry
// based version (depends on accounts/journal_lines being populated). This
// service queries orders + expenses + wastage directly so every business
// — even those that never enabled the accounting module — gets a usable
// income statement.
//
// Returned payload (camelCase):
//   meta:
//     business { id, name, gstin, address, city, stateCode, phone, email, logoUrl }
//     period { startDate, endDate }
//     generatedAt, currency, capabilities { ... }
//   revenue:
//     fromOperations[] grouped by source — { source, label, orderCount,
//       taxableValue, grossValue }
//     otherIncome[] (empty for now)
//     grossRevenue, taxableRevenue, netRevenue (gross minus GST)
//   indirectTaxesCollected: { cgst, sgst, igst, total }
//   cogs: { total, ingredients, wastage }
//   grossProfit
//   operatingExpenses[] (one row per expense_category enum, ingredients
//     excluded because it lives in COGS)
//   totalOperatingExpenses
//   ebitda, depreciation, financeCosts, taxExpense (zeros until journal
//     module is enabled)
//   netProfit, netMargin
//   series[] for the daily chart
//
// All four exports (JSON / PDF / XLSX / CSV) call this single aggregator
// so numbers always agree across formats.

const { query } = require('../config/db');

const EXPENSE_CATEGORIES = [
  'ingredients', 'fuel', 'labor', 'rent', 'utilities', 'packaging',
  'marketing', 'maintenance', 'refund_cogs', 'other',
];

const EXPENSE_LABELS = {
  ingredients: 'Ingredients & raw material',
  fuel: 'Fuel & gas',
  labor: 'Employee benefits (salaries, wages)',
  rent: 'Rent & lease',
  utilities: 'Utilities (electricity, water, internet)',
  packaging: 'Packaging material',
  marketing: 'Marketing & promotion',
  maintenance: 'Repairs & maintenance',
  refund_cogs: 'Refunded prepared-food cost',
  other: 'Miscellaneous operating expenses',
};

const REVENUE_SOURCE_LABELS = {
  dine_in: 'Dine-in sales',
  takeaway: 'Takeaway sales',
  online: 'Online / direct delivery',
  aggregator: 'Aggregator (Zomato/Swiggy)',
  pos: 'POS sales',
  walk_in: 'Walk-in / counter',
  qr: 'QR ordering',
  unknown: 'Other revenue',
};

/** Build the income statement for a date range (inclusive YYYY-MM-DD). */
async function incomeStatement(businessId, { startDate, endDate }) {
  // 0. Business letterhead. Use SELECT * so we don't crash on older
  //    deployments that haven't applied migrations 015/017 yet (state_code,
  //    logo_url etc.). Falls back to undefined for missing keys.
  let biz = { name: '—' };
  try {
    const bizRow = await query(
      'SELECT * FROM businesses WHERE id = $1',
      [businessId],
    );
    if (bizRow.rowCount > 0) biz = bizRow.rows[0];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] business letterhead query failed:', e?.message);
  }

  // 1. Revenue from operations — by source. Defensive: if `source` column
  //    isn't on this deployment (or has unknown enum values), the COALESCE
  //    surfaces 'unknown' and groups everything there rather than crashing.
  let fromOperations = [];
  try {
    const rev = await query(
      `SELECT COALESCE(source::text, 'unknown') AS source,
              COALESCE(SUM(subtotal), 0) AS taxable,
              COALESCE(SUM(total),    0) AS gross,
              COUNT(*)                   AS order_count
         FROM orders
        WHERE business_id = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
          AND status <> 'cancelled'
        GROUP BY COALESCE(source::text, 'unknown')
        ORDER BY gross DESC`,
      [businessId, startDate, endDate],
    );
    fromOperations = rev.rows.map((r) => ({
      source: r.source,
      label: REVENUE_SOURCE_LABELS[r.source] || r.source,
      orderCount: parseInt(r.order_count, 10),
      taxableValue: parseFloat(r.taxable),
      grossValue: parseFloat(r.gross),
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] revenue-by-source query failed, falling back to single bucket:', e?.message);
    // Fallback: skip the source split, just total the orders.
    try {
      const rev = await query(
        `SELECT COALESCE(SUM(subtotal), 0) AS taxable,
                COALESCE(SUM(total),    0) AS gross,
                COUNT(*)                   AS order_count
           FROM orders
          WHERE business_id = $1
            AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
            AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
            AND status <> 'cancelled'`,
        [businessId, startDate, endDate],
      );
      const row = rev.rows[0] || {};
      if ((row.order_count || 0) > 0) {
        fromOperations = [{
          source: 'unknown',
          label: REVENUE_SOURCE_LABELS.unknown,
          orderCount: parseInt(row.order_count, 10),
          taxableValue: parseFloat(row.taxable || 0),
          grossValue: parseFloat(row.gross || 0),
        }];
      }
    } catch (e2) {
      // eslint-disable-next-line no-console
      console.warn('[incomeStatement] revenue fallback also failed:', e2?.message);
    }
  }
  const grossRevenue = fromOperations.reduce((s, r) => s + r.grossValue, 0);
  const taxableRevenue = fromOperations.reduce((s, r) => s + r.taxableValue, 0);

  // 2. Indirect taxes collected — passed through to government, excluded
  //    from net profit. Shown for auditor reference. cgst/sgst/igst added
  //    in migration 017; deployments that haven't applied it get zeros.
  const tax = { cgst: 0, sgst: 0, igst: 0, total: 0 };
  try {
    const taxRow = await query(
      `SELECT COALESCE(SUM(cgst), 0) AS cgst,
              COALESCE(SUM(sgst), 0) AS sgst,
              COALESCE(SUM(igst), 0) AS igst
         FROM orders
        WHERE business_id = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
          AND status <> 'cancelled'`,
      [businessId, startDate, endDate],
    );
    tax.cgst = parseFloat(taxRow.rows[0]?.cgst || 0);
    tax.sgst = parseFloat(taxRow.rows[0]?.sgst || 0);
    tax.igst = parseFloat(taxRow.rows[0]?.igst || 0);
    tax.total = tax.cgst + tax.sgst + tax.igst;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] tax query failed (likely missing cgst/sgst/igst columns):', e?.message);
  }

  // 3. Operating expenses — one row per category, including 0-spend ones,
  //    so the P&L skeleton stays consistent for the auditor.
  let expMap = new Map();
  try {
    const expRows = await query(
      `SELECT category::text AS category, COALESCE(SUM(amount), 0) AS amount
         FROM expenses
        WHERE business_id = $1
          AND date >= $2::date
          AND date <= $3::date
          AND deleted_at IS NULL
        GROUP BY category`,
      [businessId, startDate, endDate],
    );
    expMap = new Map(expRows.rows.map((r) => [r.category, parseFloat(r.amount)]));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] expenses query failed:', e?.message);
  }
  const allOpex = EXPENSE_CATEGORIES.map((c) => ({
    category: c,
    label: EXPENSE_LABELS[c],
    amount: expMap.get(c) || 0,
  }));

  // 4. COGS = ingredients expense + wastage cost. Don't double-count
  //    ingredients in operating expenses — strip it out of the opex list.
  let wastageCost = 0;
  try {
    const wastageRow = await query(
      `SELECT COALESCE(SUM(cost_paise), 0) AS p
         FROM wastage_log
        WHERE business_id = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date`,
      [businessId, startDate, endDate],
    );
    wastageCost = parseFloat(wastageRow.rows[0]?.p || 0) / 100;
  } catch (_) {
    // wastage_log table not present in older deployments — silently skip
  }
  const ingredientLine = allOpex.find((e) => e.category === 'ingredients');
  const cogs = (ingredientLine?.amount || 0) + wastageCost;
  // 2026-08-23: wastage_log entries now ALSO mirror into expenses with
  // category 'wastage' (so owners see them in the Expenses screen).
  // COGS already counts wastage_log above — strip the mirror rows out
  // of opex like we do for ingredients, or the P&L double-counts.
  const operatingExpenses = allOpex.filter(
    (e) => e.category !== 'ingredients' && e.category !== 'wastage',
  );
  const totalOperatingExpenses = operatingExpenses.reduce((s, e) => s + e.amount, 0);

  // 5. Totals — Schedule III ordering
  const netRevenue = grossRevenue - tax.total;
  const grossProfit = netRevenue - cogs;
  const ebitda = grossProfit - totalOperatingExpenses;
  // No depreciation/finance/tax provisioning until journal module is
  // wired — those would come from journal_lines on those account codes.
  const netProfit = ebitda;
  const netMargin = netRevenue === 0 ? 0 : (netProfit / netRevenue) * 100;

  const series = await _dailySeries(businessId, startDate, endDate);

  return {
    meta: {
      business: {
        id: biz.id,
        name: biz.name,
        gstin: biz.gstin,
        address: biz.address,
        city: biz.city,
        stateCode: biz.state_code,
        phone: biz.phone,
        email: biz.email,
        logoUrl: biz.logo_url,
      },
      period: { startDate, endDate },
      generatedAt: new Date().toISOString(),
      currency: 'INR',
      capabilities: {
        cogsFromWastage: true,
        cogsFromRecipe: false,
        depreciation: false,
        finance: false,
        directTax: false,
      },
    },
    revenue: {
      fromOperations,
      otherIncome: [],
      grossRevenue,
      taxableRevenue,
      netRevenue,
    },
    indirectTaxesCollected: tax,
    cogs: {
      total: cogs,
      ingredients: ingredientLine?.amount || 0,
      wastage: wastageCost,
    },
    grossProfit,
    operatingExpenses,
    totalOperatingExpenses,
    ebitda,
    depreciation: 0,
    financeCosts: 0,
    taxExpense: 0,
    netProfit,
    netMargin: Math.round(netMargin * 10) / 10,
    series,
  };
}

async function _dailySeries(businessId, startDate, endDate) {
  const map = new Map();
  // Defensive: wrap each side independently so one bad table doesn't
  // wipe out the whole series.
  try {
    const rev = await query(
      `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, COALESCE(SUM(total), 0) AS amount
         FROM orders
        WHERE business_id = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
          AND status <> 'cancelled'
        GROUP BY (created_at AT TIME ZONE 'Asia/Kolkata')::date`,
      [businessId, startDate, endDate],
    );
    for (const r of rev.rows) {
      const k = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day);
      map.set(k, { date: k, revenue: parseFloat(r.amount), expenses: 0 });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] daily revenue series failed:', e?.message);
  }
  try {
    const exp = await query(
      `SELECT date AS day, COALESCE(SUM(amount), 0) AS amount
         FROM expenses
        WHERE business_id = $1
          AND date >= $2::date
          AND date <= $3::date
          AND deleted_at IS NULL
        GROUP BY date`,
      [businessId, startDate, endDate],
    );
    for (const r of exp.rows) {
      const k = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day);
      if (map.has(k)) map.get(k).expenses = parseFloat(r.amount);
      else map.set(k, { date: k, revenue: 0, expenses: parseFloat(r.amount) });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[incomeStatement] daily expense series failed:', e?.message);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  incomeStatement,
  EXPENSE_CATEGORIES,
  EXPENSE_LABELS,
  REVENUE_SOURCE_LABELS,
};
