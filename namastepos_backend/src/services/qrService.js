// NamastePOS backend - QR dine-in ordering service
//
// Each table has a permanent token (signed JWT, no expiry). The customer
// scans the QR → opens https://app.namastepos.in/qr/<token>. The frontend
// posts the token to /v1/guest/menu/<token> to fetch the menu and to
// /v1/guest/orders/<token> to place an order.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../config/db');
const { NotFound, Unauthorized } = require('../utils/errors');

const TOKEN_KIND = 'qr-menu';

// Security review 2026-09-04 (item 5): pin the signature algorithm.
//
// `jwt.verify(token, secret)` with no `algorithms` allowlist lets the TOKEN
// choose how it is validated — the classic algorithm-confusion foothold. With
// jsonwebtoken >= 9 the worst variants are already blocked (`alg: none` is
// rejected unless you pass algorithms:['none'], and an HMAC-signed token is
// refused when the key is an asymmetric KeyObject), so this specific call was
// not exploitable today. It was, however, one library upgrade or one "let's
// move QR tokens to RS256" refactor away from being exploitable, and the
// tenant path (utils/jwt.js) already pinned HS256. Pinned here to match.
const JWT_ALGS = ['HS256'];

// ── Settings ────────────────────────────────────────────────────────────
function serializeSettings(s) {
  if (!s) return null;
  return {
    businessId: s.business_id,
    isEnabled: s.is_enabled,
    welcomeTitle: s.welcome_title,
    welcomeSubtitle: s.welcome_subtitle,
    brandColor: s.brand_color,
    requirePhone: s.require_phone,
    requireName: s.require_name,
    showPrices: s.show_prices,
    showVegBadge: s.show_veg_badge,
    autoAccept: s.auto_accept,
  };
}

async function getSettings(businessId) {
  const r = await query(
    'SELECT * FROM qr_settings WHERE business_id = $1 LIMIT 1',
    [businessId],
  );
  if (r.rowCount === 0) {
    const ins = await query(
      'INSERT INTO qr_settings (business_id) VALUES ($1) RETURNING *',
      [businessId],
    );
    return serializeSettings(ins.rows[0]);
  }
  return serializeSettings(r.rows[0]);
}

