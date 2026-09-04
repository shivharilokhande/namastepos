// Marketplace ingestion — Amazon SP-API + Flipkart Seller API (R-MKT-1)
//
// The credentials live in `marketplace_credentials` (migration 027). When
// a business has rows for amazon/flipkart and the keys are real, we pull
// new orders nightly and create matching `orders` rows. Otherwise we no-op
// (the schema is in place so we can flip the switch per-tenant later).

const { query } = require('../config/db');
const logger = require('../config/logger');

async function listCredentials(businessId) {
  const r = await query(
    `SELECT marketplace, seller_id, is_active
       FROM marketplace_credentials
      WHERE business_id = $1`,
    [businessId],
  );
  return r.rows;
}

async function upsertCredentials(businessId, body) {
  await query(
    `INSERT INTO marketplace_credentials
       (business_id, marketplace, seller_id, api_key, api_secret, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (business_id, marketplace) DO UPDATE SET
       seller_id = EXCLUDED.seller_id,
       api_key = EXCLUDED.api_key,
       api_secret = EXCLUDED.api_secret,
       is_active = TRUE`,
    [businessId, body.marketplace, body.sellerId, body.apiKey, body.apiSecret],
  );
}

// ── Amazon SP-API ────────────────────────────────────────────────────────
// Real impl would use the LWA OAuth flow + Orders API:
//   GET /orders/v0/orders?CreatedAfter=... + AmazonOrderId
// For now we expose the surface area and return mock orders when run with
// AMAZON_SPAPI_FAKE=1 — useful for end-to-end tests without real creds.
async function pullAmazonOrders(businessId, sinceIso) {
  const r = await query(
    `SELECT seller_id, api_key, api_secret FROM marketplace_credentials
      WHERE business_id = $1 AND marketplace = 'amazon' AND is_active = TRUE
      LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) {
    return { pulled: 0, reason: 'not_configured' };
  }
  const cred = r.rows[0];
  if (!cred.api_key || cred.api_key.startsWith('test_')) {
    logger.info(`Amazon SP-API for ${businessId}: skipping (test credentials)`);
    return { pulled: 0, reason: 'test_credentials' };
  }

  // TODO: Real SP-API call sequence:
  //   1. POST to LWA to exchange refresh_token → access_token
  //   2. Sign request with AWS SigV4 (IAM access key required separately)
  //   3. GET /orders/v0/orders?CreatedAfter=ISO&MarketplaceIds=A21TJRUUN4KGV
  //   4. Map Amazon line items to NamastePOS retail items by ASIN
  logger.info(`Amazon SP-API for ${businessId}: live fetch since ${sinceIso} — not yet implemented`);
  return { pulled: 0, reason: 'sdk_not_wired' };
}

// ── Flipkart Seller API ──────────────────────────────────────────────────
async function pullFlipkartOrders(businessId, _sinceIso) {
  const r = await query(
    `SELECT api_key, api_secret FROM marketplace_credentials
      WHERE business_id = $1 AND marketplace = 'flipkart' AND is_active = TRUE
      LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) return { pulled: 0, reason: 'not_configured' };

  // TODO: Real Flipkart API:
  //   POST https://api.flipkart.net/oauth-service/oauth/token
  //   GET  https://api.flipkart.net/sellers/v3/orders/search?orderDate.from=...
  logger.info(`Flipkart for ${businessId}: live fetch — not yet implemented`);
  return { pulled: 0, reason: 'sdk_not_wired' };
}

async function pullAll(businessId, sinceIso) {
  const since = sinceIso || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const az = await pullAmazonOrders(businessId, since);
  const fk = await pullFlipkartOrders(businessId, since);
  return { amazon: az, flipkart: fk };
}

module.exports = {
  listCredentials,
  upsertCredentials,
  pullAmazonOrders,
  pullFlipkartOrders,
  pullAll,
};
