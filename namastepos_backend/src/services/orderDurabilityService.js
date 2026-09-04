// NamastePOS backend — order-path durability sweeps (NP-301/302/304, 2026-09-04)
//
// The order transaction is now strict: kitchen tickets, their print jobs and
// the critical inventory deductions all commit with the sale or not at all (see
// orderService.create). Strictness closes the silent-loss hole, but it cannot
// cover the residue:
//
//   • an order written by an OLDER build (or repaired by hand) that has no
//     kitchen ticket at all — food that was billed and never cooked;
//   • the one genuinely non-critical inventory step, the recipe-costing
//     ENTITLEMENT lookup, which is a pool read outside the txn and is recorded
//     as `orders.inventory_error` when it cannot be decided;
//   • `usage_counters.monthly_orders`, bumped AFTER commit on purpose (a quota
//     counter must never un-sell food that is already cooking) and therefore
//     able to drift low, handing a tenant free headroom.
//
// So: repair sweeps, in the shape `fulfilmentService.repairPosMirrors` already
// established (cheap, index-bounded, normally a no-op, retried every cron tick),
// plus detection helpers that `revenueIntegrityService` folds into the nightly
// email so anything the sweeps could NOT fix reaches a human.
//
// Every check function is exported standalone so tests can run it against
// seeded rows with no scheduler involved.

const { query, withTransaction } = require('../config/db');
const logger = require('../config/logger');

const LIST_LIMIT = 50;

// An order that was created seconds ago may simply still be in flight (its txn
// has not committed, or the API call is mid-retry). Only orders older than this
// count as "missing" their kitchen ticket.
const KOT_GRACE_MINUTES = 2;
// Beyond this the order is a historical artefact, not an operational incident:
// re-printing a two-day-old ticket into a kitchen would be worse than useless.
// It still shows up in the nightly email via checkOrdersMissingKot.
const KOT_REPAIR_WINDOW_HOURS = 12;

// ── NP-301: committed orders with no kitchen ticket ─────────────────────

/**
 * Orders that committed but carry NO kot_tickets row.
 *
 * Excluded on purpose:
 *   • cancelled orders (nothing to cook);
 *   • orders younger than the grace window (probably still in flight);
 *   • orders whose every line is an UNMAPPED aggregator line
 *     (menu_item_id IS NULL) — `kotService.generateTickets` legitimately
 *     produces no ticket for those, so they are "nothing to do", not a defect,
 *     and including them would make this sweep spin forever on rows it can
 *     never fix.
 */
async function findOrdersMissingKot({
  limit = LIST_LIMIT,
  graceMinutes = KOT_GRACE_MINUTES,
  windowHours = KOT_REPAIR_WINDOW_HOURS,
} = {}) {
  const r = await query(
    `SELECT o.id, o.business_id, o.order_no, o.source, o.table_no, o.token_no,
            o.total, o.created_at, o.kot_error
       FROM orders o
      WHERE o.status <> 'cancelled'
        AND o.created_at < NOW() - make_interval(mins => $1::int)
        AND o.created_at > NOW() - make_interval(hours => $2::int)
        AND NOT EXISTS (SELECT 1 FROM kot_tickets kt WHERE kt.order_id = o.id)
        AND EXISTS (
          SELECT 1 FROM order_items oi
           WHERE oi.order_id = o.id AND oi.menu_item_id IS NOT NULL
        )
      ORDER BY o.created_at ASC
      LIMIT $3`,
    [graceMinutes, windowHours, limit],
  );
  return r.rows;
}

/**
 * Same anti-join, but over the whole retention window and with no repair
 * horizon — the nightly email's "these were billed and the kitchen may never
 * have seen them" list. Anything still here after the sweep has had 12 hours of
 * tries is a human's problem.
 */
async function checkOrdersMissingKot({ limit = LIST_LIMIT, olderThanHours = 1 } = {}) {
  const r = await query(
    `SELECT o.id, o.business_id, b.name AS business_name, o.order_no,
            o.total, o.status, o.created_at, o.kot_error
       FROM orders o
       JOIN businesses b ON b.id = o.business_id
      WHERE o.status <> 'cancelled'
        AND o.created_at < NOW() - make_interval(hours => $1::int)
        AND o.created_at > NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM kot_tickets kt WHERE kt.order_id = o.id)
        AND EXISTS (
          SELECT 1 FROM order_items oi
           WHERE oi.order_id = o.id AND oi.menu_item_id IS NOT NULL
        )
      ORDER BY o.created_at ASC
      LIMIT $2`,
    [olderThanHours, limit],
  );
  return r.rows;
}

