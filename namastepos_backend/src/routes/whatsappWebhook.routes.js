// Twilio WhatsApp inbound webhook (public, signature-verified)
//
// AUDIT-S004 (P0): This endpoint previously processed ANY POST body as a
// legitimate incoming WhatsApp message — no signature check. An attacker
// could spam-inject fake customer messages, trigger downstream actions
// (auto-reply, loyalty events, status flips), and pollute the database.
//
// Twilio signs every webhook with HMAC-SHA1 over the URL + sorted form
// params using the account's auth token. We verify that signature before
// trusting the body. If TWILIO_AUTH_TOKEN isn't configured (dev/test), we
// fall through with a clear log line so it's obvious what's missing.

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const whatsapp = require('../services/whatsappService');
const env = require('../config/env');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compute the Twilio signature for the request and compare to the header.
 * Twilio docs: https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Inputs:
 *   url    — full webhook URL Twilio sent the request to (proto+host+path)
 *   params — POST form fields, sorted by key, concatenated as key+value
 *   token  — TWILIO_AUTH_TOKEN
 *
 * The signature is HMAC-SHA1(url + sortedParamsConcat) base64-encoded.
 */
function verifyTwilioSignature(url, params, signature, token) {
  if (!signature || !token) return false;
  const sorted = Object.keys(params).sort();
  const data = sorted.reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  // Constant-time comparison
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

router.post('/:businessId', asyncHandler(async (req, res) => {
  // Validate :businessId before anything else — keeps garbage out of the DB
  // and prevents accidental path-like injections downstream.
  const { businessId } = req.params;
  if (!UUID_RE.test(businessId)) {
    return res.status(400).set('Content-Type', 'text/xml').send('<Response/>');
  }

  // Reconstruct the absolute URL Twilio used (must match what's configured
  // in the Twilio console). Honour X-Forwarded-* when behind a proxy.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const fullUrl = `${proto}://${host}${req.originalUrl}`;

  const signature = req.headers['x-twilio-signature'];
  const ok = verifyTwilioSignature(fullUrl, req.body || {}, signature, env.TWILIO_AUTH_TOKEN);

  // Hardcode-audit fix (2026-08-24): enforcement no longer keys off
  // NODE_ENV. If a Twilio auth token IS configured (any environment —
  // dev, staging, prod), a bad/missing signature is rejected. The only
  // permissive path is a token-less local dev setup, which can't verify
  // anything and logs loudly instead.
  if (!ok) {
    if (env.TWILIO_AUTH_TOKEN || (env.isProd && env.isProd())) {
      // eslint-disable-next-line no-console
      console.warn('[whatsapp-webhook] rejected: bad signature', { businessId });
      return res.status(401).set('Content-Type', 'text/xml').send('<Response/>');
    }
    // eslint-disable-next-line no-console
    console.warn('[whatsapp-webhook] no TWILIO_AUTH_TOKEN configured — accepting unsigned payload (dev only)', { businessId });
  }

  const body = req.body || {};
  const phone = (body.From || '').replace(/^whatsapp:/, '');
  const msg = body.Body || '';
  const providerMsgId = body.MessageSid;
  const name = body.ProfileName;
  await whatsapp.handleInbound(businessId, { phone, body: msg, providerMsgId, name });
  res.set('Content-Type', 'text/xml').send('<Response/>');
}));

module.exports = router;
