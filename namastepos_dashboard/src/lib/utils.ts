import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// P1 (Suresh #5): currency was hard-coded to INR but the backend supports
// other currencies on the plan side. We now read locale + currency from
// the business cache (set on login). Default remains en-IN / INR.
function _getCurrencyConfig(): { locale: string; currency: string } {
  try {
    const raw = localStorage.getItem('ff_dash_business');
    if (raw) {
      const biz = JSON.parse(raw);
      if (biz.currency) {
        return { locale: biz.locale || 'en-IN', currency: biz.currency };
      }
    }
  } catch (_) { /* fall through */ }
  return { locale: 'en-IN', currency: 'INR' };
}

export function formatINR(n: number, opts: { decimals?: boolean } = {}) {
  const { locale, currency } = _getCurrencyConfig();
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: opts.decimals ? 2 : 0,
    minimumFractionDigits: 0,
  }).format(n);
}

export function formatDate(d: string | Date) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(d));
}

/**
 * Convert an image URL stored in the database into something the browser
 * can fetch. Absolute URLs pass through unchanged. Relative paths returned
 * by our /uploads route (`/uploads/<bizId>/<file>`) get prefixed with the
 * API origin so they hit the backend's static handler.
 */
export function fullImageUrl(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/uploads')) {
    // P1 fix (2026-08-22): the localhost fallback leaked into production
    // builds — every menu image broke (plus https mixed-content blocks).
    // In prod default to same-origin (serve /uploads behind the same
    // reverse proxy as /v1); dev keeps the local backend.
    const origin = (import.meta as any).env?.VITE_API_ORIGIN
      || ((import.meta as any).env?.DEV ? 'http://localhost:4000' : '');
    return `${origin}${url}`;
  }
  return url;
}

export function formatDateTime(d: string | Date) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(d));
}
