// NamastePOS backend - public guest endpoints (no auth — token-driven)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const crypto = require('crypto');
const qr = require('../services/qrService');
const orderService = require('../services/orderService');
const otpService = require('../services/otpService');
const env = require('../config/env');
// FF-250 needs these for the guest Razorpay checkout endpoints.
const { query } = require('../config/db');
const { BadRequest } = require('../utils/errors');

// ── Guest membership-benefit OTP gate (2026-08-30) ────────────────────────
// A guest who typed a member's phone could spend that member's prepaid bundle.
// So the guest path only applies membership benefits after the phone proves
// ownership via OTP. On success we mint a short-lived HMAC token binding
// (businessId, phone); placeOrder requires it before passing
// allowMemberBenefits:true to orderService.create.
const BENEFIT_TOKEN_TTL_MS = 15 * 60 * 1000;

function _mintBenefitToken(businessId, phone) {
  const norm = otpService._normalizePhone(phone);
  const payload = `${businessId}:${norm}:${Date.now() + BENEFIT_TOKEN_TTL_MS}`;
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function _benefitTokenValid(token, businessId, phone) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [b64, sig] = token.split('.');
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return false; }
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex');
  // constant-time compare
  const a = Buffer.from(sig); const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return false;
  const [bid, phn, expStr] = payload.split(':');
  if (bid !== businessId) return false;
  if (phn !== otpService._normalizePhone(phone || '')) return false;
  if (Number(expStr) < Date.now()) return false;
  return true;
}

// Does this phone hold an active membership bundle at this business?
async function _hasMembershipBenefit(businessId, phone) {
  if (!phone) return false;
  const r = await query(
    `SELECT 1
       FROM membership_subscriptions ms
       JOIN customers c ON c.id = ms.customer_id
      WHERE ms.business_id = $1 AND c.phone = $2
        AND ms.status = 'active' AND ms.expires_at > NOW()
        AND ms.remaining IS NOT NULL
      LIMIT 1`,
    [businessId, phone]
  );
  return r.rowCount > 0;
}

// ── GET /v1/guest/menu/:token ──────────────────────────────────────────
const menu = asyncHandler(async (req, res) => {
  const { businessId, tableId, business, table } = await qr.verifyToken(req.params.token);
  const items = await qr.guestMenu(businessId);
  const settings = await qr.getSettings(businessId);
  if (!settings.isEnabled) {
    return res.status(503).json({ error: 'QR_DISABLED', message: 'Guest ordering is paused. Ask the staff.' });
  }
  res.json({
    business: { name: business.name, logoUrl: business.logoUrl },
    table: { label: table.label, floor: table.floorName },
    settings,
    items,
  });
});

// ── POST /v1/guest/orders/:token ───────────────────────────────────────
const orderBody = Joi.object({
  items: Joi.array().items(Joi.object({
    menuItemId: Joi.string().uuid().required(),
    name: Joi.string().required(),
    price: Joi.number().min(0).required(),
    qty: Joi.number().positive().required(),
    note: Joi.string().max(500).allow('', null),
  })).min(1).required(),
  customerPhone: Joi.string().max(20).allow('', null),
  customerName: Joi.string().max(255).allow('', null),
  clientId: Joi.string().uuid().allow(null),
  // Optional proof (from the OTP step) that the phone owns its membership.
  benefitToken: Joi.string().max(500).allow('', null),
});

// POST /v1/guest/benefit/check/:token  { phone }
// If the phone has an active membership benefit, send an OTP to it and ask
// the guest to verify. If not, respond otpRequired:false (fast path — no
// friction for normal guests).
const benefitCheck = [
  validate({ body: Joi.object({ phone: Joi.string().max(20).required() }) }),
  asyncHandler(async (req, res) => {
    const { businessId } = await qr.verifyToken(req.params.token);
    const has = await _hasMembershipBenefit(businessId, req.body.phone);
    if (!has) return res.json({ otpRequired: false });
    const { requestId } = await otpService.requestOtp({
      phone: req.body.phone, purpose: 'guest_benefit', meta: { businessId },
    });
    res.json({ otpRequired: true, requestId });
  }),
];

