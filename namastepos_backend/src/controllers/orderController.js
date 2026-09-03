// NamastePOS backend - order endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const order = require('../services/orderService');
const auth = require('../services/authService');
const { formatToken } = require('../utils/tokenPrinter');

const orderItem = Joi.object({
  menuItemId: Joi.string().uuid().required(),
  name: Joi.string().max(255).required(),
  price: Joi.number().min(0).required(),
  qty: Joi.number().positive().required(),
  note: Joi.string().max(500).allow('', null),
  // Batch A: variants + modifier groups picker. These are optional —
  // the order_items row stores them so KOT printing + receipt show them.
  variantId: Joi.string().uuid().allow(null),
  variantLabel: Joi.string().max(120).allow('', null),
  modifierLines: Joi.array().items(Joi.object({
    groupId: Joi.string().uuid().allow(null),
    groupLabel: Joi.string().max(120).allow('', null),
    optionId: Joi.string().uuid().allow(null),
    optionLabel: Joi.string().max(120).allow('', null),
    priceDelta: Joi.number().allow(null),
  }).unknown(true)).allow(null),
});

const createBody = Joi.object({
  clientId: Joi.string().uuid().allow(null),
  source: Joi.string().valid('dineIn', 'takeaway', 'zomato', 'swiggy', 'other').default('dineIn'),
  tableNo: Joi.string().max(20).allow('', null),
  customerPhone: Joi.string().max(20).allow('', null),
  customerName: Joi.string().max(255).allow('', null),
  items: Joi.array().items(orderItem).min(1).required(),
  // NP-112 (2026-09-03): `tax` and `discount` are CLIENT-ASSERTED and no
  // longer trusted as-is. orderService.create recomputes the expected GST
  // from menu_items.gst_pct and requires a manager approval (FF-502
  // /discount-approvals) for discounts above the per-business threshold —
  // behaviour is gated by the ORDER_TAX_ENFORCE env ('log' default,
  // 'enforce' to override/403). Kept in the schema for back-compat.
  tax: Joi.number().min(0).default(0),
  discount: Joi.number().min(0).default(0),
  // Food-coupon code applied at POS (2026-09-01). The discount amount rides in
  // `discount` (previewed via /food-coupons/apply); this lets create() record
  // the redemption and enforce max_redemptions atomically in the order txn.
  couponCode: Joi.string().max(40).allow('', null),
  paymentMethod: Joi.string().valid('cash', 'upi', 'card', 'online', 'unpaid').default('cash'),
  // Dine-in running bill / Save-KOT support
  tableId: Joi.string().uuid().allow(null),
  tableSessionId: Joi.string().uuid().allow(null),
  pointsToRedeem: Joi.number().integer().min(0).allow(null),
  // Batch A / Final-100 extensions.
  // H4 fix (2026-08-23): Joi defaults used to CONTRADICT the service
  // defaults (discountIsPreTax service-default true, round-off settings
  // lookup only fires on null) — default() forced them, silently
  // disabling round-off and flipping discount math. Null = let the
  // service/platform settings decide.
  discountIsPreTax: Joi.boolean().allow(null),
  serviceChargePct: Joi.number().min(0).max(100).allow(null),
  roundOffEnabled: Joi.boolean().allow(null),
  // GST place-of-supply (2026-08-26). Optional; defaults to intra-state
  // (CGST+SGST), which is correct for on-premise restaurant food. Set true
  // only for a genuine inter-state supply (out-of-state B2B catering) → IGST.
  isInterState: Joi.boolean().allow(null),
  // H4 fix (2026-08-23): these service features were unreachable — the
  // validator (allowUnknown:false) 400'd any client that sent them.
  // FF-312 split-tender:
  splits: Joi.array().items(Joi.object({
    method: Joi.string().valid('cash', 'upi', 'card', 'online').required(),
    amountInr: Joi.number().min(0).required(),
  })).allow(null),
  // 2026-08-25 split payments v2 (CASH+UPI / CASH+CARD / UPI+CARD /
  // +WALLET). Strict: 1-3 legs, positive amounts, must sum to the order
  // total (service enforces ±₹0.01 → 400). Supersedes `splits`.
  paymentBreakdown: Joi.array().items(Joi.object({
    method: Joi.string().valid('cash', 'upi', 'card', 'online', 'wallet').required(),
    amountInr: Joi.number().positive().required(),
  })).min(1).max(3).allow(null),
  // FF-903 server attribution + tip:
  serverUserId: Joi.string().uuid().allow(null),
  tipInr: Joi.number().min(0).allow(null),
  // FF-1005 gift-card / wallet redemption at checkout:
  walletRedeem: Joi.object({
    giftCardCode: Joi.string().max(40).allow('', null),
    customerId: Joi.string().uuid().allow(null),
    amountInr: Joi.number().positive().required(),
  }).allow(null),
  // Aggregator channel tag (set server-side by aggregatorService, but
  // harmless to accept):
  channel: Joi.string().max(30).allow('', null),
  // Wallet-as-tender auto-apply (2026-08-30): server draws the wallet down for
  // the residual due after membership/discounts, up to walletCapInr (cashier's
  // adjustable amount; null = use full balance).
  autoWallet: Joi.boolean().allow(null),
  walletCapInr: Joi.number().min(0).allow(null),
});

