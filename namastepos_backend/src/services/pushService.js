// NamastePOS — Push notifications (FF-330).
//
// Sends FCM / APNS pushes to registered device tokens. Sit on top of
// the `device_tokens` table populated by the mobile app.
//
// Design decisions:
//   • The Flutter app registers a token via POST /me/device-tokens
//     on cold start. Tokens are user-scoped (not per-business) so a
//     staff member using two devices still gets both pinged.
//   • Sends via Firebase HTTP v1 API. Env vars:
//         FCM_PROJECT_ID    -- your Firebase project
//         FCM_SERVICE_ACCOUNT_JSON -- base64-encoded service-account JSON
//     Absent → soft no-op logger, same fail-safe pattern as email +
//     WhatsApp services elsewhere.

const { query } = require('../config/db');
const logger = require('../config/logger');

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function _getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  if (!process.env.FCM_SERVICE_ACCOUNT_JSON) return null;
  // OAuth token exchange with Google. Base64-decode the SA JSON, sign
  // a JWT, exchange for an access token good for 1 hour.
  const svc = JSON.parse(Buffer.from(process.env.FCM_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8'));
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`);
  const signature = signer.sign(svc.private_key, 'base64url');
  const assertion = `${header}.${claim}.${signature}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`FCM token exchange failed: ${JSON.stringify(j)}`);
  cachedToken = j.access_token;
  cachedTokenExpiresAt = Date.now() + (j.expires_in - 60) * 1000;
  return cachedToken;
}

async function registerToken(userId, businessId, { token, platform }) {
  if (!token) return;
  await query(
    `INSERT INTO device_tokens (user_id, business_id, platform, token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, token) DO UPDATE
       SET business_id = EXCLUDED.business_id,
           platform    = EXCLUDED.platform,
           last_seen_at = NOW()`,
    [userId, businessId || null, platform || 'android', token],
  );
}

async function sendToBusinessOwners(businessId, { title, body, data = {} }) {
  const r = await query(
    `SELECT DISTINCT dt.token, dt.platform
       FROM device_tokens dt
       JOIN business_users bu ON bu.user_id = dt.user_id
                             AND bu.business_id = $1
                             AND bu.role = 'business_owner'
                             AND bu.is_active = TRUE
      WHERE dt.last_seen_at > NOW() - INTERVAL '30 days'`,
    [businessId],
  );
  if (r.rowCount === 0) return { sent: 0 };

  const projectId = process.env.FCM_PROJECT_ID;
  const accessToken = await _getAccessToken().catch((e) => {
    logger.warn(`[push] token exchange failed: ${e.message}`);
    return null;
  });
  if (!projectId || !accessToken) {
    logger.info(`[push mock] biz=${businessId} would send "${title}" to ${r.rowCount} device(s)`);
    return { sent: 0, mocked: r.rowCount };
  }

  let sent = 0;
  for (const row of r.rows) {
    try {
      const resp = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: row.token,
              notification: { title, body },
              data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
              android: { priority: 'HIGH' },
            },
          }),
        },
      );
      if (resp.ok) sent++;
      else {
        const t = await resp.text();
        logger.warn(`[push] FCM ${resp.status}: ${t.slice(0, 200)}`);
        // Common: UNREGISTERED — token stale, drop it.
        if (t.includes('UNREGISTERED') || resp.status === 404) {
          await query('DELETE FROM device_tokens WHERE token = $1', [row.token]);
        }
      }
    } catch (e) {
      logger.warn(`[push] send failed: ${e.message}`);
    }
  }
  return { sent };
}

module.exports = { registerToken, sendToBusinessOwners };