/**
 * Repair one order's kitchen record: regenerate its tickets from its persisted
 * order_items and enqueue the print jobs, in ONE transaction (same atomicity
 * the order path itself now has). Idempotency comes from the caller's anti-join
 * — an order that already has a ticket is never handed to us — plus the
 * in-transaction re-check below, which closes the race against a concurrent
 * repair on another instance.
 */
async function repairOneOrderKot(orderRow) {
  const kot = require('./kotService');
  return withTransaction(async (client) => {
    // Re-check under a row lock: two cron instances (or a cron tick racing a
    // manual repair) must not both generate tickets for the same order.
    const lock = await client.query(
      `SELECT id, order_no, source, table_no, token_no
         FROM orders
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [orderRow.id, orderRow.business_id],
    );
    if (lock.rowCount === 0) return { skipped: 'gone' };
    const existing = await client.query(
      'SELECT 1 FROM kot_tickets WHERE order_id = $1 LIMIT 1',
      [orderRow.id],
    );
    if (existing.rowCount > 0) return { skipped: 'already-has-tickets' };

    const itemsQ = await client.query(
      `SELECT id, menu_item_id, name, qty, note
         FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderRow.id],
    );
    const orderItems = itemsQ.rows.map((it) => ({
      orderItemId: it.id,
      menuItemId: it.menu_item_id,
      name: it.name,
      qty: parseFloat(it.qty),
      note: it.note,
    }));
    const tickets = await kot.generateTickets(client, {
      businessId: orderRow.business_id,
      orderId: orderRow.id,
      orderItems,
    });
    if (tickets.length === 0) return { skipped: 'unroutable' };
    await kot.enqueueTicketPrints(client, {
      businessId: orderRow.business_id,
      orderId: orderRow.id,
      tickets,
      order: lock.rows[0],
    });
    await client.query(
      'UPDATE orders SET kot_error = NULL WHERE id = $1',
      [orderRow.id],
    );
    return { repaired: tickets.length };
  });
}

