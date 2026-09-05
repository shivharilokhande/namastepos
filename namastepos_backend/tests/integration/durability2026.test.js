// NP-301/302/303/304 (2026-09-04) — operational durability in the order path.
//
// Four verified defects from the external audit, each of which let a COMMITTED
// order silently lose a side effect the restaurant depends on:
//
//   NP-301  KOT generation was `catch (_) {}` — the bill committed, the diner
//           was told "accepted", the kitchen never saw the order.
//   NP-302  Recipe + liquor-FIFO deductions were swallowed the same way, so
//           sales were right while stock / food-cost / excise were wrong.
//   NP-303  Refund cap raced across a table session: the lock was on the ORDER
//           row while the cap was computed over ALL orders in the session, so
//           two refunds on different KOTs of one bill both saw "prior = 0".
//   NP-304  usage_counters.monthly_orders is bumped post-commit and the failure
//           swallowed, so the quota could read lower than reality.
//
// What is asserted here:
//   1. a normal order writes its kitchen tickets AND queues their print jobs
//      inside the order transaction;
//   2. order creation ROLLS BACK when the KOT rows cannot be written (order,
//      items and stock ledger all gone);
//   3. a PRINT-AGENT failure does NOT roll back anything and leaves a
//      RETRYABLE job (queued again, with a backoff), dead-lettering only after
//      the attempts are exhausted;
//   4. an item with NO recipe configured does not fail the order ("nothing to
//      do" ≠ "failed to do it"), while a GENUINE deduction failure rolls the
//      order back instead of silently passing;
//   5. two concurrent refunds against DIFFERENT orders of the SAME session
//      cannot jointly exceed the session cap;
//   6. the usage reconciler repairs a drifted counter (and refuses to LOWER a
//      counter that is above reality, which would grant quota);
//   7. the KOT repair sweep heals an order that has no kitchen ticket.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');
const kotService = require('../../src/services/kotService');
const recipeService = require('../../src/services/recipeService');
const printerService = require('../../src/services/printerService');
const refundService = require('../../src/services/refundService');
const durability = require('../../src/services/orderDurabilityService');

let biz;
let chaiId; // ₹20 — no recipe configured (the legitimate "nothing to do")
let dosaId; // ₹80 — has a recipe

const body = (items, extra = {}) => ({
  source: 'takeaway',
  items,
  tax: 0,
  paymentMethod: 'cash',
  ...extra,
});

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `durability-${Date.now()}` });
  chaiId = (await menuService.create(biz.id, { name: 'Cutting Chai', price: 20 })).id;
  dosaId = (await menuService.create(biz.id, { name: 'Masala Dosa', price: 80 })).id;
});

afterAll(async () => { await closePool(); });

afterEach(() => { jest.restoreAllMocks(); });

async function ticketsOf(orderId) {
  const r = await query('SELECT * FROM kot_tickets WHERE order_id = $1', [orderId]);
  return r.rows;
}
async function printJobsOf(orderId) {
  const r = await query(
    'SELECT * FROM print_jobs WHERE order_id = $1 ORDER BY created_at',
    [orderId],
  );
  return r.rows;
}

