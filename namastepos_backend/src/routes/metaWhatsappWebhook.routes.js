// Meta WhatsApp Cloud API webhook (public, signature-verified).
// Mounted at /v1/meta-wa-webhooks.
//
//   GET  → verification handshake (hub.mode / hub.verify_token / hub.challenge)
//   POST → inbound messages + delivery statuses. Verified with
//          X-Hub-Signature-256 = HMAC-SHA256(appSecret, rawBody).
//
// Meta uses a SINGLE shared WABA number for the whole platform, so inbound
// conversational messages can't be attributed to a business by the number
// dialled. We best-effort route by matching the sender's phone to exactly one
// business's customer record; otherwise we just log (status events are the
// common case and need no routing).

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const whatsapp = require('../services/whatsappService');
const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

const router = express.Router();

// ── GET: verification handshake ─────────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === env.META_WA_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

function verifySignature(req) {
  // If no app secret configured we can't verify — accept in dev, reject in prod.
  if (!env.META_WA_APP_SECRET) return !(env.isProd && env.isProd());
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', env.META_WA_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Resolve a business for an inbound sender: exactly one business that has this
// phone as a customer. Ambiguous/none → null (message is logged, not dropped).
async function _resolveBusiness(phone) {
  const digits = String(phone).replace(/[^\d]/g, '').slice(-10);
  if (!digits) return null;
  const r = await query(
    `SELECT DISTINCT business_id FROM customers
      WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
      LIMIT 2`,
    [digits]
  );
  return r.rowCount === 1 ? r.rows[0].business_id : null;
}

// ── POST: inbound messages + statuses ───────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  if (!verifySignature(req)) {
    logger.warn('[meta-wa-webhook] rejected: bad signature');
    return res.sendStatus(401);
  }
  // Always ack quickly so Meta doesn't retry; process best-effort.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Delivery / read statuses — log only (no per-message status column).
        for (const st of value.statuses || []) {
          logger.info(`[meta-wa] status ${st.status} for ${st.id}`);
        }
        // Inbound messages
        for (const m of value.messages || []) {
          const phone = m.from;
          const text = m.text?.body
            || m.button?.text
            || m.interactive?.button_reply?.title
            || m.interactive?.list_reply?.title
            || '';
          const name = value.contacts?.[0]?.profile?.name;
          const businessId = await _resolveBusiness(phone);
          if (businessId && text) {
            await whatsapp.handleInbound(businessId, {
              phone: `+${phone}`, body: text, providerMsgId: m.id, name,
            });
          } else {
            logger.info(`[meta-wa] inbound from ${phone} not routed (biz=${businessId || 'none'})`);
          }
        }
      }
    }
  } catch (e) {
    logger.warn(`[meta-wa-webhook] processing error: ${e.message}`);
  }
}));

module.exports = router;
