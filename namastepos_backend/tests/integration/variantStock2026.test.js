// NP-205 regression tests (2026-09-04) — EVERY VARIANT OWNS ITS OWN STOCK,
// and `track_stock` (migration 084) says whether a count means anything.
//
// THE TWO BUGS THIS LOCKS DOWN
//
//  1. `menu_item_variants.stock` existed from migration 013 and the menu
//     editor wrote to it, but `orderService.create()` only ever decremented
//     `menu_items.stock`. Selling a Large moved the DISH's shared pool and
//     never Large's own number, so "Large: 3 left" stayed on screen after
//     every Large in the kitchen was gone. Cancels made it worse: they
//     credited the parent, so a sell-then-cancel of one Large left the parent
//     +0 and Large −1 permanently.
//
//  2. `stock = 0` meant EITHER "sold out" OR "I don't track this", and every
//     consumer guessed differently: orderService used `before > 0` (so an
//     untracked item was silently driven to −37), guestController used
//     `stock >= 0 && stock < qty` (so a QR diner was told "only 0 in stock"
//     for a menu nobody had ever counted), and the nightly anomaly alert
//     WhatsApped the owner about all of them. `track_stock` is now the only
//     input to that decision.
//
// THE CONTRACT ASSERTED BELOW
//   track_stock = FALSE → unlimited: never decremented, never restored,
//                         never blocks, no ledger row.
//   track_stock = TRUE  → finite: deduct on sale, restore on cancel, and a
//                         line that would go below zero is 400 OUT_OF_STOCK
//                         naming the item AND the variant.
//   A line with a variantId touches ONLY that variant's row; a line without
//   one touches only the parent's, exactly as before.
//   `trustedChannel` (aggregator) is never BLOCKED — it still deducts, into
//   the negative if need be, so the owner sees reality.

// The concurrency case below needs THREE pool clients at once (two open order
// transactions plus the entitlement lookup `create()` does on the POOL from
// inside its own txn — with a max of 2 that lookup waits on a client that
// cannot be freed until it returns, i.e. a self-inflicted stall).
//
// tests/setup.js pins DB_POOL_MAX to 2 and the pool is built at import time,
// so this MUST run before the require below — it cannot move into beforeAll.
// Assigned UNCONDITIONALLY on purpose: jest reuses a worker process across
// test files, so `|| '6'` would see the '2' a previously-run file already put
// in process.env and silently do nothing. Each file gets a fresh module
// registry, so this file still builds its own pool at this size, and
// `closePool()` in afterAll gives the connections back.
process.env.DB_POOL_MAX = '6';

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const variantService = require('../../src/services/variantService');
const orderService = require('../../src/services/orderService');

let biz;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `varstock-${Date.now()}` });
  // The cancel path (FF-503) refuses to run without a valid reason code.
  await query(
    `INSERT INTO cancel_reasons (business_id, code, label, is_active)
     VALUES ($1, 'CUST_REQ', 'Customer request', TRUE)`,
    [biz.id],
  );
});

afterAll(async () => { await closePool(); });

// ── Fixtures ─────────────────────────────────────────────────────────────
// A fresh item per test: `setVariants` is replace-all per item and every case
// here mutates stock, so sharing one dish would couple the tests.
let seq = 0;
async function mkItem({ stock = 0, trackStock, variants = [] } = {}) {
  seq += 1;
  const item = await menuService.create(biz.id, {
    name: `Dish ${seq}`,
    price: 300,
    stock,
    ...(trackStock === undefined ? {} : { trackStock }),
  });
  const rows = variants.length > 0
    ? await variantService.setVariants(biz.id, item.id, variants)
    : [];
  const byLabel = Object.fromEntries(rows.map((v) => [v.label, v]));
  return { item, variants: byLabel };
}

const body = (items, extra = {}) => ({
  source: 'takeaway',
  items,
  tax: 0,
  paymentMethod: 'cash',
  ...extra,
});

/** One order line. `variantId` null ⇒ a parent-level (no variant) line. */
const line = (item, { variantId = null, qty = 1, price = 300 } = {}) => ({
  menuItemId: item.id,
  name: item.name,
  price,
  qty,
  variantId,
});

const parentStock = async (id) => parseFloat(
  (await query('SELECT stock FROM menu_items WHERE id = $1', [id])).rows[0].stock,
);

const variantStock = async (id) => {
  const r = await query('SELECT stock FROM menu_item_variants WHERE id = $1', [id]);
  return r.rows[0].stock == null ? null : parseFloat(r.rows[0].stock);
};

