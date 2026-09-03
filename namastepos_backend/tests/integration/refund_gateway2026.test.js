// NP-111 (2026-09-03) — gateway refunds actually execute.
//
// refundService.refundOrder used to insert gateway-paid ('online'/'card')
// refunds as status='pending' with a TODO and no worker — owners saw
// "refund initiated" forever. Locks in:
//   • gateway order + recorded razorpay_payment_id → Razorpay refund API is
//     called inline; 'processed' on success, razorpay_refund_id stamped;
//   • gateway failure → row flips to 'failed' with the error detail and the
//     caller gets a 400 (never a silent "initiated");
//   • no razorpay_payment_id on the order → 'failed' + manualRequired flag,
//     gateway never called (refund_status is an ENUM, so the manual flag
//     lives in raw_payload);
//   • Razorpay says 'pending' (genuinely async) → row stays 'pending' with
//     the refund id stamped, and the refund.processed webhook finishes it.
//
// The Razorpay HTTP hop is mocked via refundService._rzCall (module mock —
// same approach as the googleService stub in tests/setup.js).

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const refundService = require('../../src/services/refundService');
const razorpayService = require('../../src/services/razorpayService');

let rzMock;

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => { await closePool(); });

beforeEach(() => {
  rzMock = jest.spyOn(refundService, '_rzCall');
});
afterEach(() => {
  rzMock.mockRestore();
});

async function makeGatewayOrder(biz, {
  orderNo, method = 'online', totalInr = 100, rzPaymentId = null,
} = {}) {
  const ord = await query(
    `INSERT INTO orders (business_id, order_no, source, status, subtotal, total, payment_method)
     VALUES ($1, $2, 'dineIn', 'collected', $3, $3, $4::payment_method)
     RETURNING id`,
    [biz.id, orderNo, totalInr, method]
  );
  const orderId = ord.rows[0].id;
  if (rzPaymentId) {
    await query(
      `INSERT INTO payments (business_id, order_id, method, amount_paise, status, razorpay_payment_id)
       VALUES ($1, $2, 'card', $3, 'captured', $4)`,
      [biz.id, orderId, Math.round(totalInr * 100), rzPaymentId]
    );
  }
  return orderId;
}