// ── NP-301 ──────────────────────────────────────────────────────────────
describe('NP-301 — the kitchen record commits with the sale', () => {
  it('writes ticket rows AND queues one print job per ticket, in-txn', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: chaiId, name: 'Cutting Chai', price: 20, qty: 2 },
    ]));

    const tickets = await ticketsOf(o.id);
    expect(tickets.length).toBeGreaterThan(0);

    const items = await query(
      `SELECT kti.* FROM kot_ticket_items kti
        WHERE kti.ticket_id = ANY($1::uuid[])`,
      [tickets.map((t) => t.id)],
    );
    expect(items.rowCount).toBe(1);
    expect(items.rows[0].name).toBe('Cutting Chai');

    // The print job is a ROW written in the same transaction; the I/O is the
    // agent's problem, not the sale's.
    const jobs = await printJobsOf(o.id);
    expect(jobs.length).toBe(tickets.length);
    expect(jobs[0].kind).toBe('kot');
    expect(jobs[0].status).toBe('queued');
    expect(jobs[0].attempts).toBe(0);
    expect(jobs[0].kot_ticket_id).toBe(tickets[0].id);
    // A KOT is a work order, never a receipt — no money on it.
    expect(jobs[0].payload_text).toContain('Cutting Chai');
    expect(jobs[0].payload_text).not.toContain('TOTAL');
  });

  it('ROLLS BACK the whole order when the KOT rows cannot be written', async () => {
    jest.spyOn(kotService, 'generateTickets').mockRejectedValue(
      new Error('kot_tickets insert exploded'),
    );

    const clientId = '11111111-1111-4111-8111-111111111111';
    await expect(orderService.create(biz.id, body(
      [{ menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 1 }],
      { clientId },
    ))).rejects.toThrow(/kot_tickets insert exploded/);

    // Nothing survives: no order, no items, no stock ledger row. A bill whose
    // kitchen record failed to write is not a valid bill.
    const orders = await query(
      'SELECT id FROM orders WHERE business_id = $1 AND client_id = $2',
      [biz.id, clientId],
    );
    expect(orders.rowCount).toBe(0);
  });

  it('ROLLS BACK when the print job cannot be ENQUEUED (a row, not I/O)', async () => {
    jest.spyOn(kotService, 'enqueueTicketPrints').mockRejectedValue(
      new Error('print_jobs insert exploded'),
    );
    const clientId = '22222222-2222-4222-8222-222222222222';
    await expect(orderService.create(biz.id, body(
      [{ menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 1 }],
      { clientId },
    ))).rejects.toThrow(/print_jobs insert exploded/);
    const orders = await query(
      'SELECT id FROM orders WHERE business_id = $1 AND client_id = $2',
      [biz.id, clientId],
    );
    expect(orders.rowCount).toBe(0);
  });

  it('a PRINT-AGENT failure keeps the order and leaves a RETRYABLE job', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: chaiId, name: 'Cutting Chai', price: 20, qty: 1 },
    ]));
    const [job] = await printJobsOf(o.id);
    expect(job.status).toBe('queued');
    // dequeueNext takes the OLDEST claimable job for the business, and earlier
    // tests left theirs queued (nothing drains them in a test process). Clear
    // those so the agent we simulate claims THIS order's ticket.
    await query(
      'DELETE FROM print_jobs WHERE business_id = $1 AND order_id <> $2',
      [biz.id, o.id],
    );

    // The agent claims it…
    const claimed = await printerService.dequeueNext(biz.id);
    expect(claimed).not.toBeNull();
    expect(claimed.status).toBe('printing');
    expect(claimed.attempts).toBe(1);

    // …and the thermal printer is offline.
    await printerService.markJobDone(biz.id, claimed.id, false, 'printer offline');

    const after = (await query('SELECT * FROM print_jobs WHERE id = $1', [claimed.id])).rows[0];
    // Retryable, NOT dead — this used to go straight to 'failed' and be lost
    // forever because dequeueNext only ever picks 'queued'.
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(1);
    expect(after.error_message).toBe('printer offline');
    expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // The ORDER is untouched — nobody loses a sale over paper.
    const stillThere = await query('SELECT status FROM orders WHERE id = $1', [o.id]);
    expect(stillThere.rowCount).toBe(1);
  });

  it('dead-letters a print job only once its attempts are exhausted', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: chaiId, name: 'Cutting Chai', price: 20, qty: 1 },
    ]));
    const [job] = await printJobsOf(o.id);

    for (let i = 0; i < printerService.PRINT_JOB_MAX_ATTEMPTS; i += 1) {
      // Drive attempts directly (dequeueNext honours the backoff, which we do
      // not want to sleep through in a test).
      // eslint-disable-next-line no-await-in-loop
      await query('UPDATE print_jobs SET attempts = attempts + 1 WHERE id = $1', [job.id]);
      // eslint-disable-next-line no-await-in-loop
      await printerService.markJobDone(biz.id, job.id, false, 'still offline');
    }
    const after = (await query('SELECT * FROM print_jobs WHERE id = $1', [job.id])).rows[0];
    expect(after.status).toBe('failed');
    // …and a dead-lettered job is escalated by the nightly integrity email.
    const dead = await durability.checkDeadPrintJobs();
    expect(dead.some((d) => d.id === job.id)).toBe(true);
  });

  it('requeues a job the agent claimed and never reported back on', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: chaiId, name: 'Cutting Chai', price: 20, qty: 1 },
    ]));
    const [job] = await printJobsOf(o.id);
    await query(
      `UPDATE print_jobs SET status = 'printing', attempts = 1,
              created_at = NOW() - INTERVAL '30 minutes'
        WHERE id = $1`,
      [job.id],
    );
    const r = await printerService.requeueStalePrintJobs();
    expect(r.requeued).toBeGreaterThan(0);
    const after = (await query('SELECT status FROM print_jobs WHERE id = $1', [job.id])).rows[0];
    expect(after.status).toBe('queued');
  });
});

