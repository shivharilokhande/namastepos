// Public aggregator webhook endpoints (no auth — signature verified)
// Mounted at /v1/aggregator-webhooks

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const aggregator = require('../services/aggregatorService');

const router = express.Router();

// Provider-specific outletId resolvers — each aggregator pins it in a
// different part of the payload, so we try the documented locations
// before giving up.
function resolveOutletId(provider, req) {
  // Spec-compliant: most clients send the header
  if (req.headers['x-aggregator-outlet']) return req.headers['x-aggregator-outlet'];
  if (req.headers['x-outlet-id']) return req.headers['x-outlet-id'];

  const body = req.body || {};
  // Generic fields some aggregators use
  if (body.outlet_id) return body.outlet_id;
  if (body.outletId) return body.outletId;
  if (body.restaurant_id) return body.restaurant_id;

  // Provider-specific shapes
  if (provider === 'zomato') {
    return body.order?.restaurant?.res_id
        || body.restaurant?.res_id
        || body.res_id
        || null;
  }
  if (provider === 'swiggy') {
    return body.order?.restaurant_id
        || body.restaurant?.id
        || body.res_id
        || null;
  }
  if (provider === 'magicpin') {
    return body.outlet?.code || body.merchant_id || null;
  }
  if (provider === 'dunzo') {
    return body.store_id || body.merchant_code || null;
  }
  return null;
}

router.post('/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const outletId = resolveOutletId(provider, req);
  if (!outletId) return res.status(400).json({ error: 'OUTLET_REQUIRED' });

  // Find business by outletId on credentials
  const cred = await require('../config/db').query(
    `SELECT business_id, webhook_secret FROM aggregator_credentials
      WHERE provider = $1 AND outlet_id = $2 AND is_active = TRUE LIMIT 1`,
    [provider, outletId],
  );
  if (cred.rowCount === 0) return res.status(404).json({ error: 'OUTLET_NOT_REGISTERED' });

  const signature = req.headers[`x-${provider}-signature`] || req.headers['x-signature'];
  const verified = aggregator.verifySignature(provider, cred.rows[0].webhook_secret, req.rawBody || JSON.stringify(req.body), signature);
  if (!verified) return res.status(401).json({ error: 'INVALID_SIGNATURE' });

  // P1 fix (2026-08-22): FF-245 live sync-status badges never updated
  // because processIncomingOrder's outcome was never recorded.
  const businessId = cred.rows[0].business_id;
  try {
    // 2026-09-03 — EVENT-TYPE ROUTING. Previously every POST was treated as a
    // brand-new order, so an aggregator's cancel / rider-assigned /
    // out-for-delivery / delivered callback was parsed as an order and either
    // reported `duplicate` or threw. Route on the event type first; only a
    // genuine new-order event goes to processIncomingOrder.
    const result = await aggregator.handleWebhookEvent(businessId, provider, req.body, {
      headers: req.headers,
    });
    // 2026-09-05 (entitlements review B12): a new order for a tenant whose
    // plan lacks 'aggregators' is PARKED by the service, not created. Answer
    // 202 Accepted — never a 4xx, which would make the provider retry-storm
    // us and trip their health monitor — and surface the reason on the
    // owner's sync badge as an error so they learn WHY orders stopped
    // arriving instead of seeing a green tick over an empty board.
    if (result?.parked) {
      await aggregator.recordWebhookOutcome(businessId, provider, {
        ok: false,
        errorMessage: `Order parked: your plan does not include '${result.feature}'. Upgrade to receive aggregator orders.`,
      });
      return res.status(202).json(result);
    }
    await aggregator.recordWebhookOutcome(businessId, provider, { ok: true });
    res.json(result);
  } catch (e) {
    await aggregator.recordWebhookOutcome(businessId, provider, {
      ok: false, errorMessage: e?.message || String(e),
    });
    throw e; // let asyncHandler + error middleware convert to a proper 5xx
  }
}));

module.exports = router;
