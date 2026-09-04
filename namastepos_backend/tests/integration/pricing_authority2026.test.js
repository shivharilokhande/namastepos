// NP-201/202/203 regression tests (2026-09-04) — order pricing is
// SERVER-AUTHORITATIVE.
//
// Before this change `orderService.create()` did
//     subtotal += Number(it.price) * Number(it.qty)
// i.e. the CLIENT proposed the selling price, and variant/modifier data was
// persisted verbatim with no check that the variant belonged to the item or
// that a modifier's `priceDelta` matched the DB. A patched app could bill ₹1
// for a ₹300 pizza, or invent a −₹290 "modifier".
//
// What is asserted here:
//   1. a forged CHEAP price is billed at the menu price, and the gap is
//      recorded on orders.price_adjustments (migration 082);
//   2. a forged EXPENSIVE price likewise (the customer is not overcharged
//      either — the menu is the truth in both directions);
//   3. a variant belonging to a DIFFERENT menu item → 400;
//   4. an INACTIVE variant → 400;
//   5. a modifier whose group is not attached to the item → 400;
//   6. a client-invented `priceDelta` is ignored — the DB delta is used and
//      persisted on order_items.modifier_lines;
//   6b. the same option repeated past the group's max_select → 400, and a
//      skipped REQUIRED group (min_select ≥ 1) → 400 for untrusted callers;
//   7. a discount larger than the bill → 400 DISCOUNT_EXCEEDS_BILL
//      (it used to be silently swallowed by Math.max(0, …));
//   8. a discount EXACTLY equal to the bill → succeeds with total 0;
//   9. a trusted-channel (aggregator) line with menuItemId=null keeps its
//      platform price; an untrusted caller sending one is rejected;
//  10. ORDER_TAX_ENFORCE=enforce now computes GST off the SERVER base;
//  11. an ordinary honest order is priced EXACTLY as before (no regression).

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const menuService = require('../../src/services/menuService');
const variantService = require('../../src/services/variantService');
const orderService = require('../../src/services/orderService');

let biz;
let pizzaId; // ₹300, gst 5%
let burgerId; // ₹100, gst 5%
let vMediumId; // pizza variant, ₹300, active
let vLargeId; // pizza variant, ₹450, active
let vRetiredId; // pizza variant, ₹200, INACTIVE
let vBurgerBigId; // BURGER variant, ₹150 (used to prove item mismatch)
let cheeseId; // modifier +₹30, group "Toppings" (multi, max 3) → attached to pizza
let hotId; // modifier +₹0,  group "Spice"    (single, max 1) → attached to pizza
let friesId; // modifier +₹50, group "Sides"   → attached to BURGER only
let thaliId; // ₹180, has a REQUIRED group "Bread" (min_select 1) attached
let naanId; // modifier +₹20 inside the required "Bread" group