describe('NP-111: gateway refund executes inline', () => {
  it('calls Razorpay and marks the refund processed on success', async () => {
    const biz = await makeBusiness({ email: `rf-ok-${Date.now()}` });
    const orderId = await makeGatewayOrder(biz, { orderNo: 9101, rzPaymentId: 'pay_NP111_OK' });
    rzMock.mockResolvedValue({ id: 'rfnd_NP111_OK', status: 'processed' });

    const refund = await refundService.refundOrder({
      businessId: biz.id, orderId, amountInr: 40, reason: 'cold food',
    });

    expect(rzMock).toHaveBeenCalledWith(
      'POST', '/v1/payments/pay_NP111_OK/refund',
      { amount: 4000, notes: { reason: 'cold food' } }
    );
    expect(refund.status).toBe('processed');
    expect(refund.razorpayRefundId).toBe('rfnd_NP111_OK');

    const row = (await query(
      `SELECT status, razorpay_refund_id, processed_at FROM refunds WHERE id = $1`,
      [refund.id]
    )).rows[0];
    expect(row.status).toBe('processed');
    expect(row.razorpay_refund_id).toBe('rfnd_NP111_OK');
    expect(row.processed_at).not.toBeNull();
  });

  it('marks the refund failed (with error detail) and throws when Razorpay rejects', async () => {
    const biz = await makeBusiness({ email: `rf-fail-${Date.now()}` });
    const orderId = await makeGatewayOrder(biz, { orderNo: 9102, rzPaymentId: 'pay_NP111_FAIL' });
    rzMock.mockRejectedValue(new Error('insufficient balance in merchant account'));

    await expect(refundService.refundOrder({
      businessId: biz.id, orderId, amountInr: 25, reason: 'test',
    })).rejects.toThrow(/Razorpay refund failed: insufficient balance/);

    const row = (await query(
      `SELECT status, raw_payload FROM refunds WHERE order_id = $1`, [orderId]
    )).rows[0];
    expect(row.status).toBe('failed'); // never lies as pending/initiated
    expect(row.raw_payload.gatewayError).toMatch(/insufficient balance/);
  });

  it('records failed + manualRequired when the order has no razorpay payment id', async () => {
    const biz = await makeBusiness({ email: `rf-manual-${Date.now()}` });
    // Paid 'card' at the counter but no gateway payment row was ever recorded.
    const orderId = await makeGatewayOrder(biz, { orderNo: 9103, method: 'card', rzPaymentId: null });

    const refund = await refundService.refundOrder({
      businessId: biz.id, orderId, amountInr: 30, reason: 'no gateway id',
    });

    expect(rzMock).not.toHaveBeenCalled(); // nothing to call — never pretend
    expect(refund.status).toBe('failed');

    const row = (await query(
      `SELECT status, raw_payload FROM refunds WHERE id = $1`, [refund.id]
    )).rows[0];
    expect(row.status).toBe('failed');
    expect(row.raw_payload.manualRequired).toBe(true);
    expect(row.raw_payload.manualReason).toMatch(/manually/);
  });

  it('keeps a genuinely-async refund pending and the refund.processed webhook settles it', async () => {
    const biz = await makeBusiness({ email: `rf-async-${Date.now()}` });
    const orderId = await makeGatewayOrder(biz, { orderNo: 9104, rzPaymentId: 'pay_NP111_ASYNC' });
    rzMock.mockResolvedValue({ id: 'rfnd_NP111_ASYNC', status: 'pending' });

    const refund = await refundService.refundOrder({
      businessId: biz.id, orderId, amountInr: 50, reason: 'async',
    });

    // Submitted, awaiting the gateway: pending WITH the refund id stamped
    // (which also keeps the 5-min reconciler from re-submitting it).
    expect(refund.status).toBe('pending');
    expect(refund.razorpayRefundId).toBe('rfnd_NP111_ASYNC');

    await razorpayService.handleWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_NP111_ASYNC', status: 'processed' } } },
    }, `evt_refund_ok_${Date.now()}`);

    const row = (await query(
      `SELECT status, processed_at FROM refunds WHERE id = $1`, [refund.id]
    )).rows[0];
    expect(row.status).toBe('processed');
    expect(row.processed_at).not.toBeNull();
  });

  it('refund.failed webhook flips a pending refund to failed (but never a processed one)', async () => {
    const biz = await makeBusiness({ email: `rf-whfail-${Date.now()}` });
    const orderId = await makeGatewayOrder(biz, { orderNo: 9105, rzPaymentId: 'pay_NP111_WHF' });
    rzMock.mockResolvedValue({ id: 'rfnd_NP111_WHF', status: 'pending' });

    const refund = await refundService.refundOrder({
      businessId: biz.id, orderId, amountInr: 10, reason: 'wh fail',
    });
    expect(refund.status).toBe('pending');

    await razorpayService.handleWebhook({
      event: 'refund.failed',
      payload: { refund: { entity: { id: 'rfnd_NP111_WHF', status: 'failed' } } },
    }, `evt_refund_fail_${Date.now()}`);

    const row = (await query(
      `SELECT status FROM refunds WHERE id = $1`, [refund.id]
    )).rows[0];
    expect(row.status).toBe('failed');

    // Stale/out-of-order refund.failed after processed must NOT downgrade.
    await query(
      `UPDATE refunds SET status = 'processed', processed_at = NOW() WHERE id = $1`,
      [refund.id]
    );
    await razorpayService.handleWebhook({
      event: 'refund.failed',
      payload: { refund: { entity: { id: 'rfnd_NP111_WHF', status: 'failed' } } },
    }, `evt_refund_stale_${Date.now()}`);
    const after = (await query(
      `SELECT status FROM refunds WHERE id = $1`, [refund.id]
    )).rows[0];
    expect(after.status).toBe('processed');
  });
});
