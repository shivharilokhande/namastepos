// Shared helpers across all NamastePOS e2e specs.
//
// Convention: every spec assumes the dashboard at FF_BASE_URL and the
// backend at FF_API_URL are already running. We never spawn them from
// here — keep tests + dev servers decoupled.

import { expect, Page } from '@playwright/test';

// A dedicated test owner the Playwright suite provisions on first run via
// /v1/auth/register. Keeps tests independent of any real account whose
// password might be reset/forgotten over time.
export const ENV = {
  baseUrl: process.env.FF_BASE_URL || 'http://localhost:5174',
  apiUrl:  process.env.FF_API_URL  || 'http://localhost:4000/v1',
  // Joi's email validator rejects unusual TLDs like .test — use .com.
  email:   process.env.FF_OWNER_EMAIL    || 'playwright-owner@namastepos-test.com',
  password:process.env.FF_OWNER_PASSWORD || 'PlaywrightTest!2026',
  businessName: process.env.FF_BUSINESS_NAME || 'Playwright Test Stall',
  businessId: process.env.FF_BUSINESS_ID || '00000000-0000-0000-0000-000000000000',
};

/**
 * Logs in via the dashboard's email-password form and waits for the
 * overview page to settle (current-plan card visible). Idempotent — if
 * already logged in (session cookie kept), just navigates home.
 */
export async function loginAsOwner(page: Page) {
  // Fast path: if storageState pre-populated localStorage with a valid
  // token, just navigate to / and we're in. This avoids burning the
  // backend's 30/min /auth/login rate limit on tests that don't need a
  // fresh login (the storageState pattern is the WHOLE point of setup).
  await page.goto('/');
  // Give the app a beat to do its async session check and (maybe) redirect
  // to /login. If after that we're NOT on /login, we're logged in already.
  await page.waitForURL(/\/login$/, { timeout: 1500 }).catch(() => { /* already in */ });

  if (page.url().includes('/login')) {
    // Slow path: actually log in (no storageState, or it expired). Wait
    // for the form to be present — the dashboard renders the inputs
    // synchronously but the Label doesn't tie via htmlFor, so use the
    // input's type attribute.
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 5_000 });
    await emailInput.fill(ENV.email);
    await page.locator('input[type="password"]').fill(ENV.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
  }
  await expect(page).toHaveURL(new RegExp(`^${ENV.baseUrl}/?$`), { timeout: 15_000 });
}

/**
 * Direct REST call against the running backend using the owner JWT
 * from localStorage. Useful for arranging state quickly (e.g. seed
 * an expense before testing the expense register).
 */
export async function apiAs(page: Page, path: string, init: RequestInit = {}) {
  const token = await page.evaluate(() => localStorage.getItem('ff_dash_token'));
  const url = `${ENV.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * Resolve the active business ID for whoever is logged in. Reads it out of
 * localStorage (`ff_dash_business` is populated by the login flow), so the
 * test owner's actual business is used rather than a stale hardcoded UUID.
 * Falls back to ENV.businessId if the cache hasn't populated yet.
 */
export async function getBusinessId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('ff_dash_business');
      if (!raw) return null;
      const biz = JSON.parse(raw);
      return biz?.id || null;
    } catch (_) { return null; }
  });
  return id || ENV.businessId;
}

/** Build an ISO YYYY-MM-DD for today and the first of this month. */
export function dateRange() {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(first), endDate: iso(today) };
}
