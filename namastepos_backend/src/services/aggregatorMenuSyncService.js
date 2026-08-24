// NamastePOS — Aggregator menu availability sync (FF-247).
//
// When a cafe toggles an item sold_out in NamastePOS, we want that
// change reflected in Zomato / Swiggy / Dunzo / Magicpin within a
// few seconds — otherwise customers keep ordering an item the
// kitchen can't make, and the cafe eats the refund + reputation.
//
// This service posts availability updates to each configured
// aggregator's API. The provider APIs are not standardised, so
// each has its own function; they share a common shape:
//   sync(businessId, menuItemId, isAvailable) → Promise<{provider, ok, msg}>
//
// Non-blocking from the caller's perspective — the sold_out toggle
// itself returns immediately, and we fan out to aggregators in the
// background via cronWorker or a fire-and-forget queue. If an
// aggregator API is down we retry via the same cron on the next
// pass; failure never blocks the local toggle.

const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

// ── Provider adapters ─────────────────────────────────────────────
// Each function takes { credentials, externalSku, isAvailable } and
// returns { ok, msg }. Real HTTP calls live here; when the aggregator
// hasn't published a documented API (Dunzo, Magicpin) we stub with
// a "not supported yet" response so the UI can surface it.

async function syncZomato({ credentials, externalSku, isAvailable }) {
  // Zomato's Partner API — POST /menu/items/:externalSku/availability
  // with { available: bool }. Requires the outlet's API token.
  if (!credentials?.api_key) {
    return { ok: false, msg: 'Zomato API key not configured' };
  }
  if (!externalSku) {
    return { ok: false, msg: 'No Zomato SKU mapped for this item' };
  }
  try {
    const url = `${env.ZOMATO_API_BASE}/menu/items/${externalSku}/availability`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available: isAvailable }),
    });
    if (!r.ok) return { ok: false, msg: `Zomato ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `Zomato: ${e.message}` };
  }
}

async function syncSwiggy({ credentials, externalSku, isAvailable }) {
  // Swiggy Partner API — different endpoint shape. Uses a `menu_id`
  // parent and toggles `is_available` on the item.
  if (!credentials?.api_key) {
    return { ok: false, msg: 'Swiggy API key not configured' };
  }
  if (!externalSku) {
    return { ok: false, msg: 'No Swiggy SKU mapped for this item' };
  }
  try {
    const url = `${env.SWIGGY_API_BASE}/menu/item/${externalSku}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        'X-Api-Key': credentials.api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_available: isAvailable }),
    });
    if (!r.ok) return { ok: false, msg: `Swiggy ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `Swiggy: ${e.message}` };
  }
}

async function syncDunzo(_args) {
  // Dunzo's Kirana API doesn't have a documented per-item toggle
  // yet (as of 2026-08). Placeholder for when they publish one.
  return { ok: false, msg: 'Dunzo per-item availability API not yet supported' };
}

async function syncMagicpin(_args) {
  return { ok: false, msg: 'Magicpin per-item availability API not yet supported' };
}

const PROVIDERS = {
  zomato: syncZomato,
  swiggy: syncSwiggy,
  dunzo: syncDunzo,
  magicpin: syncMagicpin,
};

/**
 * Fan out to every provider this business has credentials for.
 * Returns an array of results — the caller (setSoldOut) can log or
 * ignore. Failures on one provider don't block the others.
 */
async function syncItemAvailability(businessId, menuItemId, isAvailable) {
  // Fetch credentials + external SKU mapping in one round-trip.
  const [credRows, itemRows] = await Promise.all([
    query(
      `SELECT provider, api_key, webhook_secret
         FROM aggregator_credentials
        WHERE business_id = $1 AND is_active = TRUE`,
      [businessId]
    ),
    query(
      `SELECT external_skus FROM menu_items
        WHERE business_id = $1 AND id = $2 LIMIT 1`,
      [businessId, menuItemId]
    ),
  ]);

  if (credRows.rowCount === 0) {
    // No integrations configured — nothing to do.
    return [];
  }
  const externalSkus = itemRows.rows[0]?.external_skus || {};

  const results = await Promise.all(credRows.rows.map(async (c) => {
    const provider = c.provider;
    const fn = PROVIDERS[provider];
    if (!fn) return { provider, ok: false, msg: `Unknown provider ${provider}` };
    const externalSku = externalSkus[provider] || null;
    const res = await fn({
      credentials: c,
      externalSku,
      isAvailable,
    });
    return { provider, ...res };
  }));

  // Best-effort log — every attempt records into aggregator_health so
  // the sync-status badge on the dashboard reflects the latest ping.
  const agg = require('./aggregatorService');
  for (const r of results) {
    await agg.recordWebhookOutcome(businessId, r.provider, {
      ok: r.ok,
      errorMessage: r.ok ? null : r.msg,
    }).catch(() => {});
    if (!r.ok) {
      logger.warn(`[menu-sync] ${r.provider} for item ${menuItemId}: ${r.msg}`);
    }
  }

  return results;
}

module.exports = { syncItemAvailability };