const listQuery = Joi.object({
  date: Joi.date().iso(),
  status: Joi.string().valid('pending', 'ready', 'collected', 'cancelled'),
  // Source = exact channel; "channel" = a grouping (online includes zomato +
  // swiggy; offline includes dineIn + takeaway).
  source: Joi.string().valid('dineIn', 'takeaway', 'zomato', 'swiggy', 'other'),
  channel: Joi.string().valid('online', 'offline', 'all'),
  // When 'session', orders that share a table_session_id are collapsed
  // into a single "bill" row in the response. Used by Orders tab in
  // mobile + dashboard so a dine-in customer sees ONE bill no matter
  // how many KOTs they sent. Kitchen views (KOT/KDS) keep groupBy=null.
  groupBy: Joi.string().valid('session').allow(null),
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

const statusBody = Joi.object({
  status: Joi.string().valid('pending', 'ready', 'collected', 'cancelled').required(),
  reason: Joi.string().max(500).allow('', null),
  // FF-503: required when status = 'cancelled', validated server-side
  // against the tenant's cancel_reasons table.
  reasonCode: Joi.string().max(40).allow('', null),
});

module.exports = {
  create: [
    validate({ body: createBody }),
    asyncHandler(async (req, res) => {
      try {
        const o = await order.create(req.params.businessId, req.body);
        return res.status(201).json({ order: o });
      } catch (err) {
        // Idempotent retry: if a concurrent client beat us to the same
        // clientId, fetch the winning order and return that.
        if (err.code === 'CONFLICT' && req.body.clientId) {
          // Re-run create() — the pre-txn lookup now finds the row.
          const o = await order.create(req.params.businessId, req.body);
          return res.status(201).json({ order: o });
        }
        throw err;
      }
    }),
  ],
  list: [
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const orders = await order.list(req.params.businessId, req.query);
      res.json({ orders, count: orders.length, total: orders.total ?? orders.length });
    }),
  ],
  get: asyncHandler(async (req, res) => {
    const o = await order.byId(req.params.businessId, req.params.orderId);
    res.json({ order: o });
  }),
  updateStatus: [
    validate({ body: statusBody }),
    asyncHandler(async (req, res) => {
      const o = await order.updateStatus(
        req.params.businessId, req.params.orderId,
        req.body.status, req.body.reason, req.body.reasonCode
      );
      res.json({ order: o });
    }),
  ],
  print: asyncHandler(async (req, res) => {
    const o = await order.byId(req.params.businessId, req.params.orderId);
    const biz = await auth.getBusinessById(req.params.businessId);
    const receipt = formatToken(o, biz);
    await order.markPrinted(req.params.businessId, req.params.orderId);
    res.json({ order: o, receipt });
  }),
  // Offline sync fix (2026-08-26): attach/update a customer on an order.
  assignCustomer: [
    validate({ body: Joi.object({
      customerName: Joi.string().max(120).allow('', null),
      customerPhone: Joi.string().pattern(/^\d{10}$/).allow('', null),
    }).min(1) }),
    asyncHandler(async (req, res) => {
      const o = await order.assignCustomer(req.params.businessId, req.params.orderId, req.body);
      res.json({ order: o });
    }),
  ],
};
