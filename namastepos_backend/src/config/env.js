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
    : required(
      'DATABASE_URL',
      nodeEnv === 'test'
        ? 'postgresql://namastepos:namastepos@localhost:5432/namastepos_test'
        : 'postgresql://namastepos:namastepos@localhost:5432/namastepos',
    ),
  // Production sizing: the dev default of 10 starved concurrent
  // requests once >100 orders/min hit the API. Bumped to 30 so a
  // single Node worker can hold 30 concurrent PG connections without
  // queueing. Under PM2 cluster mode, N workers × 30 = N×30 total
  // sockets — keep this ≤ Postgres `max_connections` (default 100).
  // Prod recommendation: DB_POOL_MAX=50 in .env with PG max_connections
  // bumped to 200 for headroom.
  // TLS to Postgres (required by Neon/Supabase/managed providers).
  DATABASE_SSL: process.env.DATABASE_SSL === '1',
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
  REFRESH_TOKEN_EXPIRES_IN_DAYS: parseInt(required('REFRESH_TOKEN_EXPIRES_IN_DAYS', '30'), 10),

  // Security review 2026-09-04 (item 3): key-encryption key for admin TOTP
  // secrets (admin_users.totp_secret_enc, AES-256-GCM).
  //
  // OPTIONAL, but strongly recommended. Until this was introduced the KEK was
  // derived from JWT_SECRET, which coupled two unrelated lifecycles:
  //   • rotating JWT_SECRET — a routine and sometimes urgent operation —
  //     permanently bricked every admin's 2FA (the stored secrets could no
  //     longer be decrypted, so nobody could complete a 2FA login), and
  //   • one leaked value compromised both session signing AND the 2FA seeds.
  //
  // Generate with:   openssl rand -base64 32
  // Unset → twoFactorService falls back to the JWT_SECRET-derived key and logs
  // a startup warning. It never fails boot: taking prod down over a missing
  // optional key would be a worse outcome than the coupling it fixes.
  // Existing rows stay readable either way (see twoFactorService for the
  // versioned-ciphertext + lazy re-encryption scheme).
  TOTP_ENC_KEY: process.env.TOTP_ENC_KEY || '',

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

  // Cloudflare R2 object storage (2026-08-25). When ALL are set, image
  // uploads go to R2 and are served from R2_PUBLIC_URL; otherwise the
  // route falls back to local disk (dev only — Render disk is ephemeral).
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET: process.env.R2_BUCKET || '',
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',

  // Twilio (WhatsApp Business) — legacy fallback provider
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_WA_FROM: process.env.TWILIO_WA_FROM || '',

  // Meta WhatsApp Cloud API (preferred — direct from Meta, no BSP markup).
  //   META_WA_PHONE_NUMBER_ID — the WABA phone number's id (Graph API)
  //   META_WA_ACCESS_TOKEN    — permanent system-user token with whatsapp perms
  //   META_WA_API_VERSION     — Graph API version (default v20.0)
  //   META_WA_VERIFY_TOKEN    — arbitrary secret you also paste in the Meta
  //                             webhook config (GET hub.verify_token check)
  //   META_WA_APP_SECRET      — Meta app secret, to verify X-Hub-Signature-256
  //   META_WA_OTP_TEMPLATE    — approved AUTHENTICATION template name for OTP
  //   META_WA_LANG            — template language code (default en)
  // When these are unset the service falls back to Twilio, then to mock-log.
  META_WA_PHONE_NUMBER_ID: process.env.META_WA_PHONE_NUMBER_ID || '',
  META_WA_ACCESS_TOKEN: process.env.META_WA_ACCESS_TOKEN || '',
  META_WA_API_VERSION: process.env.META_WA_API_VERSION || 'v20.0',
  META_WA_VERIFY_TOKEN: process.env.META_WA_VERIFY_TOKEN || '',
  META_WA_APP_SECRET: process.env.META_WA_APP_SECRET || '',
  META_WA_OTP_TEMPLATE: process.env.META_WA_OTP_TEMPLATE || '',
  META_WA_LANG: process.env.META_WA_LANG || 'en',

  // Dunning ladder templates (2026-09-05). Four escalating touches across the
  // past_due grace plus a recovery message — the copy lives in the marketing
  // repo at `content/emails/dunning-ladder.md`, which suggests the names
  // np_dun_1_failed / np_dun_2_pending / np_dun_3_midpoint / np_dun_4_last_day
  // / np_dun_recovered, all UTILITY category.
  //
  // THESE MUST BE APPROVED IN META BEFORE THEY CAN SEND. A business-initiated
  // WhatsApp message outside the 24-hour service window is rejected unless the
  // template is approved on the WABA, and the template name is an account-level
  // fact this codebase cannot invent. So each var defaults to BLANK and
  // dunningService then degrades that touch to email — the owner is always
  // messaged, just on the slower channel, and nothing throws. Fill these in
  // once the templates come back approved; no redeploy of logic is needed.
  //
  // Body variable order is fixed and must match the approved template:
  //   {{1}} first name  {{2}} outlet  {{3}} amount (₹)  {{4}} plan
  //   {{5}} grace end date (next debit date on the recovery message)
  //   {{6}} payment link
  META_WA_DUN_1_TEMPLATE: process.env.META_WA_DUN_1_TEMPLATE || '',
  META_WA_DUN_2_TEMPLATE: process.env.META_WA_DUN_2_TEMPLATE || '',
  META_WA_DUN_3_TEMPLATE: process.env.META_WA_DUN_3_TEMPLATE || '',
  META_WA_DUN_4_TEMPLATE: process.env.META_WA_DUN_4_TEMPLATE || '',
  META_WA_DUN_RECOVERED_TEMPLATE: process.env.META_WA_DUN_RECOVERED_TEMPLATE || '',

  // Redis (OPTIONAL) — only for cross-instance feature-cache invalidation when
  // running >1 backend instance. Unset = single-instance in-process cache
  // (fine today). Free options: Upstash, Render Key Value, Redis Cloud.
  REDIS_URL: process.env.REDIS_URL || '',

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
  TRIAL_DAYS: parseInt(required('TRIAL_DAYS', '7'), 10),

  // 2026-09-04 (pricing audit F-01): which plan a signup's free trial is
  // provisioned on when the signup itself doesn't name one. Blank (the
  // default) means "resolve the cheapest paid, public, shared plan at
  // runtime" — deliberately NOT a hardcoded tier code, because the live
  // ladder is admin-editable and the tier codes drift (`pro_plan` is Pro,
  // `pro` is Enterprise). Set to e.g. `pro_plan` on Render to trial the plan
  // marketing points at. An unknown/retired/private value is ignored and the
  // runtime default applies, so a typo can never break signup.
  TRIAL_PLAN_TIER: (process.env.TRIAL_PLAN_TIER || '').trim(),

  // 2026-09-04 (retention audit F-02): how long a `past_due` subscription
  // keeps its features while dunning runs. Before this, one failed autopay
  // stripped a working restaurant down to the Starter feature set before the
  // owner had read the first email. 7 days matches the dunning ladder
  // (day 0 / 3 / 7). 0 restores the old strip-immediately behaviour.
  PAST_DUE_GRACE_DAYS: (() => {
    const n = parseInt(process.env.PAST_DUE_GRACE_DAYS || '7', 10);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  })(),

  // NP-112 (2026-09-03): server-side order tax/discount enforcement mode.
  //   'log'     (default) — accept client-sent tax/discount, but warn when
  //             the tax differs > ₹1 from the menu-derived GST or a discount
  //             exceeds the approval threshold with no manager approval.
  //   'enforce' — persist the server-computed tax and 403
  //             (DISCOUNT_APPROVAL_REQUIRED) unapproved high discounts.
  // Rollout: run 'log' first, review the warns, then flip to 'enforce'.
  // NB: orderService reads process.env at call time (so tests can flip it
  // per-test); this entry documents the knob on the config surface.
  ORDER_TAX_ENFORCE: process.env.ORDER_TAX_ENFORCE || 'log',

  // NP-121 (2026-09-03): revenue-integrity nightly cron. DEFAULT OFF —
  // runs only when REVENUE_INTEGRITY_CRON=true. When enabled,
  // PLATFORM_ALERT_EMAIL (the founder's inbox) is REQUIRED — the job
  // fails loudly at start rather than silently checking and telling
  // no one. Emails go through the existing emailService (Brevo/SMTP).
  REVENUE_INTEGRITY_CRON: process.env.REVENUE_INTEGRITY_CRON === 'true',
  PLATFORM_ALERT_EMAIL: process.env.PLATFORM_ALERT_EMAIL || '',

  // Aggregator partner API hosts — env-driven so staging can point at
  // sandbox endpoints instead of live partner APIs.
  // 2026-09-03 — outbound status callbacks are OFF unless explicitly enabled.
  // Zomato/Swiggy partner APIs require a signed agreement (Zomato: 50+
  // restaurants or 10k orders/month); without one these calls cannot succeed,
  // so firing them by default would just fill the log with 401/404s and hide
  // the fact that nothing reached the aggregator. Set to 'true' only once real
  // partner credentials + endpoint contracts are in place.
  AGGREGATOR_OUTBOUND_ENABLED: process.env.AGGREGATOR_OUTBOUND_ENABLED || 'false',
  ZOMATO_API_BASE: process.env.ZOMATO_API_BASE || 'https://partner-api.zomato.com/v1',
  SWIGGY_API_BASE: process.env.SWIGGY_API_BASE || 'https://partner-api.swiggy.com/v2',

  isProd: () => env.NODE_ENV === 'production',
  isTest: () => env.NODE_ENV === 'test',
};

module.exports = env;
