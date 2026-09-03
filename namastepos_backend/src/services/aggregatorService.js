// Aggregator (Zomato / Swiggy) ingestion (Sprint 2 / FF-101-104)
//
// Inbound shape varies per provider. We normalise to NamastePOS's order body
// then call orderService.create, which deals with all the bill math, KOT
// routing, recipe deduction, etc.

const crypto = require('crypto');
const { query } = require('../config/db');
const orderService = require('./orderService');
const logger = require('../config/logger');

// ── Credentials CRUD ─────────────────────────────────────────────────────
async function getCredentials(businessId, provider) {
  const r = await query(
    `SELECT * FROM aggregator_credentials
      WHERE business_id = $1 AND provider = $2 AND is_active = TRUE LIMIT 1`,
    [businessId, provider],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

async function listCredentials(businessId) {
  // FF-245 — LEFT JOIN aggregator_health so the dashboard can render a
  // "last synced 3m ago" badge without a second round-trip. Missing
  // rows are fine (no webhook ever received) — those show as null.
  const r = await query(
    `SELECT c.provider, c.outlet_id, c.auto_accept, c.is_active, c.updated_at,
            h.last_ok_at, h.last_error_at, h.last_error,
            h.ok_count_24h, h.err_count_24h
       FROM aggregator_credentials c
  LEFT JOIN aggregator_health h
         ON h.business_id = c.business_id AND h.provider = c.provider
      WHERE c.business_id = $1`,
    [businessId],
  );
  return r.rows;
}

/**
 * FF-245 — call this from the webhook handler after signature check.
 * Bumps counters + moves the last_ok / last_error timestamp so the
 * dashboard's sync badge updates within ~5s.
 *
 * Two-branch INSERT..ON CONFLICT — the SQL is boring and readable,
 * which is what you want for a hot webhook path.
 */
async function recordWebhookOutcome(businessId, provider, { ok, errorMessage } = {}) {
  try {
    if (ok) {
      await query(
        `INSERT INTO aggregator_health
           (business_id, provider, last_ok_at, ok_count_24h)
         VALUES ($1, $2, NOW(), 1)
         ON CONFLICT (business_id, provider) DO UPDATE
           SET last_ok_at   = NOW(),
               ok_count_24h = aggregator_health.ok_count_24h + 1`,
        [businessId, provider],
      );
    } else {
      await query(
        `INSERT INTO aggregator_health
           (business_id, provider, last_error_at, last_error, err_count_24h)
         VALUES ($1, $2, NOW(), $3, 1)
         ON CONFLICT (business_id, provider) DO UPDATE
           SET last_error_at = NOW(),
               last_error    = COALESCE(EXCLUDED.last_error, aggregator_health.last_error),
               err_count_24h = aggregator_health.err_count_24h + 1`,
        [businessId, provider, errorMessage || null],
      );
    }
  } catch (_) {
    // If migration 044 hasn't been applied on this deployment yet,
    // don't break the webhook. The badge just won't update — the
    // order itself still flows through.
  }
}

async function upsertCredentials(businessId, body) {
  const { provider, outletId, apiKey, webhookSecret, autoAccept = false } = body;
  await query(
    `INSERT INTO aggregator_credentials
       (business_id, provider, outlet_id, api_key, webhook_secret, auto_accept)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (business_id, provider) DO UPDATE
       SET outlet_id = EXCLUDED.outlet_id,
           api_key = COALESCE(EXCLUDED.api_key, aggregator_credentials.api_key),
           webhook_secret = COALESCE(EXCLUDED.webhook_secret, aggregator_credentials.webhook_secret),
           auto_accept = EXCLUDED.auto_accept,
           updated_at = NOW()`,
    [businessId, provider, outletId, apiKey, webhookSecret, autoAccept],
  );
  // P1 fix (2026-08-22): close the OTP link-session loop. The owner
  // pasting their outlet id here is the "manual" completion path — mark
  // the newest verified session for this business+provider as linked so
  // the dashboard doesn't show it stuck at 'verified' forever.
  try {
    await query(
      `UPDATE aggregator_link_sessions
          SET status = 'linked', linked_at = NOW(), merchant_ref = $3
        WHERE id = (SELECT id FROM aggregator_link_sessions
                     WHERE business_id = $1 AND provider = $2 AND status = 'verified'
                     ORDER BY created_at DESC LIMIT 1)`,
      [businessId, provider, outletId],
    );
  } catch (_) { /* table may predate migration 053 — non-fatal */ }
  return listCredentials(businessId);
}

// ── Signature verification ───────────────────────────────────────────────
function verifySignature(provider, secret, rawBody, signature) {
  if (!signature || typeof signature !== 'string') return false;
  // P1 fix (2026-08-22): a credential row without a webhook_secret used
  // to throw a TypeError inside createHmac (outside the try) → 500 on
  // every webhook for that outlet. Fail closed instead.
  if (!secret || typeof secret !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

// ── Normalisers ──────────────────────────────────────────────────────────
async function _resolveItems(businessId, provider, externalItems) {
  // Look up the menu_item by external_skus->>provider; surface mapping issues.
  const resolved = [];
  for (const it of externalItems) {
    const r = await query(
      `SELECT mi.id, mi.name, mi.price
         FROM menu_items mi
        WHERE mi.business_id = $1
          AND mi.external_skus->>$2 = $3
          AND mi.is_active = TRUE
        LIMIT 1`,
      [businessId, provider, String(it.sku || it.id)],
    );
    if (r.rowCount === 0) {
      // Record the mapping issue
      await query(
        `INSERT INTO aggregator_mapping_issues
           (business_id, provider, external_sku, external_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, provider, external_sku) DO UPDATE
           SET count_seen = aggregator_mapping_issues.count_seen + 1,
               last_seen_at = NOW(),
               resolved = FALSE`,
        [businessId, provider, String(it.sku || it.id), it.name],
      );
      // Still add it to the order with provider-quoted price so the kitchen sees it
      resolved.push({
        menuItemId: null,
        name: `[unmapped] ${it.name}`,
        price: it.price,
        qty: it.qty,
        note: `SKU: ${it.sku || it.id}`,
      });
    } else {
      resolved.push({
        menuItemId: r.rows[0].id,
        name: r.rows[0].name,
        price: it.price,
        qty: it.qty,
      });
    }
  }
  return resolved;
}

function _normaliseZomato(payload) {
  // Zomato's "order_created" payload (representative shape — adjust to real)
  const o = payload.order || payload;
  return {
    externalOrderId: o.order_id || o.id,
    customerName: o.customer?.name,
    customerPhone: o.customer?.phone,
    items: (o.items || []).map((it) => ({
      sku: it.menu_id || it.item_id,
      name: it.name,
      price: parseFloat(it.unit_price || it.price || 0),
      qty: it.quantity || 1,
    })),
    discount: parseFloat(o.discount || 0),
    tax: parseFloat(o.taxes_total || 0),
    paymentMethod: 'online',
  };
}

function _normaliseSwiggy(payload) {
  const o = payload.order || payload;
  return {
    externalOrderId: o.order_id,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    items: (o.order_items || []).map((it) => ({
      sku: it.item_id,
      name: it.name,
      price: parseFloat(it.price_each || 0),
      qty: it.quantity || 1,
    })),
    discount: parseFloat(o.discount || 0),
    tax: parseFloat(o.tax_amount || 0),
    paymentMethod: 'online',
  };
}

// ── Process an incoming aggregator order ────────────────────────────────
async function processIncomingOrder(businessId, provider, payload) {
  // Bug fix (B3/B15): the order_source enum only lists zomato+swiggy.
  // Dunzo/Magicpin payloads used to fall through to _normaliseSwiggy
  // and then INSERT a non-enum value. Explicitly whitelist known
  // parsers, and normalise unknown providers → 'other' so the row
  // still lands (with channel captured on a separate column).
  let norm;
  if (provider === 'zomato') norm = _normaliseZomato(payload);
  else if (provider === 'swiggy') norm = _normaliseSwiggy(payload);
  else if (provider === 'dunzo' || provider === 'magicpin') {
    // Their payload shape is close enough to Swiggy's for a best-effort
    // parse until we ship dedicated normalisers.
    norm = _normaliseSwiggy(payload);
  } else {
    throw new Error(`Unsupported aggregator provider: ${provider}`);
  }
  const enumSource = (provider === 'zomato' || provider === 'swiggy') ? provider : 'other';

  // Idempotency
  const dup = await query(
    `SELECT id FROM orders
      WHERE business_id = $1 AND aggregator_order_id = $2 LIMIT 1`,
    [businessId, norm.externalOrderId],
  );
  if (dup.rowCount > 0) {
    return { duplicate: true, orderId: dup.rows[0].id };
  }

  const items = await _resolveItems(businessId, provider, norm.items);
  if (items.length === 0) throw new Error('No items in aggregator order');

  // P0 fix (2026-08-22): fallback used to synthesise the all-zeros
  // UUID for unmapped items so `orders.items[i].menu_item_id` had a
  // value — but nothing in `menu_items` has that ID → FK violation →
  // the whole webhook 500'd and the aggregator order was silently
  // dropped. `order_items.menu_item_id` is nullable per migration 054;
  // pass null explicitly and log an unmapped-issue for the owner to
  // fix in the mapping picker (FF-103b). Order still goes through.
  const mapped = items.filter((it) => it.menuItemId);
  const orderItems = items.map((it) => ({
    ...it,
    menuItemId: it.menuItemId || null,
  }));
  // If we couldn't map ANY item, record it in mapping_issues so the
  // owner sees a red badge on the Aggregators page and can fix it.
  if (mapped.length === 0) {
    try {
      const svc = require('./mappingIssuesService');
      if (svc && typeof svc.recordUnmappedBatch === 'function') {
        await svc.recordUnmappedBatch(businessId, provider, items);
      }
    } catch (_) { /* non-fatal — don't drop the order over telemetry */ }
  }
  const created = await orderService.create(businessId, {
    source: enumSource,
    channel: provider,
    items: orderItems,
    tax: norm.tax,
    discount: norm.discount,
    paymentMethod: norm.paymentMethod,
    customerPhone: norm.customerPhone,
    customerName: norm.customerName,
  }, { trustedChannel: true }); // NP-112: platform tax is authoritative here

  // Stamp external ref so we don't re-ingest
  await query(
    `UPDATE orders
        SET aggregator_order_id = $1, aggregator_payload = $2,
            aggregator_status = 'placed'
      WHERE id = $3`,
    [norm.externalOrderId, payload, created.id],
  );

  // Auto-accept setting → flip to ready (skip kitchen approval)
  const cred = await getCredentials(businessId, provider);
  if (cred?.auto_accept) {
    await orderService.updateStatus(businessId, created.id, 'ready');
  }
  logger.info(`Aggregator ${provider} order ${norm.externalOrderId} → ${created.id}`);
  return { created: true, orderId: created.id, mappingIssues: items.length - mapped.length };
}

// ── Mapping issues for the dashboard ────────────────────────────────────
async function listMappingIssues(businessId) {
  const r = await query(
    `SELECT * FROM aggregator_mapping_issues
      WHERE business_id = $1 AND resolved = FALSE
      ORDER BY count_seen DESC, last_seen_at DESC`,
    [businessId],
  );
  return r.rows;
}

async function setExternalSku(businessId, menuItemId, provider, sku) {
  await query(
    `UPDATE menu_items
        SET external_skus = jsonb_set(
              COALESCE(external_skus, '{}'::jsonb),
              ARRAY[$1::text],
              to_jsonb($2::text)
            )
      WHERE business_id = $3 AND id = $4`,
    [provider, sku, businessId, menuItemId],
  );
  await query(
    `UPDATE aggregator_mapping_issues SET resolved = TRUE
      WHERE business_id = $1 AND provider = $2 AND external_sku = $3`,
    [businessId, provider, sku],
  );
}

module.exports = {
  getCredentials,
  listCredentials,
  upsertCredentials,
  verifySignature,
  processIncomingOrder,
  listMappingIssues,
  setExternalSku,
  recordWebhookOutcome, // FF-245
};