const ORIG_MODE = process.env.ORDER_TAX_ENFORCE;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `pricing-${Date.now()}` });

  const pizza = await menuService.create(biz.id, { name: 'Farmhouse Pizza', price: 300 });
  pizzaId = pizza.id;
  const burger = await menuService.create(biz.id, { name: 'Veg Burger', price: 100 });
  burgerId = burger.id;

  // Variants (variantService.setVariants is replace-all).
  const pv = await variantService.setVariants(biz.id, pizzaId, [
    { label: 'Medium', price: 300 },
    { label: 'Large', price: 450 },
  ]);
  vMediumId = pv.find((v) => v.label === 'Medium').id;
  vLargeId = pv.find((v) => v.label === 'Large').id;
  // A soft-retired variant — inserted directly so setVariants' replace-all
  // semantics don't fight the fixture.
  const retired = await query(
    `INSERT INTO menu_item_variants
       (business_id, menu_item_id, label, price, is_active)
     VALUES ($1, $2, 'Party (retired)', 200, FALSE) RETURNING id`,
    [biz.id, pizzaId],
  );
  vRetiredId = retired.rows[0].id;

  const bv = await variantService.setVariants(biz.id, burgerId, [
    { label: 'Big', price: 150 },
  ]);
  vBurgerBigId = bv[0].id;

  // Modifier groups. upsertGroup returns the business's full group list.
  let groups = await variantService.upsertGroup(biz.id, {
    name: 'Toppings',
    kind: 'multi_select',
    minSelect: 0,
    maxSelect: 3,
    modifiers: [{ name: 'Extra Cheese', priceDeltaInr: 30 }],
  });
  groups = await variantService.upsertGroup(biz.id, {
    name: 'Spice',
    kind: 'single_select',
    minSelect: 0,
    maxSelect: 1,
    modifiers: [{ name: 'Hot', priceDeltaInr: 0 }],
  });
  groups = await variantService.upsertGroup(biz.id, {
    name: 'Sides',
    kind: 'multi_select',
    minSelect: 0,
    maxSelect: 2,
    modifiers: [{ name: 'Fries', priceDeltaInr: 50 }],
  });
  // A REQUIRED group (min_select = 1), on its own item so the fixtures above
  // stay unaffected.
  groups = await variantService.upsertGroup(biz.id, {
    name: 'Bread',
    kind: 'single_select',
    minSelect: 1,
    maxSelect: 1,
    modifiers: [
      { name: 'Roti', priceDeltaInr: 0 },
      { name: 'Naan', priceDeltaInr: 20 },
    ],
  });
  const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
  cheeseId = byName.Toppings.modifiers.find((m) => m.name === 'Extra Cheese').id;
  hotId = byName.Spice.modifiers.find((m) => m.name === 'Hot').id;
  friesId = byName.Sides.modifiers.find((m) => m.name === 'Fries').id;
  naanId = byName.Bread.modifiers.find((m) => m.name === 'Naan').id;

  const thali = await menuService.create(biz.id, { name: 'Thali', price: 180 });
  thaliId = thali.id;

  await variantService.setItemModifierGroups(
    biz.id,
    pizzaId,
    [byName.Toppings.id, byName.Spice.id],
  );
  await variantService.setItemModifierGroups(biz.id, burgerId, [byName.Sides.id]);
  await variantService.setItemModifierGroups(biz.id, thaliId, [byName.Bread.id]);
});

afterAll(async () => { await closePool(); });

beforeEach(() => {
  // The pricing rules below are NOT env-gated (unlike the NP-112 tax
  // recompute) — pin the default mode so a sibling suite that set
  // ORDER_TAX_ENFORCE in the same jest process can't influence these.
  delete process.env.ORDER_TAX_ENFORCE;
});
afterEach(() => {
  if (ORIG_MODE === undefined) delete process.env.ORDER_TAX_ENFORCE;
  else process.env.ORDER_TAX_ENFORCE = ORIG_MODE;
});

const body = (items, extra = {}) => ({
  source: 'takeaway',
  items,
  tax: 0,
  paymentMethod: 'cash',
  ...extra,
});

async function adjustmentsOf(orderId) {
  const r = await query('SELECT price_adjustments FROM orders WHERE id = $1', [orderId]);
  return r.rows[0].price_adjustments;
}

async function itemRowsOf(orderId) {
  const r = await query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  return r.rows;
}