const ledger = async (menuItemId) => (await query(
  `SELECT variant_id, qty_change, balance_after, reason
     FROM inventory_transactions
    WHERE menu_item_id = $1
    ORDER BY created_at, qty_change`,
  [menuItemId],
)).rows;

// ── 1. The headline: a variant deducts ITSELF ────────────────────────────

describe('NP-205 — a variant line deducts that variant, nothing else', () => {
  it('selling a Large decrements Large, and NOT the parent nor the Small', async () => {
    const { item, variants } = await mkItem({
      stock: 20,
      variants: [
        { label: 'Small', price: 200, stock: 5 },
        { label: 'Large', price: 450, stock: 3 },
      ],
    });
    expect(variants.Large.trackStock).toBe(true); // inferred from stock: 3

    await orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 2, price: 450 }),
    ]));

    expect(await variantStock(variants.Large.id)).toBe(1); // 3 − 2
    expect(await variantStock(variants.Small.id)).toBe(5); // untouched
    expect(await parentStock(item.id)).toBe(20); // untouched — the old bug
  });

  it('writes ONE ledger row carrying the variant identity', async () => {
    const { item, variants } = await mkItem({
      stock: 20,
      variants: [{ label: 'Large', price: 450, stock: 3 }],
    });
    await orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 2, price: 450 }),
    ]));

    const rows = await ledger(item.id);
    expect(rows).toHaveLength(1);
    // menu_item_id stays the PARENT so per-dish reports keep totalling, and
    // variant_id says which size it came out of.
    expect(rows[0].variant_id).toBe(variants.Large.id);
    expect(parseFloat(rows[0].qty_change)).toBe(-2);
    expect(parseFloat(rows[0].balance_after)).toBe(1);
    expect(rows[0].reason).toBe('sale');
  });

  it('two lines of the SAME variant on one order see each other', async () => {
    // Regression guard for the read-then-write shape: both lines re-read the
    // locked row, so the second must start from the first's balance.
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 10 }],
    });
    await orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 3, price: 450 }),
      line(item, { variantId: variants.Large.id, qty: 4, price: 450 }),
    ]));
    expect(await variantStock(variants.Large.id)).toBe(3); // 10 − 3 − 4
    const rows = await ledger(item.id);
    expect(rows.map((r) => parseFloat(r.balance_after)).sort((a, b) => b - a))
      .toEqual([7, 3]);
  });
});

// ── 2. track_stock = FALSE means UNLIMITED ───────────────────────────────

describe('NP-205 — an untracked variant never decrements and never blocks', () => {
  it('sells any quantity, leaves stock alone, writes no ledger row', async () => {
    const { item, variants } = await mkItem({
      variants: [{ label: 'Regular', price: 300 }], // no stock ⇒ untracked
    });
    expect(variants.Regular.trackStock).toBe(false);
    expect(variants.Regular.stock).toBeNull();

    const o = await orderService.create(biz.id, body([
      line(item, { variantId: variants.Regular.id, qty: 99 }),
    ]));
    expect(o.id).toBeTruthy();
    // NOT driven to −99, which is what the old `before > 0` guess did to the
    // parent row on every untracked sale.
    expect(await variantStock(variants.Regular.id)).toBeNull();
    expect(await ledger(item.id)).toHaveLength(0);
  });

  it('stays untracked when a stale count sits in the column', async () => {
    // The explicit toggle wins over the inference: "I have 4 written down but
    // I do not count this dish."
    const { item, variants } = await mkItem({
      variants: [
        {
          label: 'Regular',
          price: 300,
          stock: 4,
          trackStock: false,
        },
      ],
    });
    expect(variants.Regular.trackStock).toBe(false);
    await orderService.create(biz.id, body([
      line(item, { variantId: variants.Regular.id, qty: 10 }),
    ]));
    expect(await variantStock(variants.Regular.id)).toBe(4); // frozen
  });
});

// ── 3. track_stock = TRUE and empty means SOLD OUT ───────────────────────

