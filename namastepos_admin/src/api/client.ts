// NamastePOS admin - API client (axios) with httpOnly-cookie auth.
//
// 2026-08-28 security redesign: the admin access token no longer lives in
// localStorage (XSS-readable). On login the backend Set-Cookie's an httpOnly
// `ff_admin` cookie; the browser sends it back automatically (withCredentials).
// We keep only a NON-sensitive session flag in localStorage for the client-
// side route guard.
//
// Zero-lockout fallback: right after login we probe /admin/auth/me relying on
// the cookie alone. If it round-trips → cookie mode (flag only, no token in JS).
// If it doesn't (e.g. a proxy strips the cookie) → we fall back to the legacy
// Bearer-in-localStorage behaviour so the admin can still sign in. Both are
// accepted by the backend (dual-mode).

import axios, { AxiosError } from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '/v1';
const API = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;

export const api = axios.create({
  baseURL: API,
  headers: { 'Content-Type': 'application/json', 'X-Auth-Mode': 'cookie' },
  withCredentials: true, // send/receive the ff_admin + ff_csrf cookies
});

const TOKEN_KEY = 'ff_admin_token';    // set ONLY in Bearer-fallback mode
const FLAG_KEY = 'ff_admin_session';   // non-sensitive: "a session exists"

export function isAuthed(): boolean {
  return !!localStorage.getItem(FLAG_KEY) || !!localStorage.getItem(TOKEN_KEY);
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function clearSession() {
  localStorage.removeItem(FLAG_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

// NP-113: report the probe outcome to Sentry (lazy + guarded — the module
// no-ops when VITE_SENTRY_DSN is unset, and a failed import must never
// break login).
function reportAuthProbe(mode: 'cookie' | 'bearer-fallback', err: unknown) {
  import('../lib/sentry')
    .then((m) => m.captureError(err, { admin_auth_mode: mode }))
    .catch(() => { /* sentry unavailable — ignore */ });
}

/**
 * Establish a session after a successful login. Prefers the httpOnly cookie;
 * falls back to storing the Bearer token only if the cookie doesn't work.
 *
 * NP-113: the fallback used to fire on ANY probe failure (network blip, 5xx,
 * timeout), silently persisting the JWT in localStorage. Now the probe is
 * retried once after a short backoff, and Bearer-fallback engages ONLY on a
 * definitive 401 (a response arrived and the cookie was not accepted).
 * Transient failures stay in cookie mode with a non-fatal warning.
 */
export async function establishSession(token: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Probe with the cookie only (raw axios → bypasses our interceptors, so a
      // 401 here doesn't trigger the global redirect). No Authorization header.
      await axios.get(`${API}/admin/auth/me`, { withCredentials: true, timeout: 10_000 });
      localStorage.setItem(FLAG_KEY, '1');
      localStorage.removeItem(TOKEN_KEY); // credential lives in the cookie
      return;
    } catch (e) {
      lastErr = e;
      if (axios.isAxiosError(e) && e.response?.status === 401) {
        // Definitive: the server answered and rejected the cookie — keep
        // working via Bearer (legacy path).
        // TODO (post cookie-auth prod verification): once we've confirmed the
        // httpOnly ff_admin cookie round-trips in production, REMOVE this fallback.
        // It re-introduces the XSS token-exposure the cookie redesign removed by
        // persisting the JWT in localStorage. Kept only as a zero-lockout safety net
        // during rollout. See reference_namastepos_compliance_console memory.
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(FLAG_KEY, '1');
        reportAuthProbe('bearer-fallback', e);
        return;
      }
      // Transient (network error / 5xx / timeout) — retry once, then give up
      // WITHOUT falling back to Bearer.
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.warn(
    '[admin-auth] cookie probe failed transiently after retry — staying in cookie mode',
    lastErr
  );
  localStorage.setItem(FLAG_KEY, '1');
  localStorage.removeItem(TOKEN_KEY);
  reportAuthProbe('cookie', lastErr);
}

// Back-compat shim used by LoginPage's "Back"/cancel + old callers: passing a
// token establishes a Bearer-fallback session synchronously; null clears.
export function setAdminToken(token: string | null) {
  if (token) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(FLAG_KEY, '1'); }
  else clearSession();
}
export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export async function adminLogout() {
  try { await api.post('/admin/auth/logout'); } catch { /* clear locally regardless */ }
  clearSession();
}

api.interceptors.request.use((cfg) => {
  // Bearer only in fallback mode; otherwise the cookie carries auth.
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  // CSRF double-submit for cookie-mode mutations.
  const method = (cfg.method || 'get').toLowerCase();
  if (!['get', 'head', 'options'].includes(method)) {
    const csrf = readCookie('ff_csrf');
    if (csrf) cfg.headers['X-CSRF-Token'] = csrf;
  }
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError<{ error?: string; message?: string }>) => {
    if (err.response?.status === 401) {
      clearSession();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    // 403 is NOT a session problem — it means "you lack permission for THIS
    // action". Reloading the SPA on it threw away in-progress work and hid the
    // real reason, so it now rejects normally and the calling page surfaces the
    // message (toast / error card). Only 401 (session gone) redirects.
    return Promise.reject(err);
  }
);

export function apiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.message || err.message;
  }
  return String(err);
}