// ── NP-301 safety net ───────────────────────────────────────────────────
describe('NP-301 — repair sweep for orders with no kitchen ticket', () => {
  it('finds and heals a committed order whose tickets were never written', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 3 },
    ]));
    // Simulate the pre-fix world: an order that committed with no KOT and no
    // print job, older than the grace window.
    await query('DELETE FROM print_jobs WHERE order_id = $1', [o.id]);
    await query('DELETE FROM kot_tickets WHERE order_id = $1', [o.id]);
    await query(
      "UPDATE orders SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
      [o.id],
    );

    const missing = await durability.findOrdersMissingKot();
    expect(missing.some((m) => m.id === o.id)).toBe(true);

    const res = await durability.repairMissingKots();
    expect(res.repaired).toBeGreaterThan(0);

    expect((await ticketsOf(o.id)).length).toBeGreaterThan(0);
    expect((await printJobsOf(o.id)).length).toBeGreaterThan(0);
    // Repaired → no longer in the sweep, and no longer in the nightly email.
    expect((await durability.findOrdersMissingKot()).some((m) => m.id === o.id)).toBe(false);
  });

  it('is idempotent — a second pass does not double-ticket an order', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 1 },
    ]));
    const before = (await ticketsOf(o.id)).length;
    const r = await durability.repairOneOrderKot({ id: o.id, business_id: biz.id });
    expect(r.skipped).toBe('already-has-tickets');
    expect((await ticketsOf(o.id)).length).toBe(before);
  });
});