describe('NP-201 — the client cannot propose the selling price', () => {
  it('bills a forged CHEAP line at the menu price and records the gap', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 1, qty: 2 },
    ]));
    // ₹1 × 2 was the forgery; ₹300 × 2 is the truth.
    expect(o.subtotal).toBe(600);
    expect(o.total).toBe(600); // tax stays client-side in default 'log' mode
    const [row] = await itemRowsOf(o.id);
    expect(parseFloat(row.price)).toBe(300);

    const adj = await adjustmentsOf(o.id);
    expect(adj).toEqual([{
      menuItemId: pizzaId,
      name: 'Farmhouse Pizza',
      clientPrice: 1,
      serverPrice: 300,
      qty: 2,
    }]);
    // ...and it's surfaced on the API shape, not just in the table.
    expect(o.priceAdjustments).toEqual(adj);
  });

  it('bills a forged EXPENSIVE line at the menu price too', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 5000, qty: 1 },
    ]));
    expect(o.subtotal).toBe(300);
    const adj = await adjustmentsOf(o.id);
    expect(adj).toHaveLength(1);
    expect(adj[0].clientPrice).toBe(5000);
    expect(adj[0].serverPrice).toBe(300);
  });

  it('rejects a menu item that belongs to another business', async () => {
    const other = await makeBusiness({ email: `other-${Date.now()}` });
    const theirs = await menuService.create(other.id, { name: 'Their Thali', price: 5 });
    await expect(orderService.create(biz.id, body([
      { menuItemId: theirs.id, name: 'Their Thali', price: 5, qty: 1 },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MENU_ITEM_NOT_FOUND' });
  });
});

describe('NP-202 — variant validation', () => {
  it('prices from the VARIANT, not the parent item', async () => {
    const o = await orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 300,
        qty: 1,
        variantId: vLargeId,
        variantLabel: 'lies',
      },
    ]));
    expect(o.subtotal).toBe(450);
    const [row] = await itemRowsOf(o.id);
    expect(row.variant_id).toBe(vLargeId);
    expect(row.variant_label).toBe('Large'); // server's label, not "lies"
    // client said ₹300, variant says ₹450 → recorded
    const adj = await adjustmentsOf(o.id);
    expect(adj[0]).toMatchObject({ clientPrice: 300, serverPrice: 450 });
  });

  it('rejects a variant that belongs to a DIFFERENT menu item', async () => {
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 150,
        qty: 1,
        variantId: vBurgerBigId,
        variantLabel: 'Big',
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_ITEM_MISMATCH' });
  });

  it('rejects an INACTIVE variant', async () => {
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 200,
        qty: 1,
        variantId: vRetiredId,
        variantLabel: 'Party (retired)',
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_INACTIVE' });
  });

  it('rejects a variant from another business', async () => {
    const other = await makeBusiness({ email: `othervar-${Date.now()}` });
    const theirItem = await menuService.create(other.id, { name: 'Their Pizza', price: 10 });
    const theirVar = await variantService.setVariants(other.id, theirItem.id, [
      { label: 'Cheap', price: 1 },
    ]);
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 1,
        qty: 1,
        variantId: theirVar[0].id,
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_NOT_FOUND' });
  });
});

