// NamastePOS backend — Sentry telemetry (FF-211 + FF-215).
//
// Loads @sentry/node lazily so the app still boots if the SDK isn't
// installed yet (soft-fail). Wire from app.js as:
//     const sentry = require('./config/sentry');
//     sentry.installRequestHandler(app);   // BEFORE any middleware
//     // ... routes ...
//     sentry.installErrorHandler(app);     // AFTER routes, BEFORE errorHandler
//
// FF-215: the `beforeSend` hook scrubs every event/breadcrumb of PII
// before it leaves the box:
//   - email addresses            → <redacted:email>
//   - phone numbers (10 digits)  → <redacted:phone>
//   - JWT / bearer tokens        → <redacted:token>
//   - user.email / user.name     → dropped
//   - request cookies / auth hdr → dropped
//   - request body body/query    → aggressively redacted per key
//
// Turn Sentry on by setting SENTRY_DSN in the env. Absent DSN → no-op.

const env = require('./env');

let Sentry = null;
try {
  // eslint-disable-next-line global-require
  Sentry = require('@sentry/node');
} catch (_) {
  // SDK not installed — this module becomes a no-op family of shims.
}

// -- PII scrubbing --------------------------------------------------------
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const RE_PHONE = /(?:\+?91[- ]?)?[6-9]\d{9}\b/g;      // Indian mobile
const RE_JWT   = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const RE_BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;

const SENSITIVE_KEYS = new Set([
  'password', 'pin', 'refreshToken', 'refresh_token', 'accessToken',
  'access_token', 'token', 'authorization', 'auth', 'cookie',
  'ff_refresh', 'ff_csrf', 'phone', 'mobile', 'email',
  'customerPhone', 'customerName', 'ownerPhone', 'ownerEmail',
  'businessAddress', 'address', 'gstin', 'pan', 'aadhaar', 'aadhar',
]);

function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(RE_BEARER, 'Bearer <redacted:token>')
    .replace(RE_JWT, '<redacted:token>')
    .replace(RE_EMAIL, '<redacted:email>')
    .replace(RE_PHONE, '<redacted:phone>');
}

function scrubTree(node, depth = 0) {
  if (node == null || depth > 8) return node;
  if (typeof node === 'string') return scrubString(node);
  if (Array.isArray(node)) return node.map((v) => scrubTree(v, depth + 1));
  if (typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = '<redacted>';
      } else {
        out[k] = scrubTree(v, depth + 1);
      }
    }
    return out;
  }
  return node;
}

function beforeSend(event) {
  try {
    // Drop the entire user object — never send who to Sentry.
    if (event.user) event.user = { id: event.user.id || undefined };

    if (event.request) {
      // Strip auth-bearing headers wholesale.
      if (event.request.headers) {
        for (const k of Object.keys(event.request.headers)) {
          if (['authorization', 'cookie', 'x-csrf-token']
            .includes(k.toLowerCase())) {
            event.request.headers[k] = '<redacted>';
          }
        }
      }
      if (event.request.cookies) event.request.cookies = '<redacted>';
      // Request body/query — walk the tree.
      if (event.request.data) event.request.data = scrubTree(event.request.data);
      if (event.request.query_string) {
        event.request.query_string = scrubString(event.request.query_string);
      }
    }

    // Free-form string fields anywhere in the event payload.
    if (event.message) event.message = scrubString(event.message);
    if (event.exception && event.exception.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubString(ex.value);
      }
    }
    if (event.breadcrumbs) {
      for (const bc of event.breadcrumbs) {
        if (bc.message) bc.message = scrubString(bc.message);
        if (bc.data) bc.data = scrubTree(bc.data);
      }
    }
  } catch (_) {
    // Never let scrubbing itself throw — Sentry will drop the event anyway
    // if we return null.
    return null;
  }
  return event;
}

// -- init / handler shims -------------------------------------------------
let initialised = false;

function init() {
  if (initialised) return;
  initialised = true;
  if (!Sentry) return;                          // SDK missing → no-op
  if (!process.env.SENTRY_DSN) return;          // DSN not set → no-op

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || undefined,
    // Sample rates — start conservative in prod, verbose in dev.
    tracesSampleRate: env.isProd() ? 0.10 : 1.0,
    profilesSampleRate: 0.0,                    // profiling off for now
    beforeSend,
    beforeBreadcrumb(bc) {
      // The DB integration would log SQL params in breadcrumbs which may
      // include phone numbers etc. Drop the params, keep the shape.
      if (bc.data && bc.data.sql) {
        bc.data = { ...bc.data, sqlParams: '<redacted>' };
      }
      return bc;
    },
  });
}

function installRequestHandler(app) {
  init();
  if (!Sentry || !process.env.SENTRY_DSN) return;
  // Sentry v7 API. v8 uses `setupExpressErrorHandler` instead.
  if (Sentry.Handlers && Sentry.Handlers.requestHandler) {
    app.use(Sentry.Handlers.requestHandler());
    if (Sentry.Handlers.tracingHandler) {
      app.use(Sentry.Handlers.tracingHandler());
    }
  }
}

function installErrorHandler(app) {
  if (!Sentry || !process.env.SENTRY_DSN) return;
  if (Sentry.Handlers && Sentry.Handlers.errorHandler) {
    app.use(Sentry.Handlers.errorHandler({
      shouldHandleError(err) {
        // Only send 5xx and unclassified errors to Sentry; 4xx are user
        // problems (bad input, expired token) and just create noise.
        const status = err.status || err.statusCode || 500;
        return status >= 500;
      },
    }));
  } else if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app);
  }
}

module.exports = {
  init,
  installRequestHandler,
  installErrorHandler,
  // exposed for unit tests
  __scrubTree: scrubTree,
  __scrubString: scrubString,
  __beforeSend: beforeSend,
};