// ── NP-302 ──────────────────────────────────────────────────────────────
describe('NP-302 — inventory deductions are no longer swallowed', () => {
  let ingredientId;

  beforeAll(async () => {
    // Entitle the tenant to recipe-costing so the deduction branch runs.
    const addon = await query("SELECT id FROM addons WHERE slug = 'recipe-costing'");
    await query(
      `INSERT INTO business_addons
         (business_id, addon_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')
       ON CONFLICT DO NOTHING`,
      [biz.id, addon.rows[0].id],
    );
    // 2026-09-05 (review D1): the deduction branch now asks
    // featureService.hasFeature('recipe_costing') — which the addon grants via
    // grants_features (migration 074) — instead of addonService.hasAddon. The
    // entitlement cache may already hold this tenant's pre-addon answer from
    // the earlier describes, so drop it.
    require('../../src/services/featureService').clearAllCaches();
    const ing = await query(
      `INSERT INTO ingredients (business_id, name, unit, stock, cost_per_unit_paise)
       VALUES ($1, 'Rice Batter', 'g', 10000, 2) RETURNING id`,
      [biz.id],
    );
    ingredientId = ing.rows[0].id;
    // Dosa has a recipe; chai deliberately does NOT.
    await query(
      `INSERT INTO recipes (business_id, menu_item_id, ingredient_id, qty)
       VALUES ($1, $2, $3, 100)
       ON CONFLICT (menu_item_id, ingredient_id) DO NOTHING`,
      [biz.id, dosaId, ingredientId],
    );
  });

  it('an item with NO recipe configured does not fail the order', async () => {
    // "nothing to do" is not an error: recipeService returns an empty result
    // rather than throwing, so the sale goes through untouched and no ledger
    // row is invented.
    const o = await orderService.create(biz.id, body([
      { menuItemId: chaiId, name: 'Cutting Chai', price: 20, qty: 2 },
    ]));
    expect(o.total).toBe(40);
    const txns = await query('SELECT 1 FROM ingredient_transactions WHERE order_id = $1', [o.id]);
    expect(txns.rowCount).toBe(0);
    expect((await query('SELECT inventory_error FROM orders WHERE id = $1', [o.id]))
      .rows[0].inventory_error).toBeNull();
  });

  it('deducts tracked stock inside the order transaction when a recipe exists', async () => {
    const before = parseFloat((await query('SELECT stock FROM ingredients WHERE id = $1', [ingredientId])).rows[0].stock);

    const o = await orderService.create(biz.id, body([
      { menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 2 },
    ]));

    const after = parseFloat((await query('SELECT stock FROM ingredients WHERE id = $1', [ingredientId])).rows[0].stock);
    expect(after).toBeCloseTo(before - 200, 3);
    const txns = await query(
      "SELECT * FROM ingredient_transactions WHERE order_id = $1 AND kind = 'sale'",
      [o.id],
    );
    expect(txns.rowCount).toBe(1);
  });

  it('a GENUINE deduction failure rolls the order back instead of passing silently', async () => {
    jest.spyOn(recipeService, 'deductForOrder').mockRejectedValue(
      new Error('ingredient ledger write failed'),
    );
    const clientId = '33333333-3333-4333-8333-333333333333';
    await expect(orderService.create(biz.id, body(
      [{ menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 1 }],
      { clientId },
    ))).rejects.toThrow(/ingredient ledger write failed/);

    const orders = await query(
      'SELECT id FROM orders WHERE business_id = $1 AND client_id = $2',
      [biz.id, clientId],
    );
    // Sales and stock cannot disagree: either both happened, or neither did.
    expect(orders.rowCount).toBe(0);
  });

  it('records a NON-critical entitlement-lookup failure for repair instead of dropping it', async () => {
    // 2026-09-05 (review D1): the lookup is now featureService.hasFeature.
    const features = require('../../src/services/featureService');
    jest.spyOn(features, 'hasFeature').mockRejectedValue(new Error('entitlement cache down'));

    const o = await orderService.create(biz.id, body([
      { menuItemId: dosaId, name: 'Masala Dosa', price: 80, qty: 1 },
    ]));
    jest.restoreAllMocks();

    // The sale stands (the lookup is not the deduction), but the fact that we
    // could not decide is on the row, not in /dev/null.
    const row = (await query('SELECT inventory_error FROM orders WHERE id = $1', [o.id])).rows[0];
    expect(row.inventory_error).toMatch(/entitlement lookup failed/);
    expect((await durability.findOrdersWithInventoryError()).some((x) => x.id === o.id)).toBe(true);

    // …and the repair sweep applies what was missed and clears the marker.
    const res = await durability.repairInventoryEffects();
    expect(res.repaired + res.cleared).toBeGreaterThan(0);
    const healed = (await query('SELECT inventory_error FROM orders WHERE id = $1', [o.id])).rows[0];
    expect(healed.inventory_error).toBeNull();
    const txns = await query(
      "SELECT * FROM ingredient_transactions WHERE order_id = $1 AND kind = 'sale'",
      [o.id],
    );
    expect(txns.rowCount).toBe(1);
  });
});

