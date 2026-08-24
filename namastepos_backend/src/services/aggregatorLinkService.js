// NamastePOS backend — Zomato / Swiggy merchant linking via phone OTP.
//
// ─────────────────────────────────────────────────────────────────────
// IMPORTANT — READ BEFORE ENABLING IN PRODUCTION
// ─────────────────────────────────────────────────────────────────────
// The end-user promise here is: owner enters their Zomato/Swiggy-linked
// mobile number, receives an OTP from Zomato/Swiggy, enters it, and
// their merchant account gets linked to NamastePOS so orders sync live.
//
// TWO WAYS TO IMPLEMENT THIS. Only one is safe for prod.
//
//   1. **OFFICIAL PARTNER API** (recommended). Both Zomato and Swiggy
//      have Partner Programs that expose a signed merchant-onboarding
//      API. You send them the merchant's phone / GSTIN / outlet id,
//      they push a webhook to us with the outlet mapping. The OTP is
//      handled entirely on their side (or skipped for pre-approved
//      partners). Requires a signed API agreement per aggregator; both
//      are free once approved. Turnaround: 2-6 weeks per aggregator.
//        - Zomato: https://www.zomato.com/business/api
//        - Swiggy: https://partner.swiggy.com/partners/register
//
//   2. **REVERSE-ENGINEERED CONSUMER OTP FLOW** (fragile, ToS-risk).
//      Zomato's consumer-facing login endpoint accepts phone → sends
//      SMS OTP → returns a session token that transitively grants
//      access to the merchant's outlet list. This is what a lot of
//      "grey market" POS clones do. Downsides: (a) it violates their
//      ToS, (b) the endpoints change without notice — expect breakage
//      every ~90 days, (c) it exposes your users to account-lockouts
//      because Zomato treats this as automation. **We do not enable
//      this path in production code.**
//
// This file implements Path 1's *state machine* + a **stubbed** OTP
// sender that today just relays to our own MSG91 OTP (i.e. NamastePOS
// sends the OTP, not Zomato) so the UX flow works end-to-end while
// you're waiting for Partner API approval. When Zomato/Swiggy
// activates your partner account, swap `_sendMerchantOtp` to hit
// their partner endpoint instead of MSG91.
//
// State machine:
//   awaiting_otp  →  verified   →  linked    (happy path)
//        │              │           │
//        └──> failed <──┘           │
//                                   └──> failed  (webhook confirms unmapped)

const { query } = require('../config/db');
const otp = require('./otpService');
const { BadRequest, NotFound } = require('../utils/errors');

const SUPPORTED_PROVIDERS = ['zomato', 'swiggy'];

/**
 * Start a link session for a business + provider. Sends an OTP to
 * the owner's phone. Returns the session id + otp requestId so the
 * mobile app can poll / retry.
 */
async function startLink({ businessId, provider, phone }) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new BadRequest(`provider must be one of ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  // OTP first — if this throws (rate-limit, invalid phone), we never
  // create an orphan link session.
  const req = await otp.requestOtp({
    phone,
    purpose: `aggregator_link:${provider}`,
    meta: { businessId, provider },
  });
  const s = await query(
    `INSERT INTO aggregator_link_sessions
       (business_id, provider, phone, otp_request_id, status)
     VALUES ($1, $2, $3, $4, 'awaiting_otp')
     RETURNING *`,
    [businessId, provider, req.phone, req.requestId]
  );
  return {
    sessionId: s.rows[0].id,
    requestId: req.requestId,
    expiresIn: req.expiresIn,
    provider,
  };
}

/**
 * Verify the OTP the owner typed. On success moves session to
 * `verified` and (Path 1) fires the partner-side merchant-lookup so
 * we know which `outlet_id` to write into `aggregator_credentials`.
 */
async function verifyLink({ businessId, sessionId, code }) {
  const s = await query(
    `SELECT * FROM aggregator_link_sessions
      WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [sessionId, businessId]
  );
  if (s.rowCount === 0) throw new NotFound('Link session not found');
  const row = s.rows[0];
  if (row.status !== 'awaiting_otp') {
    throw new BadRequest(`Session already in state "${row.status}"`);
  }
  await otp.verifyOtp({ requestId: row.otp_request_id, code });

  // Path 1 hook: ask the partner API for the merchant's outlets by
  // phone. For now — until Partner API access lands — we mark the
  // session `verified` and the owner completes it by pasting their
  // outlet id (aggregatorService.upsertCredentials flips this session
  // to 'linked'). Webhook-based auto-association is NOT wired: an
  // incoming webhook carries no merchant phone, so matching would be
  // guesswork and a cross-tenant risk. completeLinkFromWebhook stays
  // for when the Partner API gives us a phone→outlet lookup.
  await query(
    `UPDATE aggregator_link_sessions
        SET status = 'verified'
      WHERE id = $1`,
    [sessionId]
  );

  return {
    sessionId,
    provider: row.provider,
    status: 'verified',
    nextStep: 'partner_lookup_or_first_webhook',
  };
}

/**
 * Called by aggregatorService when a webhook arrives and we notice
 * the outlet_id isn't yet in aggregator_credentials but a verified
 * link session exists for the same phone. This is the auto-linking
 * bridge that closes the loop without asking the owner for outlet id.
 */
async function completeLinkFromWebhook({ provider, outletId, phone }) {
  const s = await query(
    `SELECT * FROM aggregator_link_sessions
      WHERE provider = $1 AND phone = $2 AND status = 'verified'
      ORDER BY created_at DESC LIMIT 1`,
    [provider, phone]
  );
  if (s.rowCount === 0) return null;
  const row = s.rows[0];
  await query(
    `INSERT INTO aggregator_credentials
       (business_id, provider, outlet_id, is_active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (business_id, provider) DO UPDATE
       SET outlet_id = EXCLUDED.outlet_id, is_active = TRUE, updated_at = NOW()`,
    [row.business_id, provider, outletId]
  );
  await query(
    `UPDATE aggregator_link_sessions
        SET status = 'linked', linked_at = NOW(), merchant_ref = $2
      WHERE id = $1`,
    [row.id, outletId]
  );
  return { businessId: row.business_id, provider, outletId };
}

/**
 * List link sessions for a business (dashboard visibility).
 */
async function listSessions(businessId) {
  const r = await query(
    `SELECT id, provider, phone, status, merchant_ref, created_at, linked_at
       FROM aggregator_link_sessions
      WHERE business_id = $1
      ORDER BY created_at DESC LIMIT 25`,
    [businessId]
  );
  return r.rows;
}

module.exports = {
  startLink, verifyLink, completeLinkFromWebhook, listSessions,
  SUPPORTED_PROVIDERS,
};
