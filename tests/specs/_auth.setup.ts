// Playwright "setup project" — runs ONCE before each spec suite and saves
// the logged-in browser context to disk. Every spec then loads that
// storageState instead of doing a fresh login. Without this, the backend's
// per-IP login rate limits (20/min on /admin/login, 30/min on /auth/login)
// would trip mid-suite and stall the rest on /login.

import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { ADMIN } from './_admin_helpers';
import { ENV as OWNER } from './_helpers';

export const adminAuthFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
export const ownerAuthFile = path.resolve(__dirname, '..', '.auth', 'owner.json');

setup.describe.configure({ mode: 'serial' });

setup('admin login → storageState', async ({ page }) => {
  fs.mkdirSync(path.dirname(adminAuthFile), { recursive: true });

  await page.goto(ADMIN.baseUrl + '/login');
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  await page.context().storageState({ path: adminAuthFile });
});

setup('owner login → storageState', async ({ page, request }) => {
  fs.mkdirSync(path.dirname(ownerAuthFile), { recursive: true });

  // Step 1: Make sure the test owner EXISTS on the backend. We don't tie tests
  // to any real account — Playwright owns its own fixture user. First try to
  // log in via the API; if that 401s, register the user via /auth/register.
  // If the user exists with the WRONG password (someone reset it manually),
  // we fail loudly so it's obvious from the test output.
  let bootstrap = await request.post(`${OWNER.apiUrl}/auth/login`, {
    data: { email: OWNER.email, password: OWNER.password },
    failOnStatusCode: false,
  });

  if (bootstrap.status() === 401) {
    // Try to register
    const reg = await request.post(`${OWNER.apiUrl}/auth/register`, {
      data: {
        email: OWNER.email,
        password: OWNER.password,
        name: 'Playwright Owner',
        businessName: OWNER.businessName,
      },
      failOnStatusCode: false,
    });
    if (reg.status() === 201 || reg.status() === 200) {
      bootstrap = reg;
    } else if (reg.status() === 409) {
      throw new Error(
        `Playwright test owner exists but the password in _helpers.ts no longer matches. `
        + `Either reset the password for ${OWNER.email} in the DB, or change FF_OWNER_PASSWORD.`,
      );
    } else {
      throw new Error(`Could not provision Playwright test owner: register returned ${reg.status()} ${await reg.text()}`);
    }
  } else if (bootstrap.status() !== 200) {
    throw new Error(`Unexpected status from /auth/login during setup: ${bootstrap.status()} ${await bootstrap.text()}`);
  }

  // Step 2: Seed minimal fixture data on the test business so the page tests
  // have something to render against. Best-effort: any 4xx is ignored. We
  // pull the token + businessId out of the login/register payload.
  const payload = await bootstrap.json().catch(() => ({} as any));
  const token = payload.token;
  const businessId = payload.business?.id;
  if (token && businessId) {
    const authHeader = { Authorization: `Bearer ${token}` };
    // Add a couple of menu items so /menu has rows + the POS flow can pick one.
    await request.post(`${OWNER.apiUrl}/businesses/${businessId}/menu`, {
      data: { name: 'Test Idli', price: 50, stock: 100, isVeg: true },
      headers: authHeader, failOnStatusCode: false,
    });
    await request.post(`${OWNER.apiUrl}/businesses/${businessId}/menu`, {
      data: { name: 'Test Chai', price: 20, stock: 200, isVeg: true },
      headers: authHeader, failOnStatusCode: false,
    });
    // Add a table so /tables and /qr-codes have something to render.
    await request.post(`${OWNER.apiUrl}/businesses/${businessId}/ops/tables`, {
      data: { label: 'T1', capacity: 4 },
      headers: authHeader, failOnStatusCode: false,
    });
    // Add a customer for the /customers CRM page.
    await request.post(`${OWNER.apiUrl}/businesses/${businessId}/customers`, {
      data: { name: 'Test Customer', phone: '9000000000' },
      headers: authHeader, failOnStatusCode: false,
    });
    // Add an expense so registers / P&L have at least one row.
    await request.post(`${OWNER.apiUrl}/businesses/${businessId}/expenses`, {
      data: { category: 'rent', amount: 5000, note: 'Test expense' },
      headers: authHeader, failOnStatusCode: false,
    });
  }

  // Step 3: With creds verified server-side, do the UI login + storageState
  // save so the rest of the suite is pre-authenticated.
  await page.goto(OWNER.baseUrl + '/login');
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ state: 'visible', timeout: 5_000 });
  await emailInput.fill(OWNER.email);
  await page.locator('input[type="password"]').fill(OWNER.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(new RegExp(`^${OWNER.baseUrl}/?$`), { timeout: 15_000 });

  await page.context().storageState({ path: ownerAuthFile });
});