describe('NP-205 — a tracked variant at 0 is sold out', () => {
  it('rejects with 400 OUT_OF_STOCK naming the item AND the variant', async () => {
    const { item, variants } = await mkItem({
      stock: 50, // parent has plenty — irrelevant, the variant is empty
      variants: [
        {
          label: 'Party Size',
          price: 900,
          stock: 0,
          trackStock: true,
        },
      ],
    });
    expect(variants['Party Size'].trackStock).toBe(true);

    await expect(orderService.create(biz.id, body([
      line(item, { variantId: variants['Party Size'].id, price: 900 }),
    ]))).rejects.toMatchObject({
      statusCode: 400,
      code: 'OUT_OF_STOCK',
      message: `${item.name} (Party Size) is sold out`,
    });

    // And the whole order rolled back — no phantom bill, no ledger row.
    // Scope the count to THIS item, not to `total` — the suite shares one
    // business and earlier cases in this file already booked orders that
    // happen to total 900, which made this assertion fail for the wrong
    // reason (it was measuring test history, not the rollback).
    const orders = await query(
      `SELECT count(*)::int AS c
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.business_id = $1 AND oi.menu_item_id = $2`,
      [biz.id, item.id],
    );
    expect(orders.rows[0].c).toBe(0);
    expect(await ledger(item.id)).toHaveLength(0);
  });

  it('rejects a partial shortfall and says how many are left', async () => {
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 2 }],
    });
    await expect(orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 3, price: 450 }),
    ]))).rejects.toMatchObject({
      statusCode: 400,
      code: 'OUT_OF_STOCK',
      message: `${item.name} (Large) only has 2 left, 3 requested`,
    });
    expect(await variantStock(variants.Large.id)).toBe(2); // rolled back
  });

  it('sells the last unit exactly, down to 0', async () => {
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 2 }],
    });
    await orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 2, price: 450 }),
    ]));
    expect(await variantStock(variants.Large.id)).toBe(0);
    // …and the NEXT one is refused, now on the "is sold out" branch.
    await expect(orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, price: 450 }),
    ]))).rejects.toMatchObject({ message: `${item.name} (Large) is sold out` });
  });
});

// ── 4. The race on the last unit ─────────────────────────────────────────

describe('NP-205 — concurrent sales of the last unit', () => {
  it('lets exactly ONE of two overlapping transactions win', async () => {
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 1 }],
    });
    const one = () => body([
      line(item, { variantId: variants.Large.id, price: 450 }),
    ]);

    // Two genuinely overlapping order transactions on the same variant row.
    // Without the FOR UPDATE both would read stock = 1, both would pass the
    // check, and both would commit → one unit sold twice.
    const results = await Promise.allSettled([
      orderService.create(biz.id, one()),
      orderService.create(biz.id, one()),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({
      statusCode: 400,
      code: 'OUT_OF_STOCK',
    });

    // The invariant that matters: never below zero, exactly one sale row.
    expect(await variantStock(variants.Large.id)).toBe(0);
    const rows = await ledger(item.id);
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].qty_change)).toBe(-1);
  });

  it('blocks a second transaction while the variant row is held', async () => {
    // Direct evidence of the mechanism, independent of scheduling: hold the
    // variant row in one transaction and prove a sale of it cannot proceed
    // until that lock is released.
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 1 }],
    });
    const { getClient } = require('../../src/config/db');
    const holder = await getClient();
    let sale;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM menu_item_variants WHERE id = $1 FOR UPDATE',
        [variants.Large.id],
      );
      sale = orderService.create(biz.id, body([
        line(item, { variantId: variants.Large.id, price: 450 }),
      ]));
      // Still blocked on the row lock after a beat…
      const raced = await Promise.race([
        sale.then(() => 'done', () => 'failed'),
        new Promise((r) => setTimeout(() => r('blocked'), 400)),
      ]);
      expect(raced).toBe('blocked');
      // …then we take the stock away and release.
      await holder.query(
        'UPDATE menu_item_variants SET stock = 0 WHERE id = $1',
        [variants.Large.id],
      );
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    // The waiter re-read the row AFTER our commit (READ COMMITTED re-checks
    // under FOR UPDATE) and saw the truth, not its stale snapshot.
    await expect(sale).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  });
});

// ── 5. Cancels give it back to the row it came from ──────────────────────

