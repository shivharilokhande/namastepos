// NamastePOS backend — outbound status callbacks to aggregators (2026-09-03).
//
// READ THIS BEFORE "FIXING" THE URLS BELOW.
//
// Neither Zomato nor Swiggy offers self-serve API access. Zomato's POS
// Integration API is granted through partner onboarding and requires (as of
// Sep 2026) 50+ onboarded restaurants OR 10,000 orders/month plus a 24x7
// on-call escalation channel; Swiggy's partner surface is similar. Until
// NamastePOS holds those agreements we do NOT have real endpoints, real auth
// or real payload contracts — and inventing them is worse than admitting it,
// because a plausible-looking 404 loop hides the fact that no order status
// ever reached the aggregator.
//
// So this adapter is honest by construction:
//   • No partner credentials for the provider  →  { skipped: true }. The event
//     is marked `skipped`, the local lifecycle still works end to end, and
//     nothing pretends to have been delivered.
//   • Credentials present  →  we POST to the configured base URL. The request
//     shape is intentionally in ONE place (buildRequest) so that when the real
//     contract arrives, this single function changes and nothing else does.
//
// Own-fleet delivery ('own') needs no callback at all — we ARE the fleet.

const https = require('https');
const { URL } = require('url');
const env = require('../config/env');
const { query } = require('../config/db');
const logger = require('../config/logger');

const PARTNER_PROVIDERS = ['zomato', 'swiggy'];

/** Per-provider request shape. The ONE place to change when contracts land. */
function buildRequest(provider, ev, creds) {
  const body = {
    order_id: ev.payload?.aggregatorOrderId || null,
    pos_order_no: ev.payload?.orderNo || null,
    status: ev.event,
    prep_time_minutes: ev.payload?.prepMinutes ?? null,
    reason: ev.payload?.reason ?? null,
    at: new Date().toISOString(),
  };
  if (provider === 'zomato') {
    return {
      base: env.ZOMATO_API_BASE,
      path: '/order/status',
      headers: { Authorization: `Bearer ${creds.api_key}` },
      body,
    };
  }
  // swiggy
  return {
    base: env.SWIGGY_API_BASE,
    path: '/order/status',
    headers: { 'X-Api-Key': creds.api_key },
    body,
  };
}

function _post({ base, path, headers, body }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, base.endsWith('/') ? base : `${base}/`); }
    catch (e) { return reject(new Error(`Bad provider base URL: ${base}`)); }
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
        reject(Object.assign(
          new Error(`provider HTTP ${res.statusCode}: ${String(chunks).slice(0, 200)}`),
          { statusCode: res.statusCode }
        ));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('provider timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Push one queued event. Returns { skipped, reason } or { ok: true }.
 * Throws on a retryable failure (the caller backs off and dead-letters).
 */
async function push(ev) {
  const provider = String(ev.provider || '').toLowerCase();

  // Own fleet / dine-in / takeaway: nothing to notify.
  if (!PARTNER_PROVIDERS.includes(provider)) {
    return { skipped: true, reason: `no outbound channel for provider '${provider}'` };
  }

  const c = await query(
    `SELECT outlet_id, api_key FROM aggregator_credentials
      WHERE business_id = $1 AND provider = $2 AND is_active = TRUE
      LIMIT 1`,
    [ev.business_id, provider]
  );
  const creds = c.rows[0];
  if (!creds?.api_key) {
    return { skipped: true, reason: `${provider}: no partner credentials configured` };
  }
  const base = provider === 'zomato' ? env.ZOMATO_API_BASE : env.SWIGGY_API_BASE;
  if (!base) {
    return { skipped: true, reason: `${provider}: no API base URL configured` };
  }
  // Explicit opt-in. Without a signed partner agreement these calls cannot
  // succeed, so we do not fire them by default and fill the log with noise.
  if (env.AGGREGATOR_OUTBOUND_ENABLED !== 'true') {
    return {
      skipped: true,
      reason: 'AGGREGATOR_OUTBOUND_ENABLED is not true (no partner agreement yet)',
    };
  }

  const reqSpec = buildRequest(provider, ev, creds);
  await _post(reqSpec);
  logger.info(`[aggregator-out] ${provider} ${ev.event} pushed for order ${ev.order_id}`);
  return { ok: true };
}

module.exports = { push, buildRequest, PARTNER_PROVIDERS };
