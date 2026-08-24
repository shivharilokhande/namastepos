// NamastePOS admin - API client (axios) with JWT injection

import axios, { AxiosError } from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '/v1';

export const api = axios.create({
  baseURL: baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`,
  headers: {
    'Content-Type': 'application/json',
    // Task-99: opt into httpOnly-cookie refresh mode. Admin doesn't
    // ship a refresh-token flow yet (it re-logs on 401), so today this
    // is only forward-compatibility — when we wire refresh here in a
    // follow-up, the backend will Set-Cookie `ff_refresh` and the
    // browser will send it back without JS ever seeing the token.
    'X-Auth-Mode': 'cookie',
  },
  withCredentials: true,
});

const TOKEN_KEY = 'ff_admin_token';

export function setAdminToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

api.interceptors.request.use((cfg) => {
  const t = getAdminToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError<{ error?: string; message?: string }>) => {
    if (err.response?.status === 401) {
      setAdminToken(null);
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