describe('NP-205 — a cancel restores the VARIANT, not the parent', () => {
  it('credits the variant and leaves the parent alone', async () => {
    const { item, variants } = await mkItem({
      stock: 20,
      variants: [{ label: 'Large', price: 450, stock: 3 }],
    });
    const o = await orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, qty: 2, price: 450 }),
    ]));
    expect(await variantStock(variants.Large.id)).toBe(1);

    await orderService.updateStatus(biz.id, o.id, 'cancelled', 'test', 'CUST_REQ');

    expect(await variantStock(variants.Large.id)).toBe(3); // whole again
    expect(await parentStock(item.id)).toBe(20); // never inflated
    const ret = (await ledger(item.id)).find((r) => r.reason === 'returned');
    expect(ret.variant_id).toBe(variants.Large.id);
    expect(parseFloat(ret.qty_change)).toBe(2);
    expect(parseFloat(ret.balance_after)).toBe(3);
  });

  it('credits nothing back to an UNTRACKED variant', async () => {
    // Nothing was deducted at create, so crediting on cancel would mint
    // stock out of thin air.
    const { item, variants } = await mkItem({
      variants: [
        {
          label: 'Regular',
          price: 300,
          stock: 4,
          trackStock: false,
        },
      ],
    });
    const o = await orderService.create(biz.id, body([
      line(item, { variantId: variants.Regular.id, qty: 2 }),
    ]));
    await orderService.updateStatus(biz.id, o.id, 'cancelled', 'test', 'CUST_REQ');
    expect(await variantStock(variants.Regular.id)).toBe(4); // not 6
    expect(await ledger(item.id)).toHaveLength(0);
  });
});

// ── 6. The aggregator exemption is unchanged ─────────────────────────────

describe('NP-205 — trustedChannel still bypasses the block', () => {
  it('accepts an aggregator order for a sold-out variant and deducts anyway', async () => {
    const { item, variants } = await mkItem({
      variants: [
        {
          label: 'Large',
          price: 450,
          stock: 0,
          trackStock: true,
        },
      ],
    });
    // Zomato already took the customer's money; refusing it here would only
    // hide the problem from the owner. So: accept, deduct into the negative,
    // and let the count show the truth.
    const o = await orderService.create(
      biz.id,
      body(
        [line(item, { variantId: variants.Large.id, price: 500 })],
        { source: 'zomato', channel: 'zomato' },
      ),
      { trustedChannel: true },
    );
    expect(o.id).toBeTruthy();
    expect(await variantStock(variants.Large.id)).toBe(-1);
    const rows = await ledger(item.id);
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].balance_after)).toBe(-1);
  });
});

// ── 7. The parent path is unchanged ──────────────────────────────────────

describe('NP-205 — a parent-level sale behaves exactly as it did', () => {
  it('decrements menu_items.stock and logs a variant-less ledger row', async () => {
    const { item } = await mkItem({ stock: 20 }); // tracked (stock ≠ 0)
    await orderService.create(biz.id, body([line(item, { qty: 3 })]));
    expect(await parentStock(item.id)).toBe(17);
    const rows = await ledger(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].variant_id).toBeNull();
    expect(parseFloat(rows[0].qty_change)).toBe(-3);
    expect(parseFloat(rows[0].balance_after)).toBe(17);
  });

  it('restores menu_items.stock on cancel', async () => {
    const { item } = await mkItem({ stock: 20 });
    const o = await orderService.create(biz.id, body([line(item, { qty: 3 })]));
    await orderService.updateStatus(biz.id, o.id, 'cancelled', 'test', 'CUST_REQ');
    expect(await parentStock(item.id)).toBe(20);
  });

  it('refuses to oversell a tracked parent', async () => {
    const { item } = await mkItem({ stock: 2 });
    await expect(orderService.create(
      biz.id,
      body([line(item, { qty: 5 })], { source: 'dineIn' }),
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'OUT_OF_STOCK',
      message: `${item.name} only has 2 left, 5 requested`,
    });
    expect(await parentStock(item.id)).toBe(2);
  });

  it('leaves an UNTRACKED parent alone instead of driving it negative', async () => {
    const { item } = await mkItem({ stock: 0 }); // untracked by inference
    await orderService.create(biz.id, body([line(item, { qty: 7 })]));
    expect(await parentStock(item.id)).toBe(0); // was −7 before NP-205
    expect(await ledger(item.id)).toHaveLength(0);
  });

  it('still honours item-level 86 on a variant line', async () => {
    // Sold-out-until is a property of the DISH: 86'ing it takes every size
    // off sale, however much of each size is in the fridge.
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 10 }],
    });
    await variantService.setSoldOut(biz.id, item.id, 'tomorrow_open');
    await expect(orderService.create(biz.id, body([
      line(item, { variantId: variants.Large.id, price: 450 }),
    ]))).rejects.toMatchObject({ message: `${item.name} is sold out` });
    expect(await variantStock(variants.Large.id)).toBe(10);
  });
});

