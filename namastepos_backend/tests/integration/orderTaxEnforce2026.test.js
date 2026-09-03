// NP-112 regression tests (2026-09-03): server no longer blindly trusts the
// client-sent `tax` and `discount` on order create.
//  - tax is recomputed from menu_items.gst_pct (same computeGstBreakdown
//    semantics as the item-GST branch);
//  - discounts above the FF-502 approval threshold need a manager approval
//    row (/discount-approvals) that create() now consumes.
// Both behaviours are gated by ORDER_TAX_ENFORCE: 'log' (default) only
// warns, 'enforce' overrides / 403s. Aggregator-channel orders stay
// log-only regardless of mode (platform tax is authoritative).

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const logger = require('../../src/config/logger');
const menuService = require('../../src/services/menuService');
const orderService = require('../../src/services/orderService');

let biz;
let itemId; // ₹100, gst 5% (menu_items.gst_pct default) → ₹10 GST on qty 2

const ORIG_MODE = process.env.ORDER_TAX_ENFORCE;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `taxenf-${Date.now()}` });
  const item = await menuService.create(biz.id, { name: 'Paneer Tikka', price: 100 });
  itemId = item.id;
});
afterAll(async () => { await closePool(); });
afterEach(() => {
  if (ORIG_MODE === undefined) delete process.env.ORDER_TAX_ENFORCE;
  else process.env.ORDER_TAX_ENFORCE = ORIG_MODE;
  jest.restoreAllMocks();
});

// Forged body: 2 × ₹100 with menu gst 5% → server expects ₹10 tax, but the
// client claims ₹0 (the "cashier zeroes GST" attack).
function forgedBody(extra = {}) {
  return {
    source: 'takeaway',
    items: [{ menuItemId: itemId, name: 'Paneer Tikka', price: 100, qty: 2 }],
    tax: 0,
    paymentMethod: 'cash',
    ...extra,
  };
}

async function approvalRows() {
  const r = await query(
    'SELECT id, order_id, amount_paise FROM discount_approvals WHERE business_id = $1',
    [biz.id],
  );
  return r.rows;
}

describe('ORDER_TAX_ENFORCE=enforce', () => {
  beforeEach(() => { process.env.ORDER_TAX_ENFORCE = 'enforce'; });

  test('forged tax=0 stores the server-computed GST (and its split)', async () => {
    const o = await orderService.create(biz.id, forgedBody());
    expect(o.tax).toBe(10); // 200 × 5%
    expect(o.cgst).toBe(5);
    expect(o.sgst).toBe(5);
    expect(o.igst).toBe(0);
    expect(o.total).toBe(210); // subtotal 200 + enforced tax 10
  });

  test('over-threshold discount with NO approval → 403 DISCOUNT_APPROVAL_REQUIRED', async () => {
    // Default threshold is ₹100 (discountApprovalService) — ₹150 is above it.
    await expect(orderService.create(biz.id, forgedBody({ discount: 150 })))
      .rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_APPROVAL_REQUIRED' });
  });

  test('over-threshold discount WITH an approval succeeds and claims it', async () => {
    await query(
      `INSERT INTO discount_approvals (business_id, amount_paise, reason)
       VALUES ($1, $2, $3)`,
      [biz.id, 15000, 'regular — manager ok'],
    );
    const o = await orderService.create(biz.id, forgedBody({ discount: 150 }));
    expect(o.discount).toBe(150);

    // The approval is stamped with the order id → can't authorise a second one.
    const rows = await approvalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(o.id);
    await expect(orderService.create(biz.id, forgedBody({ discount: 150 })))
      .rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
  });

  test('TRUSTED server-side caller keeps the platform tax (aggregator/guest paths)', async () => {
    // NP-112 follow-up: the exemption is granted by the trustedChannel option
    // (set only by aggregatorService/guestController), never by body fields.
    const o = await orderService.create(biz.id, forgedBody({
      source: 'zomato', tax: 3, // platform-computed; differs > ₹1 from menu's ₹10
    }), { trustedChannel: true });
    expect(o.tax).toBe(3); // NOT overridden despite enforce mode
  });

  test('client-tagged source/channel does NOT bypass enforcement', async () => {
    // A cashier tagging source:'other'/channel must still get server tax.
    const o = await orderService.create(biz.id, forgedBody({
      source: 'other', channel: 'sneaky', tax: 0,
    }));
    expect(o.tax).toBe(10); // server-computed — exemption not client-grantable
  });
});

describe('ORDER_TAX_ENFORCE=log (default)', () => {
  test('forged tax=0 is accepted but a mismatch warning is logged', async () => {
    delete process.env.ORDER_TAX_ENFORCE;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const o = await orderService.create(biz.id, forgedBody());
    expect(o.tax).toBe(0); // stored value = client value
    expect(o.total).toBe(200); // unchanged bill
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tax mismatch/i));
  });

  test('over-threshold discount is accepted but warned about', async () => {
    delete process.env.ORDER_TAX_ENFORCE;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const o = await orderService.create(biz.id, forgedBody({ discount: 150 }));
    expect(o.discount).toBe(150);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/approval threshold/i));
  });
});
