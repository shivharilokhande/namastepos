// NamastePOS — Menu engineering (Star / Horse / Dog / Puzzle) — FF-1106.
//
// Classic 2×2 from the hospitality textbooks:
//              High margin
//                  ▲
//            ┌─────┼─────┐
//   STARS    │  ▓  │  ▓  │  PUZZLES
//            ├─────┼─────┤   → Low popularity but tasty margin;
//   HORSES   │  ▓  │  ▓  │     rework marketing or bundle
//            └─────┼─────┘   PLOW-HORSES → popular but low margin
//   Low margin    ─┴─    Low popularity
//                  ▼
// Terminology: PetPooja uses "Star / Horse / Dog / Puzzle". We stick
// with that so users searching for it find our version.
//
// Popularity threshold: median item volume over the range.
// Margin threshold:      median item margin over the range.
// Owner can override both from the report page.

const { query } = require('../config/db');

async function classify(businessId, fromStr, toStr) {
  // P2 fix (2026-08-22): default range in IST to match report bucketing
  const istDay = (ms = 0) => new Date(Date.now() + ms)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = toStr   || istDay();
  const from = fromStr || istDay(-30 * 24 * 3600 * 1000);

  const r = await query(
    `SELECT mi.id, mi.name, mi.price, mi.cost_price,
            COALESCE(SUM(oi.qty), 0)::float                     AS units,
            COALESCE(SUM(oi.qty * oi.price), 0)::float          AS revenue,
            CASE WHEN mi.cost_price IS NULL OR mi.cost_price = 0 THEN NULL
                 ELSE (mi.price - mi.cost_price)::float
            END                                                  AS unit_margin
       FROM menu_items mi
  LEFT JOIN order_items oi ON oi.menu_item_id = mi.id
  LEFT JOIN orders      o  ON o.id = oi.order_id
                          AND o.business_id = $1
                          AND o.status <> 'cancelled'
                          AND o.created_at::date BETWEEN $2::date AND $3::date
      WHERE mi.business_id = $1
        AND mi.deleted_at IS NULL
        AND mi.is_active = TRUE
      GROUP BY mi.id
      HAVING COALESCE(SUM(oi.qty), 0) > 0
      ORDER BY units DESC`,
    [businessId, from, to]
  );
  const items = r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    units: row.units,
    revenue: row.revenue,
    unitMargin: row.unit_margin,
    totalMargin: row.unit_margin != null ? row.unit_margin * row.units : null,
  }));
  if (items.length === 0) {
    return { from, to, items: [], thresholds: null };
  }

  // Median of the two axes → each item falls in one quadrant.
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const median = (arr) => {
    if (arr.length === 0) return 0;
    const s = sorted(arr);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const popThreshold = median(items.map((i) => i.units));
  const marginThreshold = median(items.filter((i) => i.unitMargin != null).map((i) => i.unitMargin));

  for (const it of items) {
    const highPop    = it.units > popThreshold;
    const highMargin = it.unitMargin != null && it.unitMargin > marginThreshold;
    it.quadrant =
      highPop && highMargin ? 'star' :
      highPop && !highMargin ? 'horse' :
      !highPop && highMargin ? 'puzzle' :
      'dog';
    it.recommendation = {
      star:   'Feature prominently. Test small price increases.',
      horse:  'Popular but thin margin. Try recipe cost-out or bundle.',
      puzzle: 'Great margin, low volume. Merchandise better or reposition.',
      dog:    'Consider removing. Frees menu space + kitchen prep.',
    }[it.quadrant];
  }

  return {
    from, to,
    thresholds: { popularity: popThreshold, margin: marginThreshold },
    counts: {
      star:   items.filter((i) => i.quadrant === 'star').length,
      horse:  items.filter((i) => i.quadrant === 'horse').length,
      puzzle: items.filter((i) => i.quadrant === 'puzzle').length,
      dog:    items.filter((i) => i.quadrant === 'dog').length,
    },
    items,
  };
}

module.exports = { classify };
