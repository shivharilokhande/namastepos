// NamastePOS backend - Google ID token verification

const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const { Unauthorized } = require('../utils/errors');

const client = new OAuth2Client();

/**
 * Verify the Google ID token presented by the mobile app.
 * Returns the payload (sub, email, name, picture) on success.
 * Throws Unauthorized on failure.
 *
 * The audience must be in the configured GOOGLE_CLIENT_IDS list.
 */
async function verifyIdToken(idToken) {
  if (!idToken) throw new Unauthorized('Missing idToken');
  if (env.GOOGLE_CLIENT_IDS.length === 0) {
    throw new Unauthorized('Server is not configured with GOOGLE_CLIENT_IDS');
  }
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_IDS,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) throw new Unauthorized('Empty Google payload');
    if (payload.email_verified === false) {
      throw new Unauthorized('Google account email is not verified');
    }
    // QA-8 P1 (Lakshmi #6): if GOOGLE_HD_DOMAIN is set, only accept tokens
    // from that Google Workspace tenant. Useful for enterprise customers
    // who want to lock sign-up to "@theircompany.com" Google accounts.
    if (env.GOOGLE_HD_DOMAIN && payload.hd !== env.GOOGLE_HD_DOMAIN) {
      throw new Unauthorized(`Only ${env.GOOGLE_HD_DOMAIN} Google accounts are allowed`);
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified !== false,
      name: payload.name,
      picture: payload.picture,
      givenName: payload.given_name,
      familyName: payload.family_name,
    };
  } catch (err) {
    if (err.statusCode) throw err;
    throw new Unauthorized(`Google token verification failed: ${err.message}`);
  }
}

module.exports = { verifyIdToken };