// ── NP-303 ──────────────────────────────────────────────────────────────
describe('NP-303 — the refund cap is enforced across a whole table session', () => {
  let sessionId;
  let orderA;
  let orderB;

  beforeAll(async () => {
    const floor = await query(
      'INSERT INTO floors (business_id, name) VALUES ($1, \'Ground\') RETURNING id',
      [biz.id],
    );
    const table = await query(
      'INSERT INTO tables (business_id, floor_id, label) VALUES ($1, $2, \'T1\') RETURNING id',
      [biz.id, floor.rows[0].id],
    );
    const sess = await query(
      `INSERT INTO table_sessions (business_id, table_id, guest_count)
       VALUES ($1, $2, 2) RETURNING id`,
      [biz.id, table.rows[0].id],
    );
    sessionId = sess.rows[0].id;

    // Two KOTs of ONE bill: ₹500 + ₹500 = a ₹1000 session.
    const mk = async (orderNo, total) => (await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, discount, total,
          payment_method, status, table_session_id)
       VALUES ($1, $2, 'dineIn', $3, 0, 0, $3, 'cash', 'collected', $4)
       RETURNING id`,
      [biz.id, orderNo, total, sessionId],
    )).rows[0].id;
    orderA = await mk(90001, 500);
    orderB = await mk(90002, 500);
  });

  it('rejects a sequential refund that would exceed the session total', async () => {
    await refundService.refundOrder({
      businessId: biz.id, orderId: orderA, amountInr: 900, reason: 'first',
    });
    await expect(refundService.refundOrder({
      businessId: biz.id, orderId: orderB, amountInr: 200, reason: 'second',
    })).rejects.toThrow(/exceed order total/i);
    // Clean up so the concurrency case below starts from zero.
    await query('DELETE FROM refunds WHERE business_id = $1', [biz.id]);
  });

  it('serialises two CONCURRENT refunds on different orders of the same session', async () => {
    // Each is 60% of the ₹1000 session, so exactly ONE may win. Before the
    // session-level lock both locked different ORDER rows, each read
    // "prior refunds = 0", and both committed → 120% of the bill refunded.
    const results = await Promise.allSettled([
      refundService.refundOrder({
        businessId: biz.id, orderId: orderA, amountInr: 600, reason: 'concurrent-A',
      }),
      refundService.refundOrder({
        businessId: biz.id, orderId: orderB, amountInr: 600, reason: 'concurrent-B',
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.message).toMatch(/exceed order total/i);

    const sum = await query(
      `SELECT COALESCE(SUM(r.amount_paise), 0)::bigint AS total
         FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE o.table_session_id = $1 AND r.status IN ('pending', 'processed')`,
      [sessionId],
    );
    // Never more than the ₹1000 bill.
    expect(Number(sum.rows[0].total)).toBeLessThanOrEqual(100000);
    expect(Number(sum.rows[0].total)).toBe(60000);
  });

  it('takes the lock on the SESSION row, not just the order', async () => {
    // Direct evidence of the mechanism, independent of scheduling: hold the
    // session row in one transaction and prove a refund on a DIFFERENT order of
    // that session blocks on it.
    const { getClient } = require('../../src/config/db');
    const holder = await getClient();
    let refundSettled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM table_sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const refund = refundService.refundOrder({
        businessId: biz.id, orderId: orderB, amountInr: 100, reason: 'blocked?',
      }).then(
        (v) => { refundSettled = true; return v; },
        (e) => { refundSettled = true; throw e; },
      ).catch(() => {});

      // Give it a real chance to run to completion if it were NOT blocked.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(refundSettled).toBe(false);

      await holder.query('ROLLBACK');
      await refund;
      expect(refundSettled).toBe(true);
    } finally {
      try { await holder.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
      holder.release();
    }
  });

  it('leaves the single-order (no session) path exactly as it was', async () => {
    const solo = (await query(
      `INSERT INTO orders
         (business_id, order_no, source, subtotal, tax, discount, total,
          payment_method, status)
       VALUES ($1, 90010, 'takeaway', 200, 0, 0, 200, 'cash', 'collected')
       RETURNING id`,
      [biz.id],
    )).rows[0].id;

    const r = await refundService.refundOrder({
      businessId: biz.id, orderId: solo, amountInr: 150, reason: 'partial',
    });
    expect(r.amountPaise).toBe(15000);
    await expect(refundService.refundOrder({
      businessId: biz.id, orderId: solo, amountInr: 100, reason: 'over',
    })).rejects.toThrow(/exceed order total/i);
  });
});

// ── NP-304 ──────────────────────────────────────────────────────────────
describe('NP-304 — the monthly-orders counter is reconciled nightly', () => {
  it('repairs a counter that drifted BELOW the real order count', async () => {
    const drifty = await makeBusiness({ email: `usagedrift-${Date.now()}` });
    const itemId = (await menuService.create(drifty.id, { name: 'Idli', price: 30 })).id;

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await orderService.create(drifty.id, {
        source: 'takeaway',
        items: [{ menuItemId: itemId, name: 'Idli', price: 30, qty: 1 }],
        tax: 0,
        paymentMethod: 'cash',
      });
    }

    const period = durability.currentPeriod();
    // Simulate the swallowed post-commit bump: the counter lost two of three.
    await query(
      `INSERT INTO usage_counters (business_id, metric, period, count)
       VALUES ($1, 'monthly_orders', $2, 1)
       ON CONFLICT (business_id, metric, period) DO UPDATE SET count = 1`,
      [drifty.id, period],
    );

    const drift = await durability.findUsageDrift();
    const mine = drift.find((d) => d.business_id === drifty.id);
    expect(mine).toBeDefined();
    expect(mine.counted).toBe(1);
    expect(mine.actual_count).toBe(3);

    const res = await durability.reconcileMonthlyOrders();
    const fixed = res.raised.find((r) => r.businessId === drifty.id);
    expect(fixed).toEqual(expect.objectContaining({ from: 1, to: 3 }));

    const after = await query(
      `SELECT count FROM usage_counters
        WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
      [drifty.id, period],
    );
    expect(after.rows[0].count).toBe(3);
    // Idempotent: a second pass finds nothing to raise for this tenant.
    const again = await durability.reconcileMonthlyOrders();
    expect(again.raised.find((r) => r.businessId === drifty.id)).toBeUndefined();
  });

  it('refuses to LOWER a counter that is above reality (that would grant quota)', async () => {
    const inflated = await makeBusiness({ email: `usageover-${Date.now()}` });
    const itemId = (await menuService.create(inflated.id, { name: 'Vada', price: 25 })).id;
    await orderService.create(inflated.id, {
      source: 'takeaway',
      items: [{ menuItemId: itemId, name: 'Vada', price: 25, qty: 1 }],
      tax: 0,
      paymentMethod: 'cash',
    });

    const period = durability.currentPeriod();
    await query(
      `INSERT INTO usage_counters (business_id, metric, period, count)
       VALUES ($1, 'monthly_orders', $2, 50)
       ON CONFLICT (business_id, metric, period) DO UPDATE SET count = 50`,
      [inflated.id, period],
    );

    const res = await durability.reconcileMonthlyOrders();
    expect(res.overCounted.some((o) => o.businessId === inflated.id)).toBe(true);
    expect(res.raised.find((r) => r.businessId === inflated.id)).toBeUndefined();
    const after = await query(
      `SELECT count FROM usage_counters
        WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
      [inflated.id, period],
    );
    expect(after.rows[0].count).toBe(50);
    // …and it is escalated to a human by the nightly integrity email.
    const drift = await durability.checkUsageDrift();
    expect(drift.some((d) => d.business_id === inflated.id)).toBe(true);
  });
});
