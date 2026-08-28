// NamastePOS dashboard - API client with JWT + refresh

import axios, { AxiosError } from 'axios';
import { toast } from 'sonner';

const baseURL = import.meta.env.VITE_API_URL || '/v1';

export const api = axios.create({
  baseURL: baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`,
  headers: {
    'Content-Type': 'application/json',
    // Task-99: opt into httpOnly-cookie refresh mode. The backend
    // reads this on login endpoints, Set-Cookie's the refresh token,
    // and blanks it out of the JSON body — so we no longer store
    // long-lived refresh tokens in localStorage where XSS could steal
    // them. Access token stays in localStorage for now because it's
    // short-lived (15 min) and easier to migrate incrementally.
    'X-Auth-Mode': 'cookie',
  },
  // Required for the browser to send `ff_refresh` back to the server
  // on cross-origin XHRs. Backend Set-Cookie flags: httpOnly + secure
  // (prod) + sameSite=strict + path=/v1/auth.
  withCredentials: true,
});

const TOKEN_KEY = 'ff_dash_token';
const BUSINESS_KEY = 'ff_dash_business';

export function setSession(token: string | null, _refresh?: string | null) {
  // Task-99: `_refresh` argument kept for call-site compatibility but
  // ignored — refresh token now lives in the httpOnly `ff_refresh`
  // cookie. If a backend build without the cookie flip is talking to a
  // client that already ships this change, the client simply doesn't
  // persist the refresh — subsequent silent-refresh calls will send
  // whatever cookie the server set (or 401 → force login).
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  if (token === null) localStorage.removeItem(BUSINESS_KEY);
  // Legacy: remove any refresh token that may still be persisted from
  // a previous release so it can't be picked up by mistake.
  localStorage.removeItem('ff_dash_refresh');
}
export function getToken() { return localStorage.getItem(TOKEN_KEY); }

export function setBusinessCache(b: any) {
  if (b) localStorage.setItem(BUSINESS_KEY, JSON.stringify(b));
  else localStorage.removeItem(BUSINESS_KEY);
}
export function getBusinessCache(): any | null {
  // Review 2026-08-28: guard the parse — a corrupt/partial cache value used to
  // throw a raw SyntaxError deep in ~40 api methods instead of degrading to a
  // clean logged-out state.
  const raw = localStorage.getItem(BUSINESS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { localStorage.removeItem(BUSINESS_KEY); return null; }
}

/**
 * Detects impersonation by decoding the JWT payload and checking the `imp` flag
 * (super admin issues tokens with imp: true on impersonate).
 */
export function isImpersonating(): boolean {
  const t = getToken();
  if (!t) return false;
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    return payload.imp === true;
  } catch (_) { return false; }
}

export function exitImpersonation(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ff_dash_refresh');
  localStorage.removeItem(BUSINESS_KEY);
  // Clear the refresh cookie too — best-effort; server-side logout is
  // the authoritative revocation path.
  api.post('/auth/logout').catch(() => { /* swallow */ });
  window.location.href = '/login';
}

api.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

let refreshing: Promise<void> | null = null;

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError<{ error?: string; message?: string; code?: string }>) => {
    const orig = err.config!;
    if (err.response?.status === 401 && !(orig as any)._retry) {
      (orig as any)._retry = true;
      try {
        if (!refreshing) {
          refreshing = (async () => {
            // Task-99: refresh token now lives in the `ff_refresh`
            // httpOnly cookie. `withCredentials: true` on this axios
            // instance sends it automatically; body stays empty. If a
            // legacy user still has the cookie from a pre-migration
            // session, this call also works. On any failure we bounce
            // to /login via the outer catch.
            const r = await axios.post(
              `${api.defaults.baseURL}/auth/refresh`,
              {},
              { withCredentials: true },
            );
            setSession(r.data.token, null);
          })().finally(() => { refreshing = null; });
        }
        await refreshing;
        orig.headers!.Authorization = `Bearer ${getToken()}`;
        return api.request(orig);
      } catch (_) {
        // P1 (Suresh #3): refresh used to fail silently → user landed on
        // /login with no explanation. Now we tell them their session expired.
        setSession(null);
        if (!window.location.pathname.startsWith('/login')) {
          toast.error('Your session expired. Please sign in again.');
          setTimeout(() => { window.location.href = '/login'; }, 800);
        }
      }
    }
    return Promise.reject(err);
  }
);

// P1 (Suresh #8): include the backend error.code so support can diagnose
// from a screenshot. Format: "ADDON_REQUIRED: <message>".
export function apiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as any;
    const msg = data?.message || err.message;
    const code = data?.code || data?.error;
    return code && code !== msg ? `${code}: ${msg}` : msg;
  }
  return String(err);
}
