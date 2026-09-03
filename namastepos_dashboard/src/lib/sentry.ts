// NamastePOS dashboard — Sentry telemetry (FF-211 + FF-215).
//
// Loaded from main.tsx before React mounts. Reads VITE_SENTRY_DSN from
// build-time env; when unset, becomes a no-op (dev/local).
//
// NP-108: this used to soft-import via `try { require('@sentry/react') }`,
// but `require` doesn't exist in browser ESM, so the catch always fired
// and init was a permanent no-op. @sentry/react is a declared dependency,
// so import it statically. If Sentry is present + DSN is set, we register:
//   - init() with a `beforeSend` PII scrubber (FF-215)
//   - browserTracing integration (10 % sample in prod, 100 % in dev)
//
// PII scrubbing rules match the backend: strip email, phone (Indian
// mobile), JWTs, and known sensitive request/query keys.

import * as Sentry from '@sentry/react';

const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const RE_PHONE = /(?:\+?91[- ]?)?[6-9]\d{9}\b/g;
const RE_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const RE_BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;

const SENSITIVE_KEYS = new Set([
  'password', 'pin', 'refreshToken', 'refresh_token', 'accessToken',
  'access_token', 'token', 'authorization', 'auth', 'cookie',
  'ff_refresh', 'ff_csrf', 'phone', 'mobile', 'email',
  'customerPhone', 'customerName', 'ownerPhone', 'ownerEmail',
  'businessAddress', 'address', 'gstin', 'pan', 'aadhaar', 'aadhar',
]);

function scrubString(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  return s
    .replace(RE_BEARER, 'Bearer <redacted:token>')
    .replace(RE_JWT, '<redacted:token>')
    .replace(RE_EMAIL, '<redacted:email>')
    .replace(RE_PHONE, '<redacted:phone>');
}

function scrubTree(node: unknown, depth = 0): unknown {
  if (node == null || depth > 8) return node;
  if (typeof node === 'string') return scrubString(node);
  if (Array.isArray(node)) return node.map((v) => scrubTree(v, depth + 1));
  if (typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '<redacted>' : scrubTree(v, depth + 1);
    }
    return out;
  }
  return node;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function beforeSend(event: any) {
  try {
    if (event.user) event.user = { id: event.user.id };
    if (event.request) {
      if (event.request.headers) {
        for (const k of Object.keys(event.request.headers)) {
          if (['authorization', 'cookie', 'x-csrf-token']
            .includes(k.toLowerCase())) event.request.headers[k] = '<redacted>';
        }
      }
      if (event.request.cookies) event.request.cookies = '<redacted>';
      if (event.request.data) event.request.data = scrubTree(event.request.data);
      if (event.request.query_string) {
        event.request.query_string = scrubString(event.request.query_string);
      }
    }
    if (event.message) event.message = scrubString(event.message);
    if (event.exception?.values) {
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
  } catch { return null; }
  return event;
}

export function initSentry() {
  const dsn = (import.meta.env.VITE_SENTRY_DSN as string) || '';
  if (!dsn) return;                                   // DSN not set

  const mode = (import.meta.env.MODE as string) || 'development';
  Sentry.init({
    dsn,
    environment: mode,
    tracesSampleRate: mode === 'production' ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,     // no session replay by default (PII risk)
    replaysOnErrorSampleRate: 0,
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend,
    sendDefaultPii: false,
  });
}

// Optional escape hatch for manual capture.
export function captureError(e: unknown) {
  Sentry.captureException(e);
}