// POST /v1/guest/benefit/verify/:token  { requestId, code, phone }
// Verifies the OTP and returns a short-lived benefitToken to attach to the
// order so its membership benefit is honored.
const benefitVerify = [
  validate({ body: Joi.object({
    requestId: Joi.string().required(),
    code: Joi.string().required(),
    phone: Joi.string().max(20).required(),
  }) }),
  asyncHandler(async (req, res) => {
    const { businessId } = await qr.verifyToken(req.params.token);
    const result = await otpService.verifyOtp({
      requestId: req.body.requestId, code: req.body.code,
    });
    // SECURITY (2026-08-30 review): bind the benefit token to the phone the OTP
    // was actually SENT to (result.phone), never the client-supplied phone —
    // otherwise an attacker who completes any OTP on their own number could
    // mint a token for a victim's number and drain their bundle. Also require
    // this OTP was minted by benefitCheck for THIS business (purpose + meta),
    // so an OTP from another flow (e.g. aggregator link) can't be reused here.
    if (result.purpose !== 'guest_benefit' || result.meta?.businessId !== businessId) {
      throw new BadRequest('This code is not valid for membership verification');
    }
    res.json({ benefitToken: _mintBenefitToken(businessId, result.phone) });
  }),
];

const placeOrder = [
  validate({ body: orderBody }),
  asyncHandler(async (req, res) => {
    const { businessId, tableId } = await qr.verifyToken(req.params.token);

    // Make sure the menu items the guest sent are real and the prices
    // match what's currently on file (anti-tamper).
    const { query } = require('../config/db');
    const ids = req.body.items.map((i) => i.menuItemId);
    const checkR = await query(
      `SELECT id, name, price, is_active, stock FROM menu_items
        WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, ids]
    );
    const byId = new Map(checkR.rows.map((m) => [m.id, m]));
    for (const it of req.body.items) {
      const m = byId.get(it.menuItemId);
      if (!m || !m.is_active) {
        return res.status(400).json({
          error: 'INVALID_ITEM',
          message: `${it.name} is no longer available.`,
        });
      }
      if (Math.abs(parseFloat(m.price) - Number(it.price)) > 0.01) {
        return res.status(400).json({
          error: 'PRICE_MISMATCH',
          message: `Price for ${m.name} has changed. Please refresh and try again.`,
        });
      }
      // Push 15j — only enforce stock when the owner is actually tracking
      // it. Negative stock means orders went through without inventory
      // tracking and isn't a "real" out-of-stock signal. NULL stock means
      // the item isn't tracked. So we only reject when stock is a strictly
      // positive number AND the order would exceed it.
      if (m.stock !== null && parseFloat(m.stock) >= 0
          && parseFloat(m.stock) < Number(it.qty)) {
        return res.status(400).json({
          error: 'OUT_OF_STOCK',
          message: `${m.name} only has ${m.stock} in stock right now.`,
        });
      }
    }

    // Find / create the table session this order belongs to
    const { tableSessionId, guestSessionId } = await qr.ensureGuestSession({
      businessId, tableId,
      customerPhone: req.body.customerPhone,
      customerName: req.body.customerName,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Create the order — reuse our shared orderService.create so we get
    // KOT generation, stock deduction, loyalty (if enabled), etc.
    // We mark source = 'qr' and bind to the table_session_id we just got.
    // Only honor the phone's membership benefit if a valid OTP-minted token
    // for THIS business + phone accompanies the order (2026-08-30 security fix).
    const allowMemberBenefits = _benefitTokenValid(
      req.body.benefitToken, businessId, req.body.customerPhone
    );

    const order = await orderService.create(businessId, {
      clientId: req.body.clientId,
      // Bug fix (B2): 'qr' is not a member of the order_source enum
      // (dineIn/takeaway/zomato/swiggy/other). Guest QR orders belong
      // in `other`; the caller flow is already routed via the guest
      // controller so we don't lose channel context.
      source: 'other',
      channel: 'qr',
      tableNo: null,
      customerPhone: req.body.customerPhone,
      customerName: req.body.customerName,
      items: req.body.items,
      paymentMethod: 'unpaid',  // settle later at the counter
      allowMemberBenefits,
    });

    // Link the order to the session + table (orderService doesn't know about these)
    await query(
      `UPDATE orders SET table_id = $1, table_session_id = $2
        WHERE id = $3`,
      [tableId, tableSessionId, order.id]
    );

    await qr.recordGuestSessionOrder({
      guestSessionId, totalInr: order.total,
    });

    res.status(201).json({
      order: { id: order.id, orderNo: order.orderNo, total: order.total },
      message: 'Order placed! Your food is on its way.',
    });
  }),
];

// ── GET /v1/guest/orders/:token/:orderId (status tracking) ─────────────
const orderStatus = asyncHandler(async (req, res) => {
  const { businessId } = await qr.verifyToken(req.params.token);
  const status = await qr.guestOrderStatus(req.params.orderId, businessId);
  res.json(status);
});

// ── FF-250 — Guest-side Razorpay checkout ─────────────────────────────
// After placing an order the guest calls this to get a Razorpay
// order_id + key, then opens Checkout.js in their browser. On
// success Checkout.js hits `confirmPayment` below with the signature.
// (Joi / validate / errors / query are already imported at the top
// of this file — do NOT redeclare them here or Node throws
// "Identifier 'Joi' has already been declared".)
const razorpay = require('../services/razorpayService');

const createCheckoutOrder = asyncHandler(async (req, res) => {
  const { businessId } = await qr.verifyToken(req.params.token);
  const o = await query(
    `SELECT id, order_no, total FROM orders
      WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [req.params.orderId, businessId]
  );
  if (o.rowCount === 0) throw new BadRequest('Order not found');
  const amountPaise = Math.round(parseFloat(o.rows[0].total) * 100);
  const receipt = `guest-${o.rows[0].order_no}-${o.rows[0].id.slice(0, 8)}`;
  const rz = await razorpay.createCheckoutOrder({
    amountPaise,
    receiptId: receipt,
    notes: { businessId, orderId: o.rows[0].id, source: 'guest-qr' },
  });
  res.json(rz);
});

const confirmPayment = [
  validate({ body: Joi.object({
    razorpayOrderId:   Joi.string().required(),
    razorpayPaymentId: Joi.string().required(),
    razorpaySignature: Joi.string().required(),
  }) }),
  asyncHandler(async (req, res) => {
    const { businessId } = await qr.verifyToken(req.params.token);
    const ok = razorpay.verifyCheckoutSignature({
      orderId:   req.body.razorpayOrderId,
      paymentId: req.body.razorpayPaymentId,
      signature: req.body.razorpaySignature,
    });
    if (!ok) throw new BadRequest('Invalid Razorpay signature');
    // SECURITY (2026-08-25, review finding #1 — payment bypass): the HMAC
    // above only proves the (razorpayOrderId, paymentId) pair is genuine.
    // It does NOT bind the payment to THIS order — a guest could pay ₹10
    // on their own cheap order and replay that valid signature against
    // ANY orderId to mark it collected. createCheckoutOrder stored our
    // orderId/businessId in the Razorpay order's notes, so re-fetch it
    // and require (a) notes.orderId == the path orderId, (b) notes
    // .businessId == this QR token's business, (c) paid amount == the
    // order's total. Reject with 400 on any mismatch.
    const rzOrder = await razorpay.getOrder(req.body.razorpayOrderId);
    if (rzOrder?.notes?.orderId !== req.params.orderId
        || rzOrder?.notes?.businessId !== businessId) {
      throw new BadRequest('Payment does not belong to this order');
    }
    const own = await query(
      `SELECT id, total FROM orders
        WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [req.params.orderId, businessId]
    );
    if (own.rowCount === 0) throw new BadRequest('Order not found');
    const expectedPaise = Math.round(parseFloat(own.rows[0].total) * 100);
    if (Number(rzOrder.amount) !== expectedPaise) {
      throw new BadRequest('Payment amount does not match the order total');
    }
    // Mark the order paid + record the payment. We don't know the
    // exact method (UPI vs card) client-side, so we default to 'upi'
    // — the webhook path in razorpayService.handleWebhook will
    // reconcile with the real method within seconds.
    // 2026-08-25 (finding #1): payment_method flips only while 'unpaid'
    // (idempotent), and the status flip now goes through
    // orderService.updateStatus (no user id needed) so the guest path
    // gets the same transition matrix, KOT sync and idempotent
    // "already collected" no-op as the staff POS instead of a raw
    // unconditional UPDATE.
    await query(
      `UPDATE orders
          SET payment_method = 'upi', updated_at = NOW()
        WHERE id = $1 AND business_id = $2
          AND payment_method = 'unpaid'::payment_method`,
      [req.params.orderId, businessId]
    );
    await orderService.updateStatus(businessId, req.params.orderId, 'collected');
    await query(
      `INSERT INTO payments (business_id, order_id, method, amount_paise,
                              status, razorpay_payment_id)
       SELECT $1, $2, 'upi', ROUND(total * 100), 'captured', $3
         FROM orders WHERE id = $2
       ON CONFLICT DO NOTHING`,
      [businessId, req.params.orderId, req.body.razorpayPaymentId]
    );
    res.json({ ok: true });
  }),
];

// ── FF-251 — Running bill + pay-all from same QR ──────────────────────
// Dine-in customers add items over the course of the meal; at any
// point they want to see "how much is my bill?" and pay for it in
// one Razorpay checkout — same QR, no owner-side action.

// GET /guest/session/:token/current
//   Returns the open table_session for this QR's table with every
//   KOT rolled up. If no session is open, returns {session: null}
//   so the client hides the bill tab.
const getRunningSession = asyncHandler(async (req, res) => {
  const { businessId, tableId } = await qr.verifyToken(req.params.token);
  const sess = await query(
    `SELECT ts.id, ts.opened_at, ts.customer_phone, ts.customer_name
       FROM table_sessions ts
      WHERE ts.business_id = $1 AND ts.table_id = $2 AND ts.closed_at IS NULL
      ORDER BY ts.opened_at DESC LIMIT 1`,
    [businessId, tableId]
  );
  if (sess.rowCount === 0) return res.json({ session: null });
  const session = sess.rows[0];
  const orders = await query(
    `SELECT id, order_no, subtotal, tax, discount, total, status,
            service_charge_paise, round_off_paise, created_at, payment_method
       FROM orders
      WHERE business_id = $1 AND table_session_id = $2
        AND status <> 'cancelled'
      ORDER BY created_at`,
    [businessId, session.id]
  );
  const items = await query(
    `SELECT oi.order_id, oi.name, oi.qty, oi.price, oi.note
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.business_id = $1 AND o.table_session_id = $2
        AND o.status <> 'cancelled'
      ORDER BY o.created_at, oi.id`,
    [businessId, session.id]
  );
  const totals = orders.rows.reduce((acc, o) => ({
    subtotal: acc.subtotal + parseFloat(o.subtotal),
    tax:      acc.tax      + parseFloat(o.tax),
    discount: acc.discount + parseFloat(o.discount),
    total:    acc.total    + parseFloat(o.total),
  }), { subtotal: 0, tax: 0, discount: 0, total: 0 });
  // If every order in this session is already collected, the customer
  // has paid — surface that so the UI shows "Paid" instead of Pay Now.
  const anyUnpaid = orders.rows.some((o) => o.status !== 'collected');
  res.json({
    session: {
      id: session.id,
      openedAt: session.opened_at,
      customerName: session.customer_name,
      customerPhone: session.customer_phone,
      orders: orders.rows.map((o) => ({
        id: o.id, orderNo: o.order_no,
        subtotal: parseFloat(o.subtotal),
        tax: parseFloat(o.tax),
        discount: parseFloat(o.discount),
        total: parseFloat(o.total),
        status: o.status,
        paymentMethod: o.payment_method,
        items: items.rows.filter((i) => i.order_id === o.id).map((i) => ({
          name: i.name, qty: parseFloat(i.qty),
          price: parseFloat(i.price), note: i.note,
        })),
      })),
      totals,
      paid: !anyUnpaid,
    },
  });
});

// POST /guest/session/:token/pay
//   Creates a Razorpay Order for the session's grand total. Returns
//   the Checkout.js payload for the browser to open.
const paySession = asyncHandler(async (req, res) => {
  const { businessId, tableId } = await qr.verifyToken(req.params.token);
  const s = await query(
    `SELECT ts.id, COALESCE(SUM(o.total), 0)::float AS total
       FROM table_sessions ts
  LEFT JOIN orders o ON o.table_session_id = ts.id
                    AND o.status NOT IN ('cancelled','collected')
      WHERE ts.business_id = $1 AND ts.table_id = $2 AND ts.closed_at IS NULL
      GROUP BY ts.id
      ORDER BY ts.opened_at DESC LIMIT 1`,
    [businessId, tableId]
  );
  if (s.rowCount === 0) throw new BadRequest('No open bill on this table');
  const { id: sessionId, total } = s.rows[0];
  if (total <= 0) throw new BadRequest('Nothing to pay — the bill is already settled');
  const amountPaise = Math.round(parseFloat(total) * 100);
  const rz = await razorpay.createCheckoutOrder({
    amountPaise,
    receiptId: `sess-${sessionId.slice(0, 8)}`,
    notes: { businessId, sessionId, source: 'guest-qr-session' },
  });
  res.json({ ...rz, sessionId });
});

// POST /guest/session/:token/confirm-pay
//   Verifies Razorpay signature and settles every open order under
//   the session in one atomic transaction. Closes the table_session.
const confirmSessionPayment = [
  validate({ body: Joi.object({
    sessionId:         Joi.string().uuid().required(),
    razorpayOrderId:   Joi.string().required(),
    razorpayPaymentId: Joi.string().required(),
    razorpaySignature: Joi.string().required(),
  })}),
  asyncHandler(async (req, res) => {
    const { businessId } = await qr.verifyToken(req.params.token);
    const ok = razorpay.verifyCheckoutSignature({
      orderId:   req.body.razorpayOrderId,
      paymentId: req.body.razorpayPaymentId,
      signature: req.body.razorpaySignature,
    });
    if (!ok) throw new BadRequest('Invalid Razorpay signature');
    // SECURITY (2026-08-25, review finding #1 — payment bypass): same
    // binding as confirmPayment above — the HMAC alone lets a valid
    // signature from a cheap paid order settle ANY session. paySession
    // stored our sessionId/businessId in the Razorpay order's notes;
    // re-fetch and require the notes to match this session/business AND
    // the paid amount to equal the session's outstanding total. A repeat
    // confirm (or a stale checkout after more KOTs were added) fails the
    // due/amount check → 400, which also gives this endpoint the
    // idempotency it was missing.
    const rzOrder = await razorpay.getOrder(req.body.razorpayOrderId);
    if (rzOrder?.notes?.sessionId !== req.body.sessionId
        || rzOrder?.notes?.businessId !== businessId) {
      throw new BadRequest('Payment does not belong to this bill');
    }
    const due = await query(
      `SELECT ts.id, COALESCE(SUM(o.total), 0)::float AS due
         FROM table_sessions ts
    LEFT JOIN orders o ON o.table_session_id = ts.id
                      AND o.status NOT IN ('cancelled','collected')
        WHERE ts.business_id = $1 AND ts.id = $2 AND ts.closed_at IS NULL
        GROUP BY ts.id`,
      [businessId, req.body.sessionId]
    );
    if (due.rowCount === 0) throw new BadRequest('No open bill for this session');
    const duePaise = Math.round(parseFloat(due.rows[0].due) * 100);
    if (duePaise <= 0) throw new BadRequest('Nothing to pay — the bill is already settled');
    if (Number(rzOrder.amount) !== duePaise) {
      throw new BadRequest('Payment amount does not match the outstanding bill — refresh and try again');
    }
    // Mark all unpaid orders in this session collected + close session.
    await query(
      `UPDATE orders
          SET payment_method = 'upi', status = 'collected',
              collected_at = NOW(), updated_at = NOW()
        WHERE business_id = $1 AND table_session_id = $2
          AND status NOT IN ('cancelled','collected')`,
      [businessId, req.body.sessionId]
    );
    // Record the payment for exactly the amount charged (= the validated
    // outstanding due). Bug fix (2026-08-30 review): the old version re-summed
    // ALL orders in the session, so if part of the session had been settled in
    // an earlier partial payment the recorded amount overstated what was
    // actually charged. `duePaise` already == rzOrder.amount (asserted above).
    await query(
      `INSERT INTO payments (business_id, method, amount_paise, status,
                              razorpay_payment_id, notes)
       VALUES ($1, 'upi', $2, 'captured', $3,
               jsonb_build_object('sessionId', $4::text, 'source', 'guest-qr-session'))`,
      [businessId, duePaise, req.body.razorpayPaymentId, req.body.sessionId]
    );
    await query(
      `UPDATE table_sessions SET closed_at = NOW()
        WHERE id = $1 AND business_id = $2`,
      [req.body.sessionId, businessId]
    );
    // Free the table.
    await query(
      `UPDATE tables SET status = 'available'
        WHERE business_id = $1
          AND id = (SELECT table_id FROM table_sessions WHERE id = $2)`,
      [businessId, req.body.sessionId]
    );
    res.json({ ok: true });
  }),
];

module.exports = {
  menu, placeOrder, orderStatus,
  benefitCheck, benefitVerify,                            // guest membership OTP
  createCheckoutOrder, confirmPayment,
  getRunningSession, paySession, confirmSessionPayment,   // FF-251
};