/** Sweep + repair. Called from the cron worker every tick. */
async function repairMissingKots({ limit = LIST_LIMIT } = {}) {
  const stuck = await findOrdersMissingKot({ limit });
  let repaired = 0; let skipped = 0; let stillStuck = 0;
  for (const row of stuck) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await repairOneOrderKot(row);
      if (r.repaired) repaired += 1; else skipped += 1;
    } catch (e) {
      stillStuck += 1;
      logger.warn(
        `[order-durability] KOT repair FAILED for order ${row.id} `
        + `(#${row.order_no}, business ${row.business_id}): ${e.message}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await query(
        'UPDATE orders SET kot_error = $1 WHERE id = $2',
        [String(e.message).slice(0, 300), row.id],
      ).catch(() => { /* marker column is best-effort by definition */ });
    }
  }
  if (repaired || stillStuck) {
    logger.warn(
      `[order-durability] KOT repair: repaired=${repaired} skipped=${skipped} `
      + `stillStuck=${stillStuck} considered=${stuck.length}`,
    );
  }
  return { repaired, skipped, stillStuck, considered: stuck.length };
}

/**
 * NP-301 — print jobs that exhausted their retries. The kitchen ticket EXISTS
 * (so the KDS shows it), but no paper ever came out: an operational alert, not
 * a data-integrity one.
 */
async function checkDeadPrintJobs({ limit = LIST_LIMIT } = {}) {
  const r = await query(
    `SELECT pj.id, pj.business_id, b.name AS business_name, pj.kind,
            pj.attempts, pj.error_message, pj.created_at, o.order_no
       FROM print_jobs pj
       JOIN businesses b ON b.id = pj.business_id
  LEFT JOIN orders o ON o.id = pj.order_id
      WHERE pj.status = 'failed'
        AND pj.created_at > NOW() - INTERVAL '3 days'
      ORDER BY pj.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

// ── NP-302: inventory effects that could not be applied ────────────────

/** Orders stamped with a non-critical inventory failure, awaiting repair. */
async function findOrdersWithInventoryError({ limit = LIST_LIMIT } = {}) {
  const r = await query(
    `SELECT id, business_id, order_no, inventory_error, created_at
       FROM orders
      WHERE inventory_error IS NOT NULL
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * Retry the deduction the order path could not decide on.
 *
 * The only thing that lands here is "we could not tell whether this tenant has
 * recipe-costing", so the repair is: ask again, and if the answer is yes AND
 * nothing was deducted for this order yet (no `ingredient_transactions` rows —
 * the ledger is the authority, not the marker), run the real deduction inside a
 * transaction. If the answer is no, there was never anything to do and the
 * marker simply clears.
 */
async function repairInventoryEffects({ limit = LIST_LIMIT } = {}) {
  const addons = require('./addonService');
  const recipes = require('./recipeService');
  const rows = await findOrdersWithInventoryError({ limit });
  let repaired = 0; let cleared = 0; let stillStuck = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const entitled = await addons.hasAddon(row.business_id, 'recipe-costing');
      if (!entitled) {
        // eslint-disable-next-line no-await-in-loop
        await query('UPDATE orders SET inventory_error = NULL WHERE id = $1', [row.id]);
        cleared += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const already = await client.query(
          `SELECT 1 FROM ingredient_transactions
            WHERE order_id = $1 AND kind = 'sale' LIMIT 1`,
          [row.id],
        );
        if (already.rowCount === 0) {
          const itemsQ = await client.query(
            'SELECT id, menu_item_id, qty FROM order_items WHERE order_id = $1',
            [row.id],
          );
          await recipes.deductForOrder(client, {
            businessId: row.business_id,
            orderId: row.id,
            orderItems: itemsQ.rows.map((it) => ({
              orderItemId: it.id,
              menuItemId: it.menu_item_id,
              qty: parseFloat(it.qty),
            })),
          });
        }
        await client.query(
          'UPDATE orders SET inventory_error = NULL WHERE id = $1',
          [row.id],
        );
      });
      repaired += 1;
    } catch (e) {
      stillStuck += 1;
      logger.warn(
        `[order-durability] inventory repair FAILED for order ${row.id}: ${e.message}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await query(
        'UPDATE orders SET inventory_error = $1 WHERE id = $2',
        [`repair failed: ${String(e.message).slice(0, 280)}`, row.id],
      ).catch(() => {});
    }
  }
  if (repaired || cleared || stillStuck) {
    logger.info(
      `[order-durability] inventory repair: repaired=${repaired} cleared=${cleared} `
      + `stillStuck=${stillStuck} considered=${rows.length}`,
    );
  }
  return { repaired, cleared, stillStuck, considered: rows.length };
}

/** Nightly-email view: inventory markers a repair pass could not clear. */
async function checkStuckInventoryEffects({ limit = LIST_LIMIT, olderThanHours = 1 } = {}) {
  const r = await query(
    `SELECT o.id, o.business_id, b.name AS business_name, o.order_no,
            o.inventory_error, o.created_at
       FROM orders o
       JOIN businesses b ON b.id = o.business_id
      WHERE o.inventory_error IS NOT NULL
        AND o.created_at < NOW() - make_interval(hours => $1::int)
        AND o.created_at > NOW() - INTERVAL '7 days'
      ORDER BY o.created_at ASC
      LIMIT $2`,
    [olderThanHours, limit],
  );
  return r.rows;
}

// ── NP-304: usage-counter reconciliation ───────────────────────────────

/**
 * The period key `usage_counters` is written with — `subscriptionService.
 * incrementUsage` uses `new Date().toISOString().slice(0, 7)`, i.e. the UTC
 * month. The reconciler MUST use the identical definition or it would "repair"
 * a counter into a different month's truth every 1st of the month.
 */
function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * Businesses whose `monthly_orders` counter disagrees with the actual number of
 * orders created in the period. Read-only.
 */
async function findUsageDrift({ period = currentPeriod(), metric = 'monthly_orders' } = {}) {
  const r = await query(
    // Both directions have to be visible, so the driving set is the UNION of
    // "businesses that took orders this period" and "businesses that have a
    // counter row for it" — a counter that exists with no orders behind it is
    // drift too, and an inner join on either side alone would hide one case.
    `WITH actual AS (
        SELECT o.business_id, COUNT(*)::int AS actual_count
          FROM orders o
         WHERE o.created_at >= ($1 || '-01')::date
           AND o.created_at <  (($1 || '-01')::date + INTERVAL '1 month')
         GROUP BY o.business_id
     ), counters AS (
        SELECT business_id, count
          FROM usage_counters
         WHERE metric = $2 AND period = $1
     ), ids AS (
        SELECT business_id FROM actual
        UNION
        SELECT business_id FROM counters
     )
     SELECT i.business_id, b.name AS business_name,
            COALESCE(a.actual_count, 0)::int AS actual_count,
            COALESCE(c.count, 0)::int AS counted
       FROM ids i
       JOIN businesses b ON b.id = i.business_id
  LEFT JOIN actual   a ON a.business_id = i.business_id
  LEFT JOIN counters c ON c.business_id = i.business_id
      WHERE COALESCE(c.count, 0) <> COALESCE(a.actual_count, 0)
      ORDER BY (COALESCE(a.actual_count, 0) - COALESCE(c.count, 0)) DESC`,
    [period, metric],
  );
  return r.rows;
}

/**
 * Repair the drift.
 *
 * Direction matters. A counter BELOW reality is the failure mode the audit
 * found (the post-commit bump was swallowed) and it hands the tenant free
 * headroom, so it is raised to the true count. A counter ABOVE reality is only
 * reachable by a double-count or by orders having been purged from a closed
 * period, and lowering it would GRANT quota — so those are logged and left
 * alone for a human. `GREATEST` in the upsert makes the write itself safe
 * against a concurrent live increment landing between the read and the write.
 */
async function reconcileMonthlyOrders({
  period = currentPeriod(), metric = 'monthly_orders',
} = {}) {
  const drift = await findUsageDrift({ period, metric });
  const raised = [];
  const overCounted = [];
  for (const d of drift) {
    if (d.actual_count > d.counted) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO usage_counters (business_id, metric, period, count, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (business_id, metric, period)
         DO UPDATE SET count = GREATEST(usage_counters.count, EXCLUDED.count),
                       updated_at = NOW()`,
        [d.business_id, metric, period, d.actual_count],
      );
      raised.push({
        businessId: d.business_id,
        businessName: d.business_name,
        from: d.counted,
        to: d.actual_count,
      });
    } else {
      overCounted.push({
        businessId: d.business_id,
        businessName: d.business_name,
        counted: d.counted,
        actual: d.actual_count,
      });
    }
  }
  for (const r of raised) {
    logger.warn(
      `[usage-reconcile] ${metric} ${period} business ${r.businessId} `
      + `(${r.businessName}): counter ${r.from} → ${r.to} (+${r.to - r.from} orders `
      + 'the post-commit bump lost)',
    );
  }
  for (const o of overCounted) {
    logger.warn(
      `[usage-reconcile] ${metric} ${period} business ${o.businessId} `
      + `(${o.businessName}): counter ${o.counted} EXCEEDS actual ${o.actual} — `
      + 'left as-is (lowering it would grant quota); needs a human',
    );
  }
  return {
    period,
    metric,
    considered: drift.length,
    raised,
    overCounted,
  };
}

/** Nightly-email view of the same drift, without repairing it. */
async function checkUsageDrift({ limit = LIST_LIMIT } = {}) {
  const rows = await findUsageDrift();
  return rows.slice(0, limit);
}

module.exports = {
  // repairs (cron)
  repairMissingKots,
  repairOneOrderKot,
  repairInventoryEffects,
  reconcileMonthlyOrders,
  // detection (tests + nightly integrity email)
  findOrdersMissingKot,
  findOrdersWithInventoryError,
  findUsageDrift,
  checkOrdersMissingKot,
  checkStuckInventoryEffects,
  checkDeadPrintJobs,
  checkUsageDrift,
  currentPeriod,
  KOT_GRACE_MINUTES,
  KOT_REPAIR_WINDOW_HOURS,
};