async function updateSettings(businessId, patch) {
  const fields = ['is_enabled', 'welcome_title', 'welcome_subtitle',
    'brand_color', 'require_phone', 'require_name',
    'show_prices', 'show_veg_badge', 'auto_accept'];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${idx++}`); values.push(patch[f]); }
  }
  await getSettings(businessId); // ensure row exists
  if (sets.length === 0) return getSettings(businessId);
  values.push(businessId);
  const r = await query(
    `UPDATE qr_settings SET ${sets.join(', ')}
      WHERE business_id = $${idx} RETURNING *`,
    values,
  );
  return serializeSettings(r.rows[0]);
}

// ── Token issue + verify ───────────────────────────────────────────────
/**
 * Self-heal — migration 007 created `tables.qr_token` as VARCHAR(255)
 * but a real JWT (header + payload with bid/tid/salt + signature) lands
 * around ~315 chars, which trips Postgres error 22001 ("value too long
 * for type character varying(255)"). We widen the column to TEXT on
 * first use so existing deployments don't have to write a new manual
 * migration. Same trick for the matching `qr_enabled` boolean.
 */
async function _ensureQrColumns() {
  // Check existence + length of qr_token in one shot.
  const r = await query(
    `SELECT column_name, data_type, character_maximum_length
       FROM information_schema.columns
      WHERE table_name = 'tables'
        AND column_name IN ('qr_token', 'qr_enabled')`,
  );
  const have = new Map(r.rows.map((x) => [x.column_name, x]));

  if (!have.has('qr_token')) {
    await query('ALTER TABLE tables ADD COLUMN IF NOT EXISTS qr_token TEXT UNIQUE');
    await query('CREATE INDEX IF NOT EXISTS idx_tables_qr_token ON tables(qr_token)');
    // eslint-disable-next-line no-console
    console.warn('[qrService] auto-added missing column tables.qr_token');
  } else if (have.get('qr_token').data_type === 'character varying') {
    // Column exists but is too short (e.g. VARCHAR(255) from migration 007).
    // JWTs run ~300+ chars, so widen to TEXT. `ALTER TYPE` is a metadata-
    // only change on Postgres for varchar→text; safe + instant.
    const len = have.get('qr_token').character_maximum_length;
    if (len !== null && len < 1024) {
      await query('ALTER TABLE tables ALTER COLUMN qr_token TYPE TEXT');
      // eslint-disable-next-line no-console
      console.warn(`[qrService] widened tables.qr_token from VARCHAR(${len}) to TEXT — JWTs > 255 chars`);
    }
  }

  if (!have.has('qr_enabled')) {
    await query('ALTER TABLE tables ADD COLUMN IF NOT EXISTS qr_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    // eslint-disable-next-line no-console
    console.warn('[qrService] auto-added missing column tables.qr_enabled');
  }
}

/** Issue (or fetch) the persistent token for a table. */
async function issueTokenForTable(businessId, tableId) {
  try {
    await _ensureQrColumns();
    const r = await query(
      `SELECT id, qr_token, qr_enabled FROM tables
        WHERE business_id = $1 AND id = $2 LIMIT 1`,
      [businessId, tableId],
    );
    if (r.rowCount === 0) throw new NotFound('Table not found for this business');
    if (r.rows[0].qr_token) return r.rows[0].qr_token;

    // Generate a new token (signed JWT, no expiry — tied to bid+tid).
    // Salt randomises every regeneration so old QRs are invalidated on
    // rotate even when the JWT_SECRET is unchanged.
    const token = jwt.sign(
      { bid: businessId,
        tid: tableId,
        kind: TOKEN_KIND,
        salt: crypto.randomBytes(8).toString('hex') },
      env.JWT_SECRET,
      { issuer: 'namastepos-qr', algorithm: JWT_ALGS[0] },
    );
    await query('UPDATE tables SET qr_token = $1 WHERE id = $2', [token, tableId]);
    return token;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[qrService.issueTokenForTable] failed:', {
      businessId,
      tableId,
      message: e?.message,
      code: e?.code,
      detail: e?.detail,
    });
    throw e;
  }
}

/** Rotate the token (invalidates the printed QR). */
async function rotateToken(businessId, tableId) {
  await query(
    'UPDATE tables SET qr_token = NULL WHERE business_id = $1 AND id = $2',
    [businessId, tableId],
  );
  return issueTokenForTable(businessId, tableId);
}

/** Verify a token. Returns { businessId, tableId, business, table } on success. */
async function verifyToken(token) {
  if (!token) throw new Unauthorized('Missing QR token');
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'namastepos-qr',
      algorithms: JWT_ALGS,
    });
  } catch (_) {
    throw new Unauthorized('Invalid QR token');
  }
  if (payload.kind !== TOKEN_KIND) throw new Unauthorized('Wrong token kind');

  // Push 15j — two-step verify so we can distinguish "table doesn't
  // exist" (truly bad) from "qr_token in DB is NULL or stale" (often a
  // self-recoverable state from migration / column-resize hiccups).
  const r = await query(
    `SELECT t.*, b.name AS business_name, b.logo_url, b.upi_id, b.phone AS business_phone,
            f.name AS floor_name
       FROM tables t
       JOIN businesses b ON b.id = t.business_id
       JOIN floors f ON f.id = t.floor_id
      WHERE t.business_id = $1 AND t.id = $2
      LIMIT 1`,
    [payload.bid, payload.tid],
  );
  if (r.rowCount === 0) throw new Unauthorized('Table removed or wrong business');
  const row = r.rows[0];
  if (!row.qr_enabled) throw new Unauthorized('Guest ordering disabled for this table');
  // If the stored qr_token doesn't match but it's NULL (e.g. a previous
  // varchar-too-short update failed silently before our self-heal), this
  // is the FIRST time we're seeing a valid signed JWT for this table —
  // adopt it so subsequent requests verify cleanly. The JWT itself is
  // cryptographically tamper-proof, so this is safe.
  if (!row.qr_token) {
    // eslint-disable-next-line no-console
    console.warn('[verifyToken] adopting JWT — qr_token was NULL for table', payload.tid);
    await query('UPDATE tables SET qr_token = $1 WHERE id = $2', [token, payload.tid]);
  } else if (row.qr_token !== token) {
    // qr_token IS set, and it's different → real rotation. Reject.
    throw new Unauthorized('QR token has been rotated. Please rescan the QR.');
  }

  const t = r.rows[0];
  return {
    businessId: payload.bid,
    tableId: payload.tid,
    table: {
      id: t.id, label: t.label, seats: t.seats, floorName: t.floor_name,
    },
    business: {
      id: t.business_id,
      name: t.business_name,
      logoUrl: t.logo_url,
      upiId: t.upi_id,
      phone: t.business_phone,
    },
  };
}

// ── Guest menu (cached-friendly) ───────────────────────────────────────
async function guestMenu(businessId) {
  // Push 16c — guests only see in-stock items. NULL stock = untracked
  // (always available); positive stock = available; zero/negative =
  // hidden. Owners who want an item permanently shown should leave its
  // stock NULL or positive; an item at 0/-N means "ran out".
  const r = await query(
    `SELECT id, name, description, category, price, unit, is_veg, image_url, stock
       FROM menu_items
      WHERE business_id = $1
        AND is_active = TRUE
        AND (stock IS NULL OR stock > 0)
      ORDER BY category ASC, name ASC`,
    [businessId],
  );
  return r.rows.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.category,
    price: parseFloat(m.price),
    unit: m.unit,
    isVeg: m.is_veg,
    imageUrl: m.image_url,
    inStock: true, // by construction — query already filtered
  }));
}

// ── Guest session + order placement ────────────────────────────────────
async function ensureGuestSession({
  businessId, tableId, customerPhone, customerName, ipAddress, userAgent,
}) {
  // Tie to an existing open table_session if there is one (so the QR order
  // joins the same bill the dine-in family is already running up).
  const existing = await query(
    `SELECT id FROM table_sessions
      WHERE table_id = $1 AND status = 'open' LIMIT 1`,
    [tableId],
  );
  let tableSessionId = existing.rows[0]?.id || null;

  if (!tableSessionId) {
    const ins = await query(
      `INSERT INTO table_sessions
         (business_id, table_id, guest_count, customer_phone, customer_name)
       VALUES ($1, $2, 1, $3, $4) RETURNING id`,
      [businessId, tableId, customerPhone || null, customerName || null],
    );
    tableSessionId = ins.rows[0].id;
    await query(
      `UPDATE tables SET status = 'occupied'::table_status, current_session_id = $1
        WHERE id = $2`,
      [tableSessionId, tableId],
    );
  }

  const gs = await query(
    `INSERT INTO guest_sessions
       (business_id, table_id, table_session_id, customer_phone, customer_name,
        ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [businessId, tableId, tableSessionId, customerPhone || null, customerName || null,
      ipAddress || null, userAgent || null],
  );

  return { tableSessionId, guestSessionId: gs.rows[0].id };
}

