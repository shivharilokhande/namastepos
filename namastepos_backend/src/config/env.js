// NamastePOS backend - environment configuration

require('dotenv').config();

const required = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

// P1 (Lakshmi #4): in prod, CORS_ORIGINS must be an explicit list — never
// the '*' wildcard. We pick the default based on NODE_ENV so a missed env
// var in prod fails closed instead of opening up cross-origin reads.
const nodeEnv = process.env.NODE_ENV || 'development';
const corsDefault = nodeEnv === 'production' ? '' : '*';

const env = {
  NODE_ENV: required('NODE_ENV', 'development'),
  PORT: parseInt(required('PORT', '4000'), 10),
  API_PREFIX: required('API_PREFIX', '/v1'),
  CORS_ORIGINS: required('CORS_ORIGINS', corsDefault)
    .split(',').map((s) => s.trim()).filter(Boolean),

  // P0 fix (2026-08-24): DATABASE_URL must fail closed in production.
  // Previously a localhost fallback with known creds was ALWAYS passed,
  // so a prod boot with the var unset silently attached to localhost.
  // Fallbacks now exist only for test/development.
  DATABASE_URL: nodeEnv === 'production'
    ? required('DATABASE_URL')
    : required('DATABASE_URL',
      nodeEnv === 'test'
        ? 'postgresql://namastepos:namastepos@localhost:5432/namastepos_test'
        : 'postgresql://namastepos:namastepos@localhost:5432/namastepos'),
  // Production sizing: the dev default of 10 starved concurrent
  // requests once >100 orders/min hit the API. Bumped to 30 so a
  // single Node worker can hold 30 concurrent PG connections without
  // queueing. Under PM2 cluster mode, N workers × 30 = N×30 total
  // sockets — keep this ≤ Postgres `max_connections` (default 100).
  // Prod recommendation: DB_POOL_MAX=50 in .env with PG max_connections
  // bumped to 200 for headroom.
  DB_POOL_MIN: parseInt(required('DB_POOL_MIN', '5'), 10),
  DB_POOL_MAX: parseInt(required('DB_POOL_MAX', '30'), 10),

  // P0 fix (2026-08-22): in production a missing JWT_SECRET must crash
  // the boot, not silently sign every token (and derive the 2FA KEK)
  // with a publicly known dev string.
  // Hardcode-audit fix (2026-08-24): the public dev fallback is now
  // limited to NODE_ENV=test. Development and staging must set their
  // own JWT_SECRET (dev .env already does) — otherwise staging would
  // sign tokens and derive the 2FA KEK from a publicly known string.
  JWT_SECRET: nodeEnv === 'test'
    ? required('JWT_SECRET', 'test-only-jwt-secret')
    : required('JWT_SECRET'),
  // P1 (Lakshmi #1): access tokens were 24h in the worst case — now capped
  // at 1h for a POS context. Refresh keeps users seamlessly signed in.
  JWT_EXPIRES_IN: required('JWT_EXPIRES_IN', nodeEnv === 'production' ? '1h' : '30m'),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: parseInt(
    required('REFRESH_TOKEN_EXPIRES_IN_DAYS', '30'), 10),

  GOOGLE_CLIENT_IDS: required('GOOGLE_CLIENT_IDS', '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // QA-8 P1: optional Workspace domain restriction. If set, only Google
  // accounts whose `hd` claim matches will be allowed to sign in.
  GOOGLE_HD_DOMAIN: process.env.GOOGLE_HD_DOMAIN || null,

  LOG_LEVEL: required('LOG_LEVEL', 'info'),
  // 120/min per IP was strangling a real cafe of 10 staff on the same
  // Wi-Fi (each got only 12 req/min). Bumped default to 600 (10/sec/IP)
  // which still stops attacks but doesn't punish real POS use. Move to
  // per-user keying in a future sprint; for now IP+bump is enough.
  RATE_LIMIT_WINDOW_MS: parseInt(required('RATE_LIMIT_WINDOW_MS', '60000'), 10),
  RATE_LIMIT_MAX: parseInt(required('RATE_LIMIT_MAX', '600'), 10),

  // Razorpay
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  // Super admin bootstrap. Hardcode-audit fix (2026-08-24): no email
  // fallback — a predictable default meant half the highest-privilege
  // credential pair was a known constant. Bootstrap now only runs when
  // BOTH email and password are explicitly configured.
  SUPER_ADMIN_EMAIL: process.env.SUPER_ADMIN_EMAIL || '',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || '',
  // Founder protection (2026-08-24): the account with this email can NEVER
  // be deactivated or demoted via the admin-team API, and only the founder
  // can change their own password. Defaults to the bootstrap super admin.
  FOUNDER_ADMIN_EMAIL: (process.env.FOUNDER_ADMIN_EMAIL
    || process.env.SUPER_ADMIN_EMAIL || '').toLowerCase(),

  // Twilio (WhatsApp Business)
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_WA_FROM: process.env.TWILIO_WA_FROM || '',

  // NIC e-invoice (optional — falls back to deterministic IRN when blank)
  IRP_BASE_URL: process.env.IRP_BASE_URL || '',
  IRP_USERNAME: process.env.IRP_USERNAME || '',
  IRP_PASSWORD: process.env.IRP_PASSWORD || '',

  // MSG91 (SMS OTP for phone sign-in + aggregator merchant linking).
  // Get your key at https://control.msg91.com > API tab. Sender ID must
  // be DLT-registered (₹0 setup, ~1-2 day approval). Cost ~₹0.13/SMS.
  MSG91_AUTHKEY: process.env.MSG91_AUTHKEY || '',
  MSG91_SENDER: process.env.MSG91_SENDER || 'FOODFL',
  MSG91_OTP_TEMPLATE_ID: process.env.MSG91_OTP_TEMPLATE_ID || '',
  // When MSG91_AUTHKEY is empty, requestOtp() falls back to logging the
  // OTP so you can develop without SMS spend. NEVER set OTP_DEV_MODE=1
  // in production.
  OTP_DEV_MODE: process.env.OTP_DEV_MODE === '1',

  // Firebase Cloud Messaging (push).
  //   FCM_PROJECT_ID           — your Firebase project id
  //   FCM_SERVICE_ACCOUNT_JSON — base64-encoded service-account JSON
  FCM_PROJECT_ID: process.env.FCM_PROJECT_ID || '',
  FCM_SERVICE_ACCOUNT_JSON: process.env.FCM_SERVICE_ACCOUNT_JSON || '',

  // Centralised (2026-08-22): these were read via bare process.env in
  // sentry.js / emailService / onboardingEmailService / reviewsService /
  // authController. Declared here so the config surface is complete.
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  APP_VERSION: process.env.APP_VERSION || '',
  APP_URL: process.env.APP_URL || '',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY
    || process.env.GOOGLE_API_KEY || '',
  FF_DEV_LOGIN: process.env.FF_DEV_LOGIN === '1',

  // Hardcode-audit fix (2026-08-24): trial length was hardcoded as
  // "14 days" in three places (authService inline SQL, customerAdmin
  // default, migration 002). Single source of truth now lives here.
  TRIAL_DAYS: parseInt(required('TRIAL_DAYS', '14'), 10),

  // Aggregator partner API hosts — env-driven so staging can point at
  // sandbox endpoints instead of live partner APIs.
  ZOMATO_API_BASE: process.env.ZOMATO_API_BASE || 'https://partner-api.zomato.com/v1',
  SWIGGY_API_BASE: process.env.SWIGGY_API_BASE || 'https://partner-api.swiggy.com/v2',

  isProd: () => env.NODE_ENV === 'production',
  isTest: () => env.NODE_ENV === 'test',
};

module.exports = env;
