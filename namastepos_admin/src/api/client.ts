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

/**
 * Establish a session after a successful login. Prefers the httpOnly cookie;
 * falls back to storing the Bearer token only if the cookie doesn't work.
 */
export async function establishSession(token: string): Promise<void> {
  try {
    // Probe with the cookie only (raw axios → bypasses our interceptors, so a
    // 401 here doesn't trigger the global redirect). No Authorization header.
    await axios.get(`${API}/admin/auth/me`, { withCredentials: true });
    localStorage.setItem(FLAG_KEY, '1');
    localStorage.removeItem(TOKEN_KEY); // credential lives in the cookie
  } catch {
    // Cookie didn't round-trip — keep working via Bearer (legacy path).
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(FLAG_KEY, '1');
  }
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
    return Promise.reject(err);
  }
);

export function apiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.message || err.message;
  }
  return String(err);
}
