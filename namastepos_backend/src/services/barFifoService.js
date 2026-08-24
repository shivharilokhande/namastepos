// Bar / liquor FIFO deduction (FF-902)
//
// When an order contains items flagged `is_liquor=true`, we need to deduct
// from `liquor_batches` in FIFO order (oldest received_at first). This is
// licensing-relevant in India — excise wants to know which duty-stamped
// batch each pour came from.
//
// Called from orderService.create() right after the recipe deduction step.
// Failures are non-blocking (logged + recorded as wastage shortage), since
// we don't want to refuse a paid order over a barback under-counting stock.

const { query } = require('../config/db');

// Deduct `pourMl × qty` from FIFO batches for one liquor menu item.
// Returns the list of (batchId, qtyDeducted) tuples used — useful for the
// audit/excise report.
async function deductOne(client, businessId, menuItemId, totalMl) {
  let remaining = totalMl;
  const used = [];

  const batches = await client.query(
    `SELECT id, qty_remaining, batch_no
       FROM liquor_batches
      WHERE business_id = $1 AND menu_item_id = $2 AND qty_remaining > 0
      ORDER BY received_at ASC, created_at ASC
      FOR UPDATE`,
    [businessId, menuItemId]
  );

  for (const b of batches.rows) {
    if (remaining <= 0) break;
    const take = Math.min(parseFloat(b.qty_remaining), remaining);
    await client.query(
      `UPDATE liquor_batches SET qty_remaining = qty_remaining - $1 WHERE id = $2`,
      [take, b.id]
    );
    used.push({ batchId: b.id, batchNo: b.batch_no, qtyDeducted: take });
    remaining -= take;
  }

  // Negative remaining = oversold (a manual stock-take is needed). We don't
  // throw — bar staff routinely "over-pour" and reconcile during closing.
  return { used, shortMl: remaining > 0 ? remaining : 0 };
}

// Walk an order's items, deduct from FIFO batches for any liquor lines.
// Expects `items` shape: [{ menuItemId, qty, pourMl, isLiquor }]
async function deductForOrder(client, businessId, items) {
  const report = [];
  for (const it of items) {
    if (!it.isLiquor || !it.pourMl || it.pourMl <= 0) continue;
    const totalMl = parseFloat(it.pourMl) * (it.qty || 1);
    const r = await deductOne(client, businessId, it.menuItemId, totalMl);
    report.push({ menuItemId: it.menuItemId, totalMl, ...r });
  }
  return report;
}

module.exports = { deductOne, deductForOrder };