describe('NP-202 — modifier validation', () => {
  it('rejects a modifier whose group is not attached to the item', async () => {
    // "Fries" lives in the Sides group, which is attached to the BURGER.
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 350,
        qty: 1,
        modifierLines: [{
          groupId: null,
          groupLabel: 'Sides',
          optionId: friesId,
          optionLabel: 'Fries',
          priceDelta: 50,
        }],
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MODIFIER_NOT_ATTACHED' });
  });

  it('rejects an unknown modifier id', async () => {
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 300,
        qty: 1,
        modifierLines: [{
          optionId: '00000000-0000-4000-8000-000000000000',
          optionLabel: 'Free Everything',
          priceDelta: -300,
        }],
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MODIFIER_NOT_FOUND' });
  });

  it('IGNORES a client-invented priceDelta and uses the DB delta', async () => {
    const o = await orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 10,
        qty: 1,
        modifierLines: [{
          groupId: null,
          groupLabel: 'whatever',
          optionId: cheeseId,
          optionLabel: 'Free Cheese',
          priceDelta: -290, // the forgery
        }],
      },
    ]));
    // 300 (menu) + 30 (DB delta) = 330 — NOT 10, and NOT 300-290.
    expect(o.subtotal).toBe(330);
    const [row] = await itemRowsOf(o.id);
    expect(parseFloat(row.price)).toBe(330);
    // The persisted line carries the SERVER's label + delta, in both the
    // mobile (optionLabel/priceDelta) and web (name/priceDeltaInr) spellings.
    expect(row.modifier_lines).toHaveLength(1);
    expect(row.modifier_lines[0]).toMatchObject({
      optionId: cheeseId,
      optionLabel: 'Extra Cheese',
      priceDelta: 30,
      name: 'Extra Cheese',
      priceDeltaInr: 30,
    });
  });

  it('accepts the web dashboard modifier shape (modifierId/priceDeltaInr)', async () => {
    const o = await orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 330,
        qty: 1,
        modifierLines: [{
          modifierId: cheeseId, name: 'Extra Cheese', priceDeltaInr: 30, qty: 1,
        }],
      },
    ]));
    expect(o.subtotal).toBe(330);
    expect(await adjustmentsOf(o.id)).toBeNull(); // client and server agreed
  });

  it('rejects more selections than the group\'s max_select allows', async () => {
    // "Spice" is single_select / max_select = 1 — repeating the same ₹0 option
    // is harmless here, but the same trick on a NEGATIVE-delta option is how
    // you'd drive a line to zero.
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 300,
        qty: 1,
        modifierLines: [
          { optionId: hotId, optionLabel: 'Hot', priceDelta: 0 },
          { optionId: hotId, optionLabel: 'Hot', priceDelta: 0 },
        ],
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MODIFIER_MAX_EXCEEDED' });
  });

  it('rejects a line that skips a REQUIRED group (min_select 1)', async () => {
    await expect(orderService.create(biz.id, body([
      { menuItemId: thaliId, name: 'Thali', price: 180, qty: 1 },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MODIFIER_MIN_NOT_MET' });
  });

  it('accepts the same line once the required group is satisfied', async () => {
    const o = await orderService.create(biz.id, body([
      {
        menuItemId: thaliId,
        name: 'Thali',
        price: 200,
        qty: 1,
        modifierLines: [{ optionId: naanId, optionLabel: 'Naan', priceDelta: 20 }],
      },
    ]));
    expect(o.subtotal).toBe(200); // 180 + 20
    expect(await adjustmentsOf(o.id)).toBeNull();
  });

  it('exempts a TRUSTED channel from the required-group rule', async () => {
    // Aggregator + guest-QR payload schemas cannot express modifiers at all,
    // so requiring one there would drop real orders.
    const o = await orderService.create(biz.id, body([
      { menuItemId: thaliId, name: 'Thali', price: 210, qty: 1 },
    ], { source: 'zomato', channel: 'zomato' }), { trustedChannel: true });
    expect(o.subtotal).toBe(210);
  });

  it('rejects a modifier line with no resolvable id', async () => {
    await expect(orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 300,
        qty: 1,
        modifierLines: [{ optionLabel: 'Handwritten freebie', priceDelta: -100 }],
      },
    ]))).rejects.toMatchObject({ statusCode: 400, code: 'MODIFIER_NOT_IDENTIFIED' });
  });
});

describe('NP-203 — discount cap', () => {
  it('rejects a discount larger than the bill', async () => {
    // ₹300 bill, ₹301 discount. Previously: total 0, discount 301 in every
    // report. Now: 400 and no order at all.
    await expect(orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 300, qty: 1 },
    ], { discount: 301 })))
      .rejects.toMatchObject({ statusCode: 400, code: 'DISCOUNT_EXCEEDS_BILL' });
  });

  it('allows a discount EXACTLY equal to the bill (total 0)', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 300, qty: 1 },
    ], { discount: 300 }));
    expect(o.subtotal).toBe(300);
    expect(o.discount).toBe(300);
    expect(o.total).toBe(0);
  });

  it('caps against the SERVER subtotal, not the forged one', async () => {
    // Forged price ₹1000 would have "justified" a ₹1000 discount; the real
    // bill is ₹300, so ₹1000 must be refused.
    await expect(orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 1000, qty: 1 },
    ], { discount: 1000 })))
      .rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_BILL' });
  });
});

