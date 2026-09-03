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

// L-1 (2026-09-01): the short-lived access token now lives ONLY in this
// module-scoped variable — never in localStorage. localStorage persists
// across tabs/reloads and survives the page, so a single reflected-XSS
// payload landing at any time could read a token stored there; an
// in-memory token is gone the moment the tab closes and can't be lifted
// from storage by a fresh injection. The long-lived refresh token was
// already moved to the httpOnly `ff_refresh` cookie (Task-99); on reload
// bootstrapAuth() silently mints a new access token from that cookie, so
// keeping the access token out of storage costs the user nothing.
let accessToken: string | null = null;

export function setSession(token: string | null, _refresh?: string | null) {
  // Task-99: `_refresh` argument kept for call-site compatibility but
  // ignored — refresh token now lives in the httpOnly `ff_refresh`
  // cookie. If a backend build without the cookie flip is talking to a
  // client that already ships this change, the client simply doesn't
  // persist the refresh — subsequent silent-refresh calls will send
  // whatever cookie the server set (or 401 → force login).
  accessToken = token;
  if (token === null) localStorage.removeItem(BUSINESS_KEY);
  // Legacy hygiene: purge any tokens a previous release persisted so a
  // stale value can never be picked up (and so old localStorage tokens
  // stop lingering after this migration).
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ff_dash_refresh');
}
export function getToken() { return accessToken; }

// e2e / debugging hook: the Playwright suite used to read the access token
// from localStorage. Expose a read-only getter so it can still fetch the
// in-memory token. DEV-only (NP-105): in production third-party scripts
// (Crisp, Razorpay) run on the authed origin and could call this global,
// undoing the L-1 in-memory-token migration. Vite tree-shakes this branch
// out of prod bundles; the e2e helpers already use `__ffGetToken?.()` so
// they tolerate its absence.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__ffGetToken = () => accessToken;
}

let bootstrapped = false;

/**
 * Restore the session on a fresh page load. The access token is in-memory
 * only (see above), so after a reload we have nothing until we exchange the
 * httpOnly `ff_refresh` cookie for a new one. Resolves to true if a session
 * was restored, false if the user must log in.
 *
 * Also handles two adoption paths so nobody is logged out by this migration:
 *   1. `#imp=<token>` URL hash — super-admin impersonation (the admin app
 *      hands over a Bearer token); adopted into memory, then the hash is
 *      stripped so it never lands in history or a bookmark.
 *   2. a legacy `ff_dash_token` left in localStorage by a pre-migration
 *      build — adopted once, then removed.
 */
export async function bootstrapAuth(): Promise<boolean> {
  if (bootstrapped) return !!accessToken;
  bootstrapped = true;

  // 1a. NP-126 — impersonation via ONE-TIME CODE (`#impc=<code>`): the
  //     admin app no longer puts a raw JWT in the URL; it sends a short-
  //     lived single-use code we exchange server-side for a real access
  //     token. The fragment is stripped BEFORE the network call so the
  //     code never lingers in the address bar / history.
  try {
    const h = window.location.hash || '';
    const mc = h.match(/[#&]impc=([^&]+)/);
    if (mc) {
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', clean);
      const r = await axios.post(
        `${api.defaults.baseURL}/auth/impersonation-exchange`,
        { code: decodeURIComponent(mc[1]) },
        { withCredentials: true, headers: { 'X-Auth-Mode': 'cookie' } },
      );
      const tok = r.data?.accessToken || r.data?.token;
      if (tok) { accessToken = tok; return true; }
    }
  } catch (_) { /* expired/used code → fall through to normal auth */ }

  // 1b. Legacy impersonation hand-off via URL hash (`#imp=<token>`) — kept
  //     for back-compat with admin builds that predate NP-126.
  try {
    const h = window.location.hash || '';
    const m = h.match(/[#&]imp=([^&]+)/);
    if (m) {
      accessToken = decodeURIComponent(m[1]);
      // Strip the token from the URL without adding a history entry.
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', clean);
      return true;
    }
  } catch (_) { /* non-browser / malformed hash */ }

  // 2. One-time migration of a legacy persisted token.
  try {
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (legacy) {
      accessToken = legacy;
      localStorage.removeItem(TOKEN_KEY);
      return true;
    }
  } catch (_) { /* storage disabled */ }

  // 3. Silent refresh using the httpOnly cookie.
  try {
    const r = await axios.post(
      `${api.defaults.baseURL}/auth/refresh`,
      {},
      { withCredentials: true, headers: { 'X-Auth-Mode': 'cookie' } },
    );
    if (r.data?.token) { accessToken = r.data.token; return true; }
  } catch (_) { /* no valid cookie → not logged in */ }

  return false;
}

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
 * Wipe every persisted value that belonged to the business we are LEAVING.
 * Called by the outlet switcher (see hooks/useOutletSwitch) so nothing from
 * outlet A can bleed into outlet B.
 *
 * Storage audit 2026-09-03 — the only business-keyed value this app persists
 * today is BUSINESS_KEY (`ff_dash_business`), which the switcher immediately
 * re-keys via setBusinessCache(newBusiness). Every other `ff_*` / `np_*`
 * localStorage key is a per-USER preference that must SURVIVE a switch:
 * `ff_locale`, `np_nav_group_<group>`, `ff_cookie_decision_v1`,
 * `ff_anon_session_id`, `ff_seen_feature_tour_v2`, `ff_billing_period_user`.
 * So we (a) drop BUSINESS_KEY, (b) drop any key that embeds the outgoing
 * business id — future-proofing for per-outlet keys such as `ff_cart_<bid>`
 * or printer prefs — and (c) empty our sessionStorage namespace, which by
 * construction only ever holds transient per-outlet drafts.
 */
export function clearBusinessScopedStorage(prevBusinessId?: string | null) {
  try {
    localStorage.removeItem(BUSINESS_KEY);
    if (prevBusinessId) {
      for (const k of Object.keys(localStorage)) {
        if (k.includes(prevBusinessId)) localStorage.removeItem(k);
      }
    }
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith('ff_') || k.startsWith('np_')) sessionStorage.removeItem(k);
    }
  } catch (_) { /* storage disabled / private mode */ }
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

export async function exitImpersonation(): Promise<void> {
  // Auth fix (2026-08-30): call server-side logout FIRST, while the Bearer
  // token is still present. The request interceptor only attaches Authorization
  // when getToken() is truthy, and /auth/logout is auth-gated — so removing the
  // token before this call (the old order) made it arrive unauthenticated → 401,
  // and the refresh token/cookie were never actually revoked.
  try { await api.post('/auth/logout'); } catch { /* best-effort */ }
  setSession(null);
  localStorage.removeItem(BUSINESS_KEY);
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
