// NamastePOS admin - API client (axios) with httpOnly-cookie auth.
//
// 2026-08-28 security redesign: the admin access token does not live in
// localStorage (XSS-readable). On login the backend Set-Cookie's an httpOnly
// `ff_admin` cookie; the browser sends it back automatically (withCredentials).
// We keep only a NON-sensitive session flag in localStorage for the client-
// side route guard.
//
// 2026-09-04 (security review, item 2): the "zero-lockout" Bearer fallback is
// GONE, on both sides.
//
// It used to write the raw super-admin JWT into localStorage whenever the
// post-login cookie probe came back with a definitive 401, and the axios
// interceptor then attached it as `Authorization: Bearer`. That is precisely
// the exposure the cookie redesign existed to remove: one XSS anywhere in the
// admin console — a dependency, a rendered customer-supplied string — could
// read the highest-privilege credential in the product and use it from
// anywhere. A rollout safety net that re-introduces the vulnerability it is
// protecting the rollout of is not a safety net.
//
// The backend now accepts the admin session ONLY from the `ff_admin` cookie
// (see middleware/auth.js `_decodeAdmin`), so there is nothing for a stored
// token to talk to. If the cookie cannot round-trip, the correct outcome is a
// visible failure at the login screen — not a silent downgrade to a weaker
// auth mode that nobody notices for months.

import axios, { AxiosError } from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '/v1';
const API = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;

export const api = axios.create({
  baseURL: API,
  headers: { 'Content-Type': 'application/json', 'X-Auth-Mode': 'cookie' },
  withCredentials: true, // send/receive the ff_admin + ff_csrf cookies
});

const FLAG_KEY = 'ff_admin_session';   // non-sensitive: "a session exists"
// Removed 2026-09-04. Kept only as a one-time cleanup below so any admin who
// is mid-session with a token still sitting in localStorage gets it wiped on
// their next page load instead of leaving it there to be stolen.
const LEGACY_TOKEN_KEY = 'ff_admin_token';
try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* private mode */ }

export function isAuthed(): boolean {
  return !!localStorage.getItem(FLAG_KEY);
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function clearSession() {
  localStorage.removeItem(FLAG_KEY);
  try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* ignore */ }
}

// NP-113: report the probe outcome to Sentry (lazy + guarded — the module
// no-ops when VITE_SENTRY_DSN is unset, and a failed import must never
// break login).
function reportAuthProbe(mode: 'cookie' | 'cookie-rejected', err: unknown) {
  import('../lib/sentry')
    .then((m) => m.captureError(err, { admin_auth_mode: mode }))
    .catch(() => { /* sentry unavailable — ignore */ });
}

/**
 * Establish a session after a successful login.
 *
 * The credential is the httpOnly cookie the login response already set; this
 * only confirms it round-trips and flips the local route-guard flag. The
 * `token` argument is accepted for call-site compatibility and intentionally
 * ignored — nothing in this app may hold the admin JWT in JS.
 *
 * A definitive 401 on the probe means the cookie did not come back (a proxy
 * stripping it, a Secure/SameSite mismatch, a wrong VITE_API_URL origin) and
 * the admin genuinely has no usable session — so we surface it instead of
 * papering over it with a Bearer token.
 */
export async function establishSession(_token?: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Probe with the cookie only (raw axios → bypasses our interceptors, so a
      // 401 here doesn't trigger the global redirect).
      await axios.get(`${API}/admin/auth/me`, { withCredentials: true, timeout: 10_000 });
      localStorage.setItem(FLAG_KEY, '1');
      return;
    } catch (e) {
      lastErr = e;
      if (axios.isAxiosError(e) && e.response?.status === 401) {
        clearSession();
        reportAuthProbe('cookie-rejected', e);
        throw new Error(
          'Signed in, but the session cookie was rejected. If you are behind a '
          + 'proxy or on a custom domain, check that the API and admin origins '
          + 'share a site and that HTTPS is in use.'
        );
      }
      // Transient (network error / 5xx / timeout) — retry once.
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // Transient failure after a retry: the cookie is very likely fine (the login
  // that just succeeded set it), so let the admin proceed; the first real API
  // call will 401 and bounce them to /login if it isn't.
  console.warn(
    '[admin-auth] cookie probe failed transiently after retry — proceeding in cookie mode',
    lastErr
  );
  localStorage.setItem(FLAG_KEY, '1');
  reportAuthProbe('cookie', lastErr);
}

// Back-compat shim used by LoginPage's "Back"/cancel: null clears the local
// session flag. There is no token to set any more, so a non-null argument only
// marks that a session exists.
export function setAdminToken(token: string | null) {
  if (token) localStorage.setItem(FLAG_KEY, '1');
  else clearSession();
}

export async function adminLogout() {
  try { await api.post('/admin/auth/logout'); } catch { /* clear locally regardless */ }
  clearSession();
}

api.interceptors.request.use((cfg) => {
  // Auth is the httpOnly ff_admin cookie — never an Authorization header.
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