describe('trusted-channel compatibility', () => {
  it('keeps the platform price on an unmapped aggregator line', async () => {
    const o = await orderService.create(biz.id, body([
      { menuItemId: null, name: '[unmapped] Zomato Combo', price: 275, qty: 2 },
    ], { source: 'zomato', channel: 'zomato' }), { trustedChannel: true });
    expect(o.subtotal).toBe(550);
    const [row] = await itemRowsOf(o.id);
    expect(row.menu_item_id).toBeNull();
    expect(parseFloat(row.price)).toBe(275);
  });

  it('keeps the platform price on a MAPPED aggregator line (payout parity)', async () => {
    // Zomato sells off its own, higher menu; re-pricing to our ₹300 would
    // break reconciliation. Divergence is logged, not applied.
    const o = await orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 399, qty: 1 },
    ], { source: 'zomato', channel: 'zomato' }), { trustedChannel: true });
    expect(o.subtotal).toBe(399);
    expect(await adjustmentsOf(o.id)).toBeNull(); // nothing was overridden
  });

  it('REJECTS an unmapped line from an untrusted caller', async () => {
    // A cashier tagging source:'other' used to get the same free pass the
    // aggregator webhook has — and with it the right to name any price.
    await expect(orderService.create(biz.id, body([
      { menuItemId: null, name: 'Off-menu special', price: 1, qty: 1 },
    ], { source: 'other', channel: 'sneaky' })))
      .rejects.toMatchObject({ statusCode: 400, code: 'ITEM_NOT_MAPPED' });
  });
});

describe('interaction with the NP-112 tax recompute', () => {
  it('ORDER_TAX_ENFORCE=enforce computes GST off the SERVER base', async () => {
    process.env.ORDER_TAX_ENFORCE = 'enforce';
    const o = await orderService.create(biz.id, body([
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 1, qty: 1 },
    ]));
    // Base ₹300 (not the forged ₹1) at the menu's 5% → ₹15 GST.
    expect(o.subtotal).toBe(300);
    expect(o.tax).toBe(15);
    expect(o.cgst).toBe(7.5);
    expect(o.sgst).toBe(7.5);
    expect(o.total).toBe(315);
  });
});

describe('no regression for an honest order', () => {
  it('prices an honest multi-line order exactly as before', async () => {
    const o = await orderService.create(biz.id, {
      source: 'takeaway',
      items: [
        { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 300, qty: 2 },
        { menuItemId: burgerId, name: 'Veg Burger', price: 100, qty: 1 },
      ],
      tax: 35, // 5% of 700 — matches the menu, so nothing is overridden
      paymentMethod: 'cash',
    });
    expect(o.subtotal).toBe(700);
    expect(o.tax).toBe(35);
    expect(o.discount).toBe(0);
    expect(o.total).toBe(735);
    expect(o.priceAdjustments).toBeNull();
    const rows = await itemRowsOf(o.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => parseFloat(r.price)).sort((a, b) => a - b)).toEqual([100, 300]);
    expect(rows.every((r) => r.modifier_lines === null)).toBe(true);
    expect(rows.every((r) => r.variant_id === null)).toBe(true);
  });

  it('prices an honest variant + modifier order without any adjustment', async () => {
    const o = await orderService.create(biz.id, body([
      {
        menuItemId: pizzaId,
        name: 'Farmhouse Pizza',
        price: 480,
        qty: 1,
        variantId: vLargeId,
        variantLabel: 'Large',
        modifierLines: [{
          groupId: null,
          groupLabel: 'Toppings',
          optionId: cheeseId,
          optionLabel: 'Extra Cheese',
          priceDelta: 30,
        }],
      },
      { menuItemId: pizzaId, name: 'Farmhouse Pizza', price: 300, qty: 1, variantId: vMediumId },
    ]));
    expect(o.subtotal).toBe(780); // (450 + 30) + 300
    expect(await adjustmentsOf(o.id)).toBeNull();
  });
});