async function recordGuestSessionOrder({ guestSessionId, totalInr }) {
  if (!guestSessionId) return;
  await query(
    `UPDATE guest_sessions
        SET total_orders = total_orders + 1,
            total_inr = total_inr + $1,
            last_activity_at = NOW()
      WHERE id = $2`,
    [totalInr, guestSessionId],
  );
}

async function guestOrderStatus(orderId, businessId) {
  // FF-252 — pull the resolved service mode so the guest confirmation
  // page can adapt its copy: dine-in guests get "your server will bring
  // it", self-pickup guests get "please collect at the counter".
  const r = await query(
    `SELECT o.id, o.order_no, o.status, o.total, o.created_at,
            o.ready_at, o.collected_at,
            o.service_mode, o.channel,
            t.service_mode         AS table_mode,
            b.default_service_mode AS biz_default_mode
       FROM orders o
       LEFT JOIN tables     t ON t.id = o.table_id
       JOIN businesses b ON b.id = o.business_id
      WHERE o.id = $1 AND o.business_id = $2 LIMIT 1`,
    [orderId, businessId],
  );
  if (r.rowCount === 0) throw new NotFound('Order not found');
  const row = r.rows[0];
  const orderService = require('./orderService');
  return {
    id: row.id,
    orderNo: row.order_no,
    status: row.status,
    total: parseFloat(row.total),
    createdAt: row.created_at,
    readyAt: row.ready_at,
    collectedAt: row.collected_at,
    serviceMode: orderService.resolveServiceMode(row),
  };
}

module.exports = {
  getSettings,
  updateSettings,
  issueTokenForTable,
  rotateToken,
  verifyToken,
  guestMenu,
  ensureGuestSession,
  recordGuestSessionOrder,
  guestOrderStatus,
};