// ── 8. Setting stock from the menu editor + from inventory ───────────────

describe('NP-205 — the write paths owners actually use', () => {
  it('setVariants persists stock + trackStock and round-trips them', async () => {
    const { item, variants } = await mkItem({
      variants: [
        {
          label: 'Large',
          price: 450,
          stock: 6,
          trackStock: true,
        },
      ],
    });
    const listed = await variantService.listVariants(biz.id, item.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ stock: 6, trackStock: true });

    // An edit that omits trackStock must not silently untrack the row.
    const after = await variantService.setVariants(biz.id, item.id, [
      {
        id: variants.Large.id,
        label: 'Large',
        price: 500,
        stock: 6,
      },
    ]);
    expect(after[0]).toMatchObject({
      price: 500,
      stock: 6,
      trackStock: true,
    });
  });

  it('adjustVariantStock books a delta against one size only', async () => {
    const { item, variants } = await mkItem({
      stock: 20,
      variants: [
        { label: 'Small', price: 200, stock: 5 },
        { label: 'Large', price: 450, stock: 3 },
      ],
    });
    const out = await menuService.adjustVariantStock(biz.id, variants.Large.id, {
      delta: 12,
      reason: 'purchase',
      note: 'market run',
    });
    expect(out).toMatchObject({ stock: 15, trackStock: true });
    expect(await variantStock(variants.Small.id)).toBe(5);
    expect(await parentStock(item.id)).toBe(20);

    // The movement is on the ledger, attributed to the variant, and the
    // parent's history still shows it (menu_item_id = parent).
    const all = await menuService.stockHistory(biz.id, item.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      variantId: variants.Large.id,
      qtyChange: 12,
      balanceAfter: 15,
      reason: 'purchase',
    });
    // …and can be narrowed to one size.
    const small = await menuService.stockHistory(biz.id, item.id, {
      variantId: variants.Small.id,
    });
    expect(small).toHaveLength(0);
  });

  it('turns tracking ON when an owner books a count on an untracked variant', async () => {
    const { item, variants } = await mkItem({
      variants: [{ label: 'Regular', price: 300 }],
    });
    expect(variants.Regular.trackStock).toBe(false);
    await menuService.adjustVariantStock(biz.id, variants.Regular.id, { delta: 8 });
    // Recording a count IS the act of choosing to track — and it now bites.
    await expect(orderService.create(biz.id, body([
      line(item, { variantId: variants.Regular.id, qty: 9 }),
    ]))).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  });

  it('refuses a variant id from another business', async () => {
    const other = await makeBusiness({ email: `varstock-other-${Date.now()}` });
    const theirs = await menuService.create(other.id, { name: 'Theirs', price: 10 });
    const rows = await variantService.setVariants(other.id, theirs.id, [
      { label: 'Large', price: 20, stock: 5 },
    ]);
    await expect(menuService.adjustVariantStock(biz.id, rows[0].id, { delta: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await variantStock(rows[0].id)).toBe(5);
  });

  it('hydrates the menu list with variants on ?withVariants', async () => {
    // The web POS decided whether to open its variant picker from
    // `item.variants`, a key GET /menu never returned — so a dish with sizes
    // was added to the cart at the parent price and the picker was dead code.
    const { item, variants } = await mkItem({
      variants: [{ label: 'Large', price: 450, stock: 3 }],
    });
    const plain = await menuService.list(biz.id);
    expect(plain.find((i) => i.id === item.id).variants).toBeUndefined();

    const hydrated = await menuService.list(biz.id, { withVariants: true });
    const mine = hydrated.find((i) => i.id === item.id);
    expect(mine.variants).toHaveLength(1);
    expect(mine.variants[0]).toMatchObject({
      id: variants.Large.id,
      label: 'Large',
      price: 450,
      stock: 3,
      trackStock: true,
    });
  });

  it('backfilled tracking for items that already had a count', async () => {
    // Migration 084's rule, asserted end-to-end through create(): a non-zero
    // opening stock means the owner meant to track it, so already-live
    // tenants keep behaving as they did without touching a toggle.
    const withCount = await menuService.create(biz.id, {
      name: 'Counted dish',
      price: 10,
      stock: 4,
    });
    const without = await menuService.create(biz.id, {
      name: 'Uncounted dish',
      price: 10,
    });
    expect(withCount.trackStock).toBe(true);
    expect(without.trackStock).toBe(false);
  });
});
