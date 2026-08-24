// Helpers for the super-admin (namastepos_admin) e2e specs.
//
// Like _helpers.ts, this file does NOT spawn the admin dev server — it
// assumes you've started it on FF_ADMIN_URL (default localhost:5173).

import { expect, Page } from '@playwright/test';

// Hardcode-audit fix (2026-08-24): NO credential fallbacks. The previous
// password default was a real super-admin credential committed to the
// repo (and it forced a rotation). Set FF_ADMIN_EMAIL / FF_ADMIN_PASSWORD
// in your shell or .env before running the admin specs.
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set to run the admin e2e specs (no hardcoded fallback).`);
  return v;
}

export const ADMIN = {
  baseUrl:  process.env.FF_ADMIN_URL || 'http://localhost:5173',
  apiUrl:   process.env.FF_API_URL   || 'http://localhost:4000/v1',
  get email()    { return requiredEnv('FF_ADMIN_EMAIL'); },
  get password() { return requiredEnv('FF_ADMIN_PASSWORD'); },
};

/**
 * Sign into the super-admin dashboard with email+password. Idempotent —
 * if a token is already in localStorage it just navigates home.
 */
export async function loginAsSuperAdmin(page: Page) {
  await page.goto(ADMIN.baseUrl + '/');
  if (page.url().includes('/login')) {
    await page.getByLabel(/email/i).fill(ADMIN.email);
    await page.getByLabel(/password/i).fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
  }
  // Land on /customers (default route after login) or root.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** Read the admin JWT out of localStorage. Useful for direct API calls. */
export async function adminToken(page: Page): Promise<string | null> {
  return await page.evaluate(() => localStorage.getItem('ff_admin_token'));
}
